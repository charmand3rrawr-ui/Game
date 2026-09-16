/**
 * store.test.ts — the atomicity contract the whole engine leans on
 *
 * `transaction()` must be all-or-nothing: spec/02 requires that a build
 * completing and the next queue item starting cannot half-happen. Every handler
 * in the engine is written assuming that, so these tests pin the guarantee
 * rather than the implementation — they passed against the original
 * snapshot-and-rollback store and must keep passing against the undo journal
 * that replaced it.
 */

import { describe, it, expect } from 'vitest';
import { MemoryStore } from './store/memory.js';
import type { Settlement, Stockpile } from '@ascendance/shared';

const settlement = (id: string, name: string): Settlement => ({
  id, shardId: 's', worldId: 'w', ownerId: 'p', name,
  holdingType: 'village', layer: 'surface', coordX: 0, coordY: 0,
  population: 10, happiness: 50, loyalty: 100, integrity: 100,
  spiritVeins: 0, foundedAt: 0n,
} as Settlement);

const stock = (settlementId: string, key: string, amount: bigint): Stockpile => ({
  settlementId, resourceKey: key, amount, capacity: 1000n, lastAccruedAt: 0n,
} as Stockpile);

describe('transaction atomicity', () => {
  it('leaves no trace of a transaction that throws', () => {
    const store = new MemoryStore();
    store.transaction((tx) => { tx.settlements.put(settlement('a', 'Before')); });

    expect(() => store.transaction((tx) => {
      tx.settlements.put(settlement('a', 'Changed'));
      tx.settlements.put(settlement('b', 'Added'));
      throw new Error('poisoned');
    })).toThrow('poisoned');

    // The edit is reverted and the insert is gone.
    expect(store.read((tx) => tx.settlements.require('a').name)).toBe('Before');
    expect(store.read((tx) => tx.settlements.get('b'))).toBeUndefined();
  });

  it('restores a row that was deleted and re-added within the failed attempt', () => {
    // Repeated writes to one row are the case an undo journal has to get right:
    // replaying backwards must land on the value held when the transaction
    // opened, not on some intermediate one.
    const store = new MemoryStore();
    store.transaction((tx) => { tx.settlements.put(settlement('a', 'Original')); });

    expect(() => store.transaction((tx) => {
      tx.settlements.put(settlement('a', 'First'));
      tx.settlements.delete('a');
      tx.settlements.put(settlement('a', 'Second'));
      tx.settlements.put(settlement('a', 'Third'));
      throw new Error('nope');
    })).toThrow();

    expect(store.read((tx) => tx.settlements.require('a').name)).toBe('Original');
    expect(store.read((tx) => tx.settlements.count())).toBe(1);
  });

  it('rolls back composite-keyed rows too', () => {
    const store = new MemoryStore();
    store.transaction((tx) => { tx.stockpiles.put(stock('a', 'grain', 100n)); });

    expect(() => store.transaction((tx) => {
      tx.stockpiles.put(stock('a', 'grain', 0n));
      tx.stockpiles.put(stock('a', 'timber', 50n));
      throw new Error('nope');
    })).toThrow();

    expect(store.read((tx) => tx.stockpiles.get('a', 'grain')!.amount)).toBe(100n);
    expect(store.read((tx) => tx.stockpiles.get('a', 'timber'))).toBeUndefined();
  });

  it('keeps everything when the transaction succeeds', () => {
    const store = new MemoryStore();
    store.transaction((tx) => {
      tx.settlements.put(settlement('a', 'Kept'));
      tx.stockpiles.put(stock('a', 'grain', 7n));
    });
    expect(store.read((tx) => tx.settlements.require('a').name)).toBe('Kept');
    expect(store.read((tx) => tx.stockpiles.get('a', 'grain')!.amount)).toBe(7n);
  });

  it('unwinds the whole thing when an inner transaction fails', () => {
    // Nested calls join the outer transaction rather than opening a second one,
    // so a failure inside a nested call must discard the outer work as well.
    const store = new MemoryStore();
    store.transaction((tx) => { tx.settlements.put(settlement('a', 'Before')); });

    expect(() => store.transaction((tx) => {
      tx.settlements.put(settlement('a', 'Outer'));
      store.transaction((inner) => {
        inner.settlements.put(settlement('b', 'Inner'));
        throw new Error('inner failed');
      });
    })).toThrow('inner failed');

    expect(store.read((tx) => tx.settlements.require('a').name)).toBe('Before');
    expect(store.read((tx) => tx.settlements.get('b'))).toBeUndefined();
  });

  it('does not record a command whose transaction rolled back', () => {
    // Otherwise the retry of a failed command would be served the failure as
    // though it had succeeded — idempotency turning a bug into a permanent one.
    const store = new MemoryStore();
    expect(() => store.transaction((tx) => {
      tx.recordCommand('cmd-1', { ok: true });
      throw new Error('failed after recording');
    })).toThrow();

    expect(store.read((tx) => tx.commandResult('cmd-1').found)).toBe(false);
  });

  it('discards appended events on rollback', () => {
    const store = new MemoryStore();
    const before = store.read((tx) => tx.allEvents().length);
    expect(() => store.transaction((tx) => {
      tx.appendEvent({
        id: 'e1', worldId: 'w', shardId: 's', occurredAt: 0n,
        kind: 'building.completed', subjectId: 'a', payload: {},
      });
      throw new Error('nope');
    })).toThrow();
    expect(store.read((tx) => tx.allEvents().length)).toBe(before);
  });

  it('a failed transaction does not poison the next one', () => {
    const store = new MemoryStore();
    expect(() => store.transaction(() => { throw new Error('nope'); })).toThrow();
    store.transaction((tx) => { tx.settlements.put(settlement('a', 'After')); });
    expect(store.read((tx) => tx.settlements.require('a').name)).toBe('After');
  });
});
