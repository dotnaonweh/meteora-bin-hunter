import type { TrackedPosition } from '../types/domain.js';
import type { StateStore } from './store.js';

export class PositionRegistry {
  constructor(private readonly store: StateStore) {}

  list(): readonly TrackedPosition[] {
    return Object.values(this.store.current.positions);
  }

  get(key: string): TrackedPosition | null {
    return this.store.current.positions[key] ?? null;
  }

  get size(): number {
    return Object.keys(this.store.current.positions).length;
  }

  upsert(position: TrackedPosition): void {
    this.store.update((s) => {
      s.positions[position.positionKey] = position;
    });
  }

  remove(key: string): void {
    this.store.update((s) => {
      delete s.positions[key];
    });
  }

  /**
   * Replaces tracked positions with the on-chain truth.
   * `onChain` is authoritative: anything not in it has been closed.
   */
  reconcile(onChain: ReadonlyMap<string, TrackedPosition>): { added: number; removed: number } {
    let added = 0;
    let removed = 0;

    this.store.update((s) => {
      for (const [key, pos] of onChain) {
        if (!s.positions[key]) {
          s.positions[key] = pos;
          added++;
        }
      }
      for (const key of Object.keys(s.positions)) {
        if (!onChain.has(key)) {
          delete s.positions[key];
          removed++;
        }
      }
    });

    return { added, removed };
  }
}
