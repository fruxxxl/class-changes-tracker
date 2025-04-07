# Class Changes Tracker

[![NPM Version](https://img.shields.io/npm/v/class-changes-tracker.svg)](https://www.npmjs.com/package/class-changes-tracker)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://github.com/fruxxxl/class-changes-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/fruxxxl/class-changes-tracker/actions/workflows/ci.yml)
<!-- coverage-badge-start -->
[![coverage](https://img.shields.io/badge/coverage-94%25-green)]() <!-- Updated coverage badge -->
<!-- coverage-badge-end -->
<!-- Add other badges if needed (e.g., build status, test coverage) -->

A lightweight TypeScript utility to track property changes in objects using snapshots, with configurable depth and custom type handling.

## Table of Contents

- [Class Changes Tracker](#class-changes-tracker)
  - [Table of Contents](#table-of-contents)
  - [Features](#features)
  - [Installation](#installation)
  - [Usage](#usage)
    - [Basic Tracking](#basic-tracking)
    - [Using `maxDepth`](#using-maxdepth)
    - [Handling Custom Types with `treatAsValue`](#handling-custom-types-with-treatasvalue)
    - [Stopping Tracking](#stopping-tracking)
  - [API Reference](#api-reference)
    - [`new ClassChangesTracker(options?)`](#new-changestrackeroptions)
    - [`startTrack(obj, property, maxDepth?)`](#starttrackobj-property-maxdepth)
    - [`peekChanges()`](#peekchanges)
    - [`updateSnapshots()`](#updatesnapshots)
    - [`stopTrack(obj, property)`](#stoptrackobj-property)
    - [`stopAllTracks()`](#stopalltracks)
  - [Contributing](#contributing)
  - [License](#license)

## Features

*   **Snapshot-Based Tracking:** Monitors changes on specific object properties against deep snapshots.
*   **Configurable Depth:** Control the level of detail in change reports using `maxDepth`.
*   **Custom Type Handling:** Define types (`treatAsValue`) that should be compared by value (e.g., `ObjectId`, `Date`, custom classes) instead of deep comparison.
*   **Detailed Change Reports:** Provides clear `TChange[]` reports including path, old value, and new value.
*   **Memory Efficient:** Uses `WeakRef` to avoid memory leaks by allowing tracked objects to be garbage collected.
*   **TypeScript Native:** Written entirely in TypeScript with included type definitions.

## Installation

```bash
npm install class-changes-tracker
```

or

```bash
yarn add class-changes-tracker
```

## Usage

### Basic Tracking

```typescript
import { ClassChangesTracker, type TChange } from 'class-changes-tracker';

// --- Setup ---
interface IAddress {
  street: string;
  city: string;
}
interface IUser {
  id: number;
  name: string;
  address: IAddress;
  tags: string[];
}

const tracker = new ClassChangesTracker();

const user: IUser = {
  id: 1,
  name: 'John Doe',
  address: { street: '123 Main St', city: 'Anytown' },
  tags: ['a', 'b'],
};

// 1. Start tracking properties
tracker.startTrack(user, 'name');
tracker.startTrack(user, 'address'); // Uses default maxDepth = 3
tracker.startTrack(user, 'tags');

// 2. Make some changes
user.name = 'Jane Doe';
user.address.city = 'New City';
user.tags.push('c'); // Structural change (length differs)

// 3. Check for changes (without updating the baseline snapshot)
let changes: TChange[] = tracker.peekChanges();
console.log('Initial Changes:', changes);
/*
Output includes:
[
  { path: 'name', oldValue: 'John Doe', newValue: 'Jane Doe' },
  { path: 'address.city', oldValue: 'Anytown', newValue: 'New City' },
  // Structural changes are reported at the parent level
  { path: 'tags', oldValue: [ 'a', 'b' ], newValue: [ 'a', 'b', 'c' ] }
]
*/

// 4. Update the baseline snapshots to the current state
tracker.updateSnapshots();

// 5. Make more changes
user.name = 'Jane Smith';
user.address.street = '456 Side St';

// 6. Check for changes again
changes = tracker.peekChanges();
console.log('Changes after snapshot update:', changes);
/*
Output includes:
[
  // Compares against the updated snapshot ('Jane Doe')
  { path: 'name', oldValue: 'Jane Doe', newValue: 'Jane Smith' },
  { path: 'address.street', oldValue: '123 Main St', newValue: '456 Side St' }
]
*/

// 7. Update snapshots again if needed for future checks
tracker.updateSnapshots();
```

### Using `maxDepth`

Control how deep the tracker looks for changes within an object. Changes below `maxDepth` are aggregated at the `maxDepth` level.

```typescript
import { ClassChangesTracker, type TChange } from 'class-changes-tracker';

const depthTracker = new ClassChangesTracker();
const deepUser = { data: { level1: { level2: { level3: 'value' } } } };

// Start tracking 'data' with maxDepth = 2
depthTracker.startTrack(deepUser, 'data', 2);

// Modify a property at depth 3 (level1 -> level2 -> level3)
deepUser.data.level1.level2.level3 = 'new value';

const changes: TChange[] = depthTracker.peekChanges();
console.log('Depth Changes:', changes);
/*
Output:
[
  // Change is reported at the maxDepth level (path: 'data.level1.level2')
  {
    path: 'data.level1.level2',
    oldValue: { level3: 'value' },
    newValue: { level3: 'new value' }
  }
]
*/
```

### Handling Custom Types with `treatAsValue`

Prevent the tracker from recursing into specific object types (like class instances) and compare them by value instead.

```typescript
import { ClassChangesTracker, type TChange } from 'class-changes-tracker';

// Example custom class
class CustomId {
  constructor(public id: string) {}
  equals(other: any): boolean { // Optional: helps lodash.isEqual
    return other instanceof CustomId && other.id === this.id;
  }
}

// Configure tracker to treat CustomId as an atomic value
const customTypeTracker = new ClassChangesTracker({
  treatAsValue: (value) => value instanceof CustomId,
});

const userWithCustomId = {
  id: 2,
  customId: new CustomId('id-001'),
};

customTypeTracker.startTrack(userWithCustomId, 'customId');

// Replace the CustomId instance entirely
userWithCustomId.customId = new CustomId('id-002');

const changes: TChange[] = customTypeTracker.peekChanges();
console.log('Custom Type Changes:', changes);
/*
Output:
[
  // Change reported directly on 'customId', not its internal 'id' property,
  // because CustomId is treated as a value.
  {
    path: 'customId',
    oldValue: CustomId { id: 'id-001' },
    newValue: CustomId { id: 'id-002' }
  }
]
*/
```

### Stopping Tracking

You can stop tracking individual properties or all properties managed by a tracker instance.

```typescript
import { ClassChangesTracker } from 'class-changes-tracker';

const tracker = new ClassChangesTracker();
const user = { name: 'Temp User', id: 99 };

tracker.startTrack(user, 'name');
tracker.startTrack(user, 'id');

// Stop tracking only 'name'
tracker.stopTrack(user, 'name');
user.name = 'Final Name'; // This change won't be detected by peekChanges()

// Stop tracking everything
tracker.stopAllTracks();
user.id = 100; // This change won't be detected either

const changes = tracker.peekChanges();
console.log('Changes after stopping:', changes); // Output: []
```

## API Reference

### `new ClassChangesTracker(options?)`

Creates a new `ClassChangesTracker` instance.

*   **`options`** (optional): `object`
    *   **`treatAsValue`**: `(value: any) => boolean` (optional) - A predicate function. If it returns `true` for a given value, the tracker will compare that value using `lodash.isEqual` instead of recursing into its properties. Defaults to only treating primitives and `Date` instances this way.

### `startTrack(obj, property, maxDepth?)`

Starts tracking a specific property on an object. Stores a deep snapshot of the property's current value. If tracking is already active for the same object and property, it restarts with the new `maxDepth` and a fresh snapshot.

*   **`obj`**: `object` - The object whose property should be tracked.
*   **`property`**: `string | symbol | number` - The name (key) of the property to track.
*   **`maxDepth`**: `number` (optional) - The maximum depth for detailed change detection within this property. Defaults to `3`.
*   **Returns**: `any` - The original value of the property being tracked.

### `peekChanges()`

Compares the current values of all tracked properties against their stored snapshots. Does **not** update the snapshots.

*   **Returns**: `TChange[]` - An array of detected changes. An empty array `[]` means no changes were found relative to the last snapshot.
    *   `TChange`: `{ path: string; oldValue?: any; newValue?: any; }`

### `updateSnapshots()`

Updates the internal snapshots for **all** tracked properties to match their current values in the tracked objects. This establishes a new baseline for future `peekChanges()` calls.

*   **Returns**: `void`

### `stopTrack(obj, property)`

Stops tracking changes for a specific property on a specific object.

*   **`obj`**: `object` - The object whose property should no longer be tracked.
*   **`property`**: `string | symbol | number` - The name (key) of the property to stop tracking.
*   **Returns**: `void`

### `stopAllTracks()`

Stops tracking changes for all properties currently being monitored by this `ClassChangesTracker` instance. Clears all stored snapshots and tracking information.

*   **Returns**: `void`

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests. See the [Contributing Guide](CONTRIBUTING.md) (if you create one) for more details.

## License

Distributed under the MIT License. See `LICENSE` file for more information.