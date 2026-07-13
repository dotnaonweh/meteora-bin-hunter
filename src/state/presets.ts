import { recoverable } from '../core/errors.js';
import type { Preset } from '../types/domain.js';
import type { StateStore } from './store.js';

export class PresetRegistry {
  constructor(private readonly store: StateStore) {}

  list(): readonly Preset[] {
    return Object.values(this.store.current.presets);
  }

  get(id: string): Preset | null {
    return this.store.current.presets[id] ?? null;
  }

  /** The active preset, falling back to the first one if the pointer is stale. */
  active(): Preset | null {
    const { activePresetId, presets } = this.store.current;
    if (activePresetId) {
      const p = presets[activePresetId];
      if (p) return p;
    }
    return Object.values(presets)[0] ?? null;
  }

  upsert(preset: Preset): void {
    this.store.update((s) => {
      s.presets[preset.id] = preset;
      s.activePresetId ??= preset.id;
    });
  }

  switch(id: string): Preset {
    const preset = this.store.current.presets[id];
    if (!preset) throw recoverable('preset.notFound', 'Preset not found');
    this.store.update((s) => {
      s.activePresetId = id;
    });
    return preset;
  }

  remove(id: string): void {
    this.store.update((s) => {
      delete s.presets[id];
      if (s.activePresetId === id) {
        s.activePresetId = Object.keys(s.presets)[0] ?? null;
      }
    });
  }
}
