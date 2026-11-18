/**
 * Rafraîchissement de la fiche à la demande : une fiche dont le contenu arrive après coup (le détail d'un événement, lu au clic)
 * doit se redessiner même quand l'horloge est en pause (sinon rien ne la déclenche : ni l'instant, ni la sélection ne changent).
 * Le module appelle `requestInfoRefresh()` quand sa donnée est arrivée ; `useSelectionInfo` s'y abonne.
 */
let version = 0;
const listeners = new Set<() => void>();

export const subscribeInfoRefresh = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getInfoRefreshVersion = (): number => version;

export function requestInfoRefresh(): void {
  version += 1;
  for (const listener of listeners) listener();
}
