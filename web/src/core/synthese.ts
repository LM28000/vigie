/**
 * Panneau « Aujourd'hui en France » : seul son état ouvert ou fermé vit ici, hors de React (comme `vision.ts`).
 * L'adresse porte `synthese=1` quand il est ouvert (voir `shareState.ts`), ce qui permet de partager un lien qui l'ouvre.
 * Le contenu (`ui/Synthese.tsx`) se charge à l'ouverture seulement : fermé, le panneau ne coûte aucune requête.
 */
import { useSyncExternalStore } from 'react';

class SyntheseStore {
  private open = false;
  private listeners = new Set<() => void>();

  getSnapshot = (): boolean => this.open;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    for (const listener of this.listeners) listener();
  }

  toggle(): void {
    this.set(!this.open);
  }
}

export const synthese = new SyntheseStore();

export function useSyntheseOpen(): boolean {
  return useSyncExternalStore(synthese.subscribe, synthese.getSnapshot);
}
