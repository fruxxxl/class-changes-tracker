import { ChangesTracker, TChange } from '../src/changes-tracker';
import { cloneDeep, isEqual } from 'lodash';

// --- Test Helper Types ---
interface IAddress {
  street: string;
  city: string;
  zip: string;
  details?: {
    floor?: number;
    notes?: string;
    history?: { date: Date; event: string }[];
  };
  country?: string;
}

// --- New Custom Classes for Testing ---
/** Represents a custom ID class */
class CustomId {
  constructor(public id: string) {}
  // Add an equals method for meaningful comparison if needed by tests
  equals(other: any): boolean {
    return other instanceof CustomId && other.id === this.id;
  }
  toString(): string {
    return `CustomId(${this.id})`;
  }
}

/** Represents a more complex data structure class */
class ComplexData {
    constructor(
        public name: string,
        public value: number,
        public nestedId?: CustomId
    ) {}
     equals(other: any): boolean {
        return other instanceof ComplexData &&
               other.name === this.name &&
               other.value === this.value &&
               isEqual(other.nestedId, this.nestedId); // Use isEqual for nested
    }
}

interface IUser {
  id: number;
  name: string;
  email?: string;
  address: IAddress;
  tags: string[];
  metadata: {
    createdAt: Date;
    updatedAt?: Date | null;
    // Replace ObjectId with CustomId
    customId?: CustomId;
    misc?: any;
    // Add ComplexData
    complex?: ComplexData;
  };
  roles?: { id: number; name: string }[];
}

// --- Custom Predicate for Tests ---
// Checks for instances of our custom classes
const isCustomValueType = (value: any): boolean => {
  return value instanceof CustomId || value instanceof ComplexData;
};

// --- Tests ---

describe('ChangesTracker (Snapshot with Depth Limit & Aggregation)', () => {
  let tracker: ChangesTracker;
  let user: IUser;
  let originalUser: IUser;

  beforeEach(() => {
    // Use the new predicate
    tracker = new ChangesTracker({ treatAsValue: isCustomValueType });
    const testCustomId = new CustomId('abc-123');
    const testComplexData = new ComplexData('TestData', 42, new CustomId('nested-456'));

    user = {
      id: 1,
      name: 'John Doe',
      address: {
        street: '123 Main St',
        city: 'Anytown',
        zip: '12345',
        details: {
          floor: 5,
          notes: 'Initial notes',
          history: [{ date: new Date(2023, 0, 1), event: 'Created' }],
        },
      },
      tags: ['customer', 'active'],
      metadata: {
        createdAt: new Date(2023, 0, 1),
        updatedAt: null,
        // Use CustomId
        customId: testCustomId,
        misc: { a: 1, b: { c: 2 } },
        // Use ComplexData
        complex: testComplexData,
      },
      roles: [
        { id: 10, name: 'Admin' },
        { id: 20, name: 'User' },
      ],
    };
    originalUser = cloneDeep(user);
  });

  // --- Basic Change Tests ---

  test('should detect simple property update', () => {
    tracker.startTrack(user, 'name');
    user.name = 'Jane Doe';

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'name',
      oldValue: 'John Doe',
      newValue: 'Jane Doe',
    });
  });

  test('should detect top-level property added', () => {
    delete user.email;
    tracker.startTrack(user, 'email');
    user.email = 'jane.doe@example.com';

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'email',
      oldValue: undefined,
      newValue: 'jane.doe@example.com',
    });
  });

  test('should detect top-level property deleted', () => {
    user.email = 'test@example.com';
    tracker.startTrack(user, 'email');
    delete user.email;

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'email',
      oldValue: 'test@example.com',
      newValue: undefined,
    });
  });


  // --- Depth (maxDepth) Tests ---

  test('should detect nested update within default maxDepth (3)', () => {
    tracker.startTrack(user, 'address'); // maxDepth = 3
    user.address.details!.notes = 'Updated notes'; // Depth 2 < 3

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    // Expect exact path
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'address.details.notes',
      oldValue: 'Initial notes',
      newValue: 'Updated notes',
    });
  });

  test('should detect nested update exceeding default maxDepth (3)', () => {
    tracker.startTrack(user, 'metadata'); // maxDepth = 3
    user.metadata.misc.b.c = 999; // Depth 3 >= 3

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    // Expect path AT maxDepth where recursion stopped
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'metadata.misc.b.c', // Path at maxDepth
      oldValue: 2,
      newValue: 999,
    });
  });

  test('should detect nested update with custom maxDepth (1)', () => {
    tracker.startTrack(user, 'address', 1); // maxDepth = 1
    user.address.city = 'New City'; // Depth 1 >= 1

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    // Expect aggregation at maxDepth (depth 1)
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'address.city', // Aggregated path at maxDepth
      oldValue: 'Anytown',
      newValue: 'New City',
    });
  });

  test('should detect nested update with custom maxDepth (4)', () => {
    tracker.startTrack(user, 'metadata', 4); // maxDepth = 4
    user.metadata.misc.b.c = 999; // Depth 3 < 4

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    // Expect exact path
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'metadata.misc.b.c',
      oldValue: 2,
      newValue: 999,
    });
  });

  // --- Array Tests ---

  test('should detect array push as parent update (structural)', () => {
    tracker.startTrack(user, 'tags'); // maxDepth = 3
    user.tags.push('new-tag'); // Structural change

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    // Expect aggregation at array level due to structural change
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'tags',
    });
    expect(changes[0].oldValue).toEqual(originalUser.tags);
    expect(changes[0].newValue).toEqual(user.tags);
    expect(changes[0].newValue).toContain('new-tag');
  });

  test('should detect array pop as parent update (structural)', () => {
    tracker.startTrack(user, 'tags'); // maxDepth = 3
    const popped = user.tags.pop(); // Structural change

    expect(popped).toBe('active');
    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    // Expect aggregation at array level due to structural change
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'tags',
    });
    expect(changes[0].oldValue).toEqual(originalUser.tags);
    expect(changes[0].newValue).toEqual(user.tags);
    expect(changes[0].newValue).not.toContain('active');
  });

  test('should detect array splice (remove) as parent update (structural)', () => {
    tracker.startTrack(user, 'tags'); // maxDepth = 3
    const removed = user.tags.splice(0, 1); // Structural change

    expect(removed).toEqual(['customer']);
    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    // Expect aggregation at array level due to structural change
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'tags',
    });
    expect(changes[0].oldValue).toEqual(originalUser.tags);
    expect(changes[0].newValue).toEqual(user.tags);
    expect(changes[0].newValue).toEqual(['active']);
  });

  test('should detect array splice (add) as parent update (structural)', () => {
    tracker.startTrack(user, 'tags'); // maxDepth = 3
    user.tags.splice(1, 0, 'priority'); // Structural change

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    // Expect aggregation at array level due to structural change
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'tags',
    });
    expect(changes[0].oldValue).toEqual(originalUser.tags);
    expect(changes[0].newValue).toEqual(user.tags);
    expect(changes[0].newValue).toEqual(['customer', 'priority', 'active']);
  });

  test('should detect update within array object respecting maxDepth', () => {
    tracker.startTrack(user, 'roles', 1); // maxDepth = 1
    user.roles![0].name = 'Super Admin'; // Depth 2 > 1

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    // Expect aggregation at maxDepth (depth 1)
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'roles[0]', // Aggregated path at maxDepth
    });
    // Compare objects at this level
    expect(changes[0].oldValue).toEqual(originalUser.roles![0]);
    expect(changes[0].newValue).toEqual(user.roles![0]);
    expect(changes[0].newValue?.name).toBe('Super Admin');
  });

  test('should detect update within array object below maxDepth', () => {
    tracker.startTrack(user, 'roles', 3); // maxDepth = 3
    user.roles![0].name = 'Super Admin'; // Depth 2 < 3

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    // Expect exact path
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'roles[0].name',
      oldValue: 'Admin',
      newValue: 'Super Admin',
    });
  });

  // --- Object Tests ---

  test('should detect object property added as parent update (structural)', () => {
    tracker.startTrack(user, 'address'); // maxDepth = 3
    user.address.country = 'USA'; // Structural change

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    // Expect aggregation at object level due to structural change
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'address',
    });
    expect(changes[0].oldValue).toEqual(originalUser.address);
    expect(changes[0].newValue).toEqual(user.address);
    expect(changes[0].newValue?.country).toBe('USA');
  });

  test('should detect object property removed as parent update (structural)', () => {
    tracker.startTrack(user, 'address'); // maxDepth = 3
    delete user.address.details; // Structural change

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    // Expect aggregation at object level due to structural change
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'address',
    });
    expect(changes[0].oldValue).toEqual(originalUser.address);
    expect(changes[0].newValue).toEqual(user.address);
    expect(changes[0].newValue?.details).toBeUndefined();
  });

  test('should detect object replaced entirely', () => {
    tracker.startTrack(user, 'address');
    const newAddress = { street: '456 Second St', city: 'Othertown', zip: '54321' };
    user.address = newAddress; // Replace object reference

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    // Expect a single change for the entire object.
    // Even without explicit reference check, isEqual(old, new) returns false,
    // and the subsequent key comparison detects differences, leading to aggregation.
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'address', // Expect aggregation at the object level
      oldValue: originalUser.address,
      newValue: newAddress,
    });
  });

  // --- Special Type Tests ---

  test('should detect Date update', () => {
    tracker.startTrack(user, 'metadata'); // maxDepth = 3
    const newDate = new Date(2024, 5, 15);
    user.metadata.updatedAt = newDate; // Depth 1 < 3

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    // Expect exact path
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'metadata.updatedAt',
      oldValue: null,
      newValue: newDate,
    });
  });

  test('should detect CustomId update', () => {
    tracker.startTrack(user, 'metadata'); // maxDepth = 3
    const newCustomId = new CustomId('xyz-789');
    user.metadata.customId = newCustomId; // Depth 1 < 3

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    // Expect exact path because CustomId is treated as a value
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'metadata.customId',
    });
    // Compare using the class's equals method or direct comparison
    expect(changes[0].oldValue).toBeInstanceOf(CustomId);
    expect(changes[0].newValue).toBeInstanceOf(CustomId);
    expect((changes[0].oldValue as CustomId).equals(originalUser.metadata.customId!)).toBe(true);
    expect((changes[0].newValue as CustomId).equals(newCustomId)).toBe(true);
    expect((changes[0].oldValue as CustomId).equals(changes[0].newValue as CustomId)).toBe(false);
  });

  test('should detect ComplexData update', () => {
    tracker.startTrack(user, 'metadata'); // maxDepth = 3
    const newComplexData = new ComplexData('NewData', 99, new CustomId('new-nested-111'));
    user.metadata.complex = newComplexData; // Depth 1 < 3

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    // Expect exact path because ComplexData is treated as a value
    expect(changes[0]).toMatchObject<Partial<TChange>>({
      path: 'metadata.complex',
    });
    expect(changes[0].oldValue).toBeInstanceOf(ComplexData);
    expect(changes[0].newValue).toBeInstanceOf(ComplexData);
    expect((changes[0].oldValue as ComplexData).equals(originalUser.metadata.complex!)).toBe(true);
    expect((changes[0].newValue as ComplexData).equals(newComplexData)).toBe(true);
    expect((changes[0].oldValue as ComplexData).equals(changes[0].newValue as ComplexData)).toBe(false);
  });

  // --- Tracking Control Tests ---

  test('should not detect changes after stopTrack', () => {
    tracker.startTrack(user, 'name');
    tracker.stopTrack(user, 'name');
    user.name = 'Stopped Tracking';

    const changes = tracker.peekChanges();
    expect(changes).toHaveLength(0);
  });

   test('should not detect changes after stopAllTracks', () => {
    tracker.startTrack(user, 'name');
    tracker.startTrack(user, 'tags');
    tracker.stopAllTracks();
    user.name = 'Stopped All';
    user.tags.push('stopped');

    const changes = tracker.peekChanges();
    expect(changes).toHaveLength(0);
  });

  test('should handle tracking multiple properties', () => {
    tracker.startTrack(user, 'name');
    tracker.startTrack(user, 'address', 1); // maxDepth = 1

    user.name = 'Multi Change';
    user.address.city = 'Multi City'; // Depth 1 >= 1

    const changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(2);

    const nameChange = changes.find(c => c.path === 'name');
    const addressChange = changes.find(c => c.path === 'address.city'); // Expect path at maxDepth

    expect(nameChange).toMatchObject<Partial<TChange>>({
      path: 'name',
      oldValue: 'John Doe',
      newValue: 'Multi Change',
    });

    expect(addressChange).toMatchObject<Partial<TChange>>({
      path: 'address.city', // Aggregated at maxDepth
      oldValue: 'Anytown',
      newValue: 'Multi City',
    });
  });

   test('should update maxDepth if startTrack is called again', () => {
    tracker.startTrack(user, 'address', 1); // maxDepth = 1
    user.address.city = 'City Change 1'; // Depth 1 >= 1

    let changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('address.city'); // Aggregated at maxDepth

    // Call again with greater depth
    tracker.startTrack(user, 'address', 3); // maxDepth = 3
    user.address.details!.notes = 'Notes Change'; // Depth 2 < 3

    changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    // Now the change should be at the 'notes' level due to the new maxDepth
    expect(changes[0].path).toBe('address.details.notes');
    // The snapshot for 'address' was updated after the first check,
    // so the oldValue for 'notes' will be 'Initial notes'
    expect(changes[0].oldValue).toBe('Initial notes');
    expect(changes[0].newValue).toBe('Notes Change');
  });

   test('should return no changes if nothing changed', () => {
    tracker.startTrack(user, 'name');
    tracker.startTrack(user, 'address');
    const changes = tracker.peekChanges();
    expect(changes).toHaveLength(0);
  });

   test('peekChanges should return changes without updating snapshot', () => {
    tracker.startTrack(user, 'name');
    user.name = 'Peek Change';

    // First peek
    let changes = tracker.peekChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject<Partial<TChange>>({
        path: 'name',
        oldValue: 'John Doe', // Original snapshot
        newValue: 'Peek Change',
    });

    // Change again
    user.name = 'Peek Change 2';

    // Second peek - should still compare against original snapshot
    changes = tracker.peekChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject<Partial<TChange>>({
        path: 'name',
        oldValue: 'John Doe', // Still original snapshot
        newValue: 'Peek Change 2',
    });
  });

  test('updateSnapshots should update the baseline', () => {
    tracker.startTrack(user, 'name');
    user.name = 'Update Baseline';

    // Peek shows the change
    let changes = tracker.peekChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].oldValue).toBe('John Doe');

    // Update the snapshots
    tracker.updateSnapshots();

    // Now peek should show no changes, as baseline matches current value
    changes = tracker.peekChanges();
    expect(changes).toHaveLength(0);

    // Make another change
    user.name = 'After Update';
    changes = tracker.peekChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject<Partial<TChange>>({
        path: 'name',
        oldValue: 'Update Baseline', // Old value is now the updated baseline
        newValue: 'After Update',
    });
  });

   test('should return changes again after first check and snapshot update', () => {
    tracker.startTrack(user, 'name');
    user.name = 'First Change';

    let changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    expect(changes[0].newValue).toBe('First Change');

    // Snapshot has been updated
    user.name = 'Second Change';
    changes = tracker.peekChanges();
    tracker.updateSnapshots();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject<Partial<TChange>>({
        path: 'name',
        oldValue: 'First Change', // Old value is now 'First Change' because snapshot was updated
        newValue: 'Second Change',
    });
  });

  // --- Test Suite for Behavior WITHOUT Custom Predicate ---
  describe('ChangesTracker without custom value types', () => {
    let trackerWithoutPredicate: ChangesTracker;
    let userForTest: IUser;
    let originalUserForTest: IUser; // Keep original for comparison

    beforeEach(() => {
      // Instantiate tracker WITHOUT the custom type checker
      trackerWithoutPredicate = new ChangesTracker();

      const testCustomId = new CustomId('test-id-1');
      const testComplexData = new ComplexData('CompData', 10);
      userForTest = {
        id: 2,
        name: 'Test User',
        address: { street: '456 Side St', city: 'Othertown', zip: '67890' },
        tags: ['test'],
        metadata: {
          createdAt: new Date(),
          customId: testCustomId,
          complex: testComplexData,
        },
      };
      originalUserForTest = cloneDeep(userForTest);
    });

    // Adjust expectations: When not treated as value, recursion should happen.
    test('should recurse into CustomId when no treatAsValue predicate is provided', () => {
      trackerWithoutPredicate.startTrack(userForTest, 'metadata'); // Default maxDepth = 3

      const newCustomId = new CustomId('test-id-2');
      userForTest.metadata.customId = newCustomId;

      const changes = trackerWithoutPredicate.peekChanges();
      trackerWithoutPredicate.updateSnapshots();

      // Expect the change path to go *inside* CustomId because it's treated like a regular object.
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject<Partial<TChange>>({
        path: 'metadata.customId.id', // Path goes inside the object
        oldValue: 'test-id-1',
        newValue: 'test-id-2',
      });
    });

     // Adjust expectations: When not treated as value, recursion should happen.
     test('should recurse into ComplexData when no treatAsValue predicate is provided', () => {
      trackerWithoutPredicate.startTrack(userForTest, 'metadata'); // Default maxDepth = 3

      const newComplexData = new ComplexData('CompDataNew', 20);
      userForTest.metadata.complex = newComplexData;

      const changes = trackerWithoutPredicate.peekChanges();
      trackerWithoutPredicate.updateSnapshots();

      // Expect multiple changes for the inner properties because it's treated like a regular object.
      expect(changes).toHaveLength(2); // name and value changed
      expect(changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining<Partial<TChange>>({
            path: 'metadata.complex.name',
            oldValue: 'CompData',
            newValue: 'CompDataNew',
          }),
          expect.objectContaining<Partial<TChange>>({
            path: 'metadata.complex.value',
            oldValue: 10,
            newValue: 20,
          }),
        ])
      );
    });

     // This test remains correct and verifies recursion when modifying internal property
     test('should recurse into ComplexData properties if treated as regular object', () => {
        trackerWithoutPredicate.startTrack(userForTest, 'metadata', 3); // maxDepth = 3
        // Modify a property *within* ComplexData AFTER initial setup
        userForTest.metadata.complex!.value = 100;

        const changes = trackerWithoutPredicate.peekChanges();
        trackerWithoutPredicate.updateSnapshots();

        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject<Partial<TChange>>({
            path: 'metadata.complex.value', // Path goes inside the object
            oldValue: 10, // The original value from beforeEach
            newValue: 100,
        });
    });
  });

}); 