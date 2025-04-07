import { cloneDeep, isEqual } from 'lodash';
import { z } from 'zod';

/**
 * Zod schema for describing a single change.
 */
const ChangeSchema = z.object({
  /** Full path to the changed property (e.g., 'user.address.street' or 'items[0].name') */
  path: z.string(),
  /** Previous value of the property (deep copy from the last snapshot) */
  oldValue: z.any().optional(),
  /** New value of the property (deep copy of the current value) */
  newValue: z.any().optional(),
});

/**
 * Type representing a single change detected by the tracker.
 * Contains the path, the value from the last snapshot (`oldValue`),
 * and the current value (`newValue`).
 */
export type TChange = z.infer<typeof ChangeSchema>;

/**
 * Internal interface for storing information about a tracked property.
 * @internal
 */
interface ITrackedPropertyInfo {
  /** Weak reference to the parent object */
  parentObjRef: WeakRef<object>;
  /** Name of the tracked property */
  property: string | symbol | number;
  /** Stored snapshot of the property's value (updated via `updateSnapshots`) */
  originalValueSnapshot: any;
  /** Maximum depth for change detection */
  maxDepth: number;
}

/**
 * Options for configuring the ChangesTracker.
 */
interface IChangesTrackerOptions {
  /**
   * A custom predicate function to identify types that should be treated as
   * atomic values. The tracker will not recurse into properties of these values;
   * instead, it will compare them directly using `lodash.isEqual`.
   * Useful for class instances like ObjectId, Moment, etc., where instance
   * equality is desired over deep property comparison.
   * Example: `(value) => value instanceof MyCustomClass || value?._bsontype === 'ObjectId'`
   * @param value - The value to check.
   * @returns `true` if the value should be treated as an atomic value, `false` otherwise.
   */
  treatAsValue?: (value: any) => boolean;
}

/**
 * Tracks property changes on objects using snapshots.
 *
 * Call `startTrack()` to begin monitoring a property. This stores an initial snapshot.
 * Call `peekChanges()` to compare the current property value against the stored snapshot
 * and get a list of detailed changes up to a specified `maxDepth`. This method does *not*
 * update the snapshot.
 * Call `updateSnapshots()` to update the internal snapshots to match the current state,
 * establishing a new baseline for future `peekChanges()` calls.
 * Structural changes (like adding/removing array elements or object keys) are typically
 * reported as a single, aggregated change on the parent structure.
 */
export class ChangesTracker {
  /** Map storing information about tracked properties. Key is a namespaced property identifier. */
  private trackedProperties: Map<string, ITrackedPropertyInfo> = new Map();
  /** Default maximum depth for detailing changes if not specified in `startTrack`. */
  private readonly defaultMaxDepth: number = 3;
  /** Custom predicate function to identify types treated as atomic values. */
  private readonly treatAsValue: (value: any) => boolean;

  /**
   * Creates an instance of ChangesTracker.
   * @param options - Optional configuration for the tracker.
   */
  constructor(options?: IChangesTrackerOptions) {
    // Store the custom predicate or a default function that always returns false.
    this.treatAsValue = options?.treatAsValue ?? (() => false);
  }

  /**
   * Checks if a value is a primitive, a standard Date, or a custom type
   * that should be treated as an atomic value (defined via constructor options).
   * These types are compared directly using `isEqual`.
   * @param value - The value to check.
   * @returns `true` if the value should be treated as atomic, `false` otherwise.
   * @private
   */
  private _isSpecialTypeOrPrimitive(value: any): boolean {
    if (value === null || typeof value !== 'object') return true; // Primitives are always treated as values
    if (value instanceof Date) return true; // Date is treated as a value by default

    // Check using the custom predicate provided in constructor options
    if (this.treatAsValue(value)) {
      return true;
    }

    // Other standard types like RegExp could be added here if needed universally.
    // if (value instanceof RegExp) return true;

    return false; // It's a regular object or array that needs recursion
  }

  /**
   * Starts tracking changes for a specific property on an object.
   *
   * Stores a deep snapshot of the property's current value. Subsequent calls to
   * `peekChanges()` will compare the live value against this snapshot until
   * `updateSnapshots()` is called.
   * If tracking is already active for the same object and property, it will be restarted
   * with the potentially new `maxDepth` and a fresh snapshot.
   *
   * @template T - The type of the object.
   * @template K - The key of the property within the object.
   * @param obj - The object whose property should be tracked.
   * @param property - The name of the property to track.
   * @param maxDepth - The maximum depth to report detailed changes. Defaults to `defaultMaxDepth`.
   *                   Changes deeper than this will be aggregated at the `maxDepth` level.
   * @returns The original value of the property (no proxy is involved).
   * @public
   */
  public startTrack<T extends object, K extends keyof T>(
    obj: T,
    property: K,
    maxDepth: number = this.defaultMaxDepth,
  ): T[K] {
    const propertyName = String(property);
    // Use a unique key including the constructor name to avoid collisions
    // for same-named properties on different object types.
    const propertyKey = `${obj.constructor.name}.${propertyName}`;
    const currentValue = obj[property];

    // If already tracking this exact object/property, remove the old entry first
    // to ensure the new maxDepth and snapshot are used.
    const existingInfo = this.trackedProperties.get(propertyKey);
    if (existingInfo?.parentObjRef.deref() === obj) {
        this.trackedProperties.delete(propertyKey);
    }
    // Handle cases where the key exists but the object is different (stale WeakRef cleared)
    else if (this.trackedProperties.has(propertyKey)) {
         this.trackedProperties.delete(propertyKey);
    }

    let originalValueSnapshot: any;
    try {
      // Always create a deep copy for the snapshot.
      originalValueSnapshot = cloneDeep(currentValue);
    } catch (error) {
      // Consider adding more robust error handling or logging if needed
      return currentValue; // Return original value; tracking won't start.
    }

    // Store tracking information.
    this.trackedProperties.set(propertyKey, {
      parentObjRef: new WeakRef(obj),
      property: property,
      originalValueSnapshot: originalValueSnapshot,
      maxDepth: maxDepth,
    });

    // Return the original value; no proxy is created.
    return currentValue;
  }

  /**
   * Compares the current values of tracked properties against their stored snapshots
   * and returns a list of detected changes WITHOUT updating the internal snapshots.
   * Use this method to see pending changes without altering the tracker's baseline.
   * Call `updateSnapshots()` to commit the current state as the new baseline.
   *
   * @returns An array of detected changes (`TChange[]`). Returns an empty array if no changes are found.
   * @public
   */
  public peekChanges(): TChange[] {
    const allChanges: TChange[] = [];

    for (const [propertyKey, trackedInfo] of this.trackedProperties.entries()) {
      const parentObj = trackedInfo.parentObjRef.deref();

      if (!parentObj) {
        this.trackedProperties.delete(propertyKey);
        continue;
      }

      const property = trackedInfo.property as keyof typeof parentObj;
      let currentValue: any;
      try {
        currentValue = parentObj[property];
      } catch (error) {
        continue; // Skip diffing if value cannot be accessed
      }

      const originalSnapshot = trackedInfo.originalValueSnapshot;

      // Check for changes using isEqual first as an optimization
      if (!isEqual(currentValue, originalSnapshot)) {
        // Call _diffValues with the original snapshot and the CURRENT value
        const propertyChanges = this._diffValues(
          originalSnapshot,
          currentValue, // Pass the current value, NOT a clone
          String(property), // Use property name as initial path
          trackedInfo.maxDepth,
          0, // Initial depth
        );
        allChanges.push(...propertyChanges);

        // Snapshot is NOT updated here in peekChanges
      }
    }
    return allChanges;
  }

  /**
   * Updates the internal snapshots of all tracked properties to their current values.
   * This establishes a new baseline for future `peekChanges()` calls.
   * @public
   */
  public updateSnapshots(): void {
    for (const [propertyKey, trackedInfo] of this.trackedProperties.entries()) {
      const parentObj = trackedInfo.parentObjRef.deref();

      if (!parentObj) {
        this.trackedProperties.delete(propertyKey);
        // Object is gone, no snapshot to update
        continue;
      }

      const property = trackedInfo.property as keyof typeof parentObj;
      let currentValue: any;
      try {
        currentValue = parentObj[property];
      } catch (error) {
        continue; // Skip update if value cannot be accessed
      }

      // Update the snapshot to the current value
      try {
        // Clone the current value for the new snapshot
        trackedInfo.originalValueSnapshot = cloneDeep(currentValue);
      } catch (cloneError) {
        // If cloning fails, remove tracking to avoid inconsistent state
        this.trackedProperties.delete(propertyKey);
      }
    }
  }

  /**
   * Recursively compares two values and returns an array of changes up to the specified depth.
   * Handles primitives, special types, arrays, and objects. Aggregates changes at maxDepth
   * or when structural differences (array length, object keys) are found.
   *
   * @param oldValue - The previous value (from the snapshot).
   * @param newValue - The current value (live value, needs cloning before returning in TChange).
   * @param currentPath - The dot-notation path to the current value being compared.
   * @param maxDepth - The maximum depth allowed for detailed change reporting.
   * @param currentDepth - The current recursion depth.
   * @returns An array of detected changes (`TChange[]`).
   * @private
   */
  private _diffValues(
    oldValue: any,
    newValue: any, // Note: This is the live value, needs cloning before returning in TChange
    currentPath: string,
    maxDepth: number,
    currentDepth: number,
  ): TChange[] {
    // --- Base Case 1: Max depth reached ---
    if (currentDepth >= maxDepth) {
      if (!isEqual(oldValue, newValue)) {
        return [
          {
            path: currentPath,
            oldValue: cloneDeep(oldValue),
            newValue: cloneDeep(newValue), // Clone newValue here
          },
        ];
      } else {
        return []; // No change at max depth
      }
    }

    // --- Base Case 2: Primitives or special types ---
    const isOldSpecial = this._isSpecialTypeOrPrimitive(oldValue);
    const isNewSpecial = this._isSpecialTypeOrPrimitive(newValue);
    if (isOldSpecial || isNewSpecial) {
      // If one is special/primitive and the other isn't, or both are but different
      if (!isEqual(oldValue, newValue)) {
        return [
          {
            path: currentPath,
            // Primitives/special types don't need cloning for the change object
            oldValue: oldValue,
            newValue: newValue,
          },
        ];
      } else {
        return []; // No change for primitives/special types
      }
    }

    // --- Recursive Step: Arrays ---
    if (Array.isArray(oldValue) && Array.isArray(newValue)) {
      // Aggregate change if array length differs (structural change)
      if (oldValue.length !== newValue.length) {
         return [
           {
             path: currentPath,
             oldValue: cloneDeep(oldValue),
             newValue: cloneDeep(newValue), // Clone newValue here
           },
         ];
      }

      // If length is the same, compare elements recursively
      const detailedChanges: TChange[] = [];
      for (let i = 0; i < oldValue.length; i++) { // Lengths are equal
        const itemPath = `${currentPath}[${i}]`;
        detailedChanges.push(
          ...this._diffValues(
            oldValue[i],
            newValue[i], // Pass non-cloned element
            itemPath,
            maxDepth,
            currentDepth + 1,
          ),
        );
      }
      return detailedChanges;
    }

    // --- Recursive Step: Objects ---
    // Note: null is handled by _isSpecialTypeOrPrimitive
    // Note: Types handled by treatAsValue are caught by _isSpecialTypeOrPrimitive earlier
    if (typeof oldValue === 'object' && typeof newValue === 'object') {

      // Check for structural differences (different keys) first.
      const oldKeys = Object.keys(oldValue);
      const newKeys = Object.keys(newValue);
      if (oldKeys.length !== newKeys.length || oldKeys.some(k => !newValue.hasOwnProperty(k))) {
         // Structural change detected, report aggregated change for the object.
         return [
           {
             path: currentPath,
             oldValue: cloneDeep(oldValue),
             newValue: cloneDeep(newValue),
           },
         ];
      }

      // If keys are the same, check if the objects themselves are considered equal by lodash.
      // This handles cases where internal properties might differ but the overall object
      // comparison (potentially using a custom .equals method recognized by lodash) yields equality.
      // However, we primarily rely on the peekChanges check, so this is more of a safeguard.
      // If isEqual is false, the difference must be nested since keys are the same.
      if (isEqual(oldValue, newValue)) {
          // Although keys are the same, lodash considers them deep equal. No changes needed.
          // This branch might be less likely if peekChanges already determined inequality,
          // but kept for logical completeness.
          return [];
      }

      // Keys are the same, and isEqual is false. Recurse to find nested differences.
      // We only reach here for objects not handled by _isSpecialTypeOrPrimitive.
      const detailedChanges: TChange[] = [];
      for (const key of oldKeys) { // Keys are the same
        const propPath = `${currentPath}.${key}`;
        detailedChanges.push(
          ...this._diffValues(
            oldValue[key],
            newValue[key], // Pass non-cloned property
            propPath,
            maxDepth,
            currentDepth + 1,
          ),
        );
      }
      // Filter out empty results from recursion branches where no change was found
      return detailedChanges.filter(change => change !== undefined);
    }

    // --- Base Case 3: Type mismatch or unexpected fallback ---
    // This case is reached if types are different (e.g., array vs object)
    // or other unexpected scenarios. Since peekChanges() already confirmed
    // !isEqual(originalSnapshot, currentValue), we report a change here.
    if (!isEqual(oldValue, newValue)) { // Final check for safety
       return [
         {
           path: currentPath,
           oldValue: cloneDeep(oldValue),
           newValue: cloneDeep(newValue), // Clone newValue here
         },
       ];
    } else {
       // Should theoretically not be reached if peekChanges check worked, but included for safety.
       return [];
    }
  }

  /**
   * Stops tracking changes for a specific property on an object.
   * Removes the snapshot and tracking information for the property.
   *
   * @template T - The type of the object.
   * @template K - The key of the property within the object.
   * @param obj - The object whose property should no longer be tracked.
   * @param property - The name of the property to stop tracking.
   * @public
   */
  public stopTrack<T extends object, K extends keyof T>(
    obj: T,
    property: K,
  ): void {
    const propertyName = String(property);
    const propertyKey = `${obj.constructor.name}.${propertyName}`;
    const trackedInfo = this.trackedProperties.get(propertyKey);

    // Delete only if the entry exists and belongs to the same object instance.
    if (trackedInfo && trackedInfo.parentObjRef.deref() === obj) {
      this.trackedProperties.delete(propertyKey);
    }
  }

  /**
   * Stops tracking changes for all properties currently being monitored.
   * Clears all stored snapshots and tracking information.
   * @public
   */
  public stopAllTracks(): void {
    this.trackedProperties.clear();
  }
}