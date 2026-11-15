/**
 * Modes de vision : un rendu appliqué à toute la carte (fond et couches deck.gl), pas à l'interface.
 *
 * Le mode vit ici, hors de React : l'attribut `data-vision` de `<html>` suit le mode et la feuille `ui/vision.css` fait le reste
 * (filtre sur le canevas de la carte, surcouches). L'adresse porte `vision=nocturne|thermique|cathodique` (absent : normal),
 * voir `shareState.ts`. La préférence du navigateur (`localStorage`) donne le mode de départ quand l'adresse ne dit rien ;
 * un mode venu de l'adresse n'y est pas enregistré.
 */
import { useSyncExternalStore } from 'react';

export const VISION_MODES = ['normal', 'nocturne', 'thermique', 'cathodique'] as const;
export type VisionMode = (typeof VISION_MODES)[number];

export const VISION_LABELS: Readonly<Record<VisionMode, { label: string; hint: string }>> = {
  normal: { label: 'Normal', hint: 'La carte telle quelle' },
  nocturne: { label: 'Vision nocturne', hint: 'Vert phosphore, grain' },
  thermique: { label: 'Thermique', hint: 'Fausses couleurs, du noir au blanc' },
  cathodique: { label: 'Écran cathodique', hint: 'Lignes de balayage, ambre' },
};

const STORAGE_KEY = 'vigie.vision';

export function isVisionMode(value: unknown): value is VisionMode {
  return (VISION_MODES as readonly unknown[]).includes(value);
}

function readPreference(): VisionMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isVisionMode(stored) ? stored : 'normal';
  } catch {
    return 'normal'; // stockage indisponible (navigation privée…)
  }
}

function writePreference(mode: VisionMode): void {
  try {
    if (mode === 'normal') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // stockage indisponible : la préférence ne sera simplement pas retenue
  }
}

class VisionStore {
  private mode: VisionMode = readPreference();
  private listeners = new Set<() => void>();

  constructor() {
    this.reflect();
  }

  private reflect(): void {
    document.documentElement.dataset.vision = this.mode;
  }

  getSnapshot = (): VisionMode => this.mode;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** `persist: false` pour un mode venu de l'adresse (il n'écrase pas la préférence). */
  set(mode: VisionMode, { persist = true }: { persist?: boolean } = {}): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.reflect();
    if (persist) writePreference(mode);
    for (const listener of this.listeners) listener();
  }

  /** Mode suivant dans l'ordre (raccourci `V`). */
  cycle(): VisionMode {
    const next = VISION_MODES[(VISION_MODES.indexOf(this.mode) + 1) % VISION_MODES.length]!;
    this.set(next);
    return next;
  }
}

export const vision = new VisionStore();

export function useVision(): VisionMode {
  return useSyncExternalStore(vision.subscribe, vision.getSnapshot);
}
