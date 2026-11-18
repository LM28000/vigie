/**
 * La position de la personne : l'état (dernière position, erreur, suivi) et l'accès à `navigator.geolocation`.
 * La logique pure (arrondi, bonus, messages) est dans `positionLogic.ts`, testée.
 *
 * # Vie privée
 *
 * - **Jamais sans geste** : la géolocalisation n'est demandée que par `locate()` (clic sur « Autour de moi » ou sur « Surveiller
 *   autour de moi ») ; rien au chargement de la page, rien en arrière-plan. `watch(true)` (suivi) n'existe que tant que la personne
 *   l'a activé, et s'arrête avec le panneau.
 * - **En mémoire seulement** : la dernière position vit dans cet objet (perdue au rechargement) et n'est jamais écrite dans le
 *   navigateur. Le seul souvenir gardé est un drapeau « la personne a déjà accepté » (pour le libellé du bouton), sans coordonnées.
 * - **Rien n'est envoyé** : aucune requête ne la porte. La seule trace qui en sort est la zone de Veille que la personne crée
 *   elle-même, avec la position arrondie à environ 1 km (voir `veille.ts`).
 * - **HTTP** : `navigator.geolocation` n'existe qu'en contexte sûr (HTTPS, localhost) ; ailleurs, `supported()` est faux et
 *   `locate()` répond par un message, sans appeler le navigateur.
 */
import { useSyncExternalStore } from 'react';
import { INSECURE_MESSAGE, UNSUPPORTED_MESSAGE, geolocationMessage, isFresh, type LonLat, type UserPosition } from './positionLogic';

export type { UserPosition } from './positionLogic';

const ACCEPTED_KEY = 'carte-vivante:position:acceptee';
const LOCATE_TIMEOUT_MS = 12_000;
/** Une position de moins de 30 s suffit pour un nouveau clic : le navigateur peut la resservir sans rallumer le GPS. */
const LOCATE_MAX_AGE_MS = 30_000;

export interface PositionState {
  status: 'idle' | 'locating' | 'ready' | 'error';
  position: UserPosition | null;
  /** Message en français du dernier échec (effacé à la prochaine tentative réussie). */
  error: string | null;
  /** Le suivi continu (`watchPosition`) est actif. */
  watching: boolean;
  /** La personne a déjà accepté la localisation dans ce navigateur (drapeau, sans coordonnées). */
  accepted: boolean;
}

function readAccepted(): boolean {
  try {
    return localStorage.getItem(ACCEPTED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAccepted(): void {
  try {
    localStorage.setItem(ACCEPTED_KEY, '1');
  } catch {
    // stockage refusé : le libellé du bouton ne s'en souviendra pas, rien d'autre
  }
}

/** Contexte sûr et API présente : sinon aucun appel n'est tenté. */
export function geolocationSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof navigator !== 'undefined' && 'geolocation' in navigator;
}

class PositionStore {
  private state: PositionState = { status: 'idle', position: null, error: null, watching: false, accepted: readAccepted() };
  private listeners = new Set<() => void>();
  private watchId: number | undefined;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PositionState => this.state;

  private set(patch: Partial<PositionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** La position utilisable maintenant (mesurée il y a moins de 30 minutes), sinon `null`. */
  current(): UserPosition | null {
    const { position } = this.state;
    return position && isFresh(position, Date.now()) ? position : null;
  }

  /** Raison pour laquelle la localisation est impossible ici, ou `null`. */
  unavailableReason(): string | null {
    if (typeof window !== 'undefined' && !window.isSecureContext) return INSECURE_MESSAGE;
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return UNSUPPORTED_MESSAGE;
    return null;
  }

  private accept(raw: GeolocationPosition): UserPosition {
    const position: UserPosition = { lon: raw.coords.longitude, lat: raw.coords.latitude, accuracy: raw.coords.accuracy, at: Date.now() };
    if (!this.state.accepted) writeAccepted();
    this.set({ status: 'ready', position, error: null, accepted: true });
    return position;
  }

  /** Demande la position (à appeler depuis un geste). Se résout par la position, ou `null` avec `state.error` renseigné. */
  locate(): Promise<UserPosition | null> {
    const reason = this.unavailableReason();
    if (reason) {
      this.set({ status: 'error', error: reason });
      return Promise.resolve(null);
    }
    this.set({ status: 'locating', error: null });
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (raw) => resolve(this.accept(raw)),
        (error) => {
          // Refus, indisponible ou délai : la dernière position reste affichée si on en avait une.
          this.set({ status: this.state.position ? 'ready' : 'error', error: geolocationMessage(error.code) });
          resolve(null);
        },
        { enableHighAccuracy: false, timeout: LOCATE_TIMEOUT_MS, maximumAge: LOCATE_MAX_AGE_MS },
      );
    });
  }

  /** Active ou coupe le suivi continu. Sans effet hors contexte sûr. */
  watch(on: boolean): void {
    if (!on) {
      if (this.watchId !== undefined) navigator.geolocation.clearWatch(this.watchId);
      this.watchId = undefined;
      if (this.state.watching) this.set({ watching: false });
      return;
    }
    if (this.watchId !== undefined || this.unavailableReason()) return;
    this.set({ watching: true });
    this.watchId = navigator.geolocation.watchPosition(
      (raw) => void this.accept(raw),
      (error) => {
        // Refus : on arrête. Un trou de signal passager (2, 3) : on garde la dernière position et on attend la suivante.
        if (error.code === 1) {
          this.watch(false);
          this.set({ error: geolocationMessage(1), status: this.state.position ? 'ready' : 'error' });
        } else if (!this.state.position) this.set({ error: geolocationMessage(error.code), status: 'error' });
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 5_000 },
    );
  }

  /** Oublie la position (mémoire), coupe le suivi. Le drapeau « déjà accepté » reste : c'est le navigateur qui garde la permission. */
  clear(): void {
    this.watch(false);
    this.set({ status: 'idle', position: null, error: null });
  }
}

export const position = new PositionStore();

export function usePosition(): PositionState {
  return useSyncExternalStore(position.subscribe, position.getSnapshot);
}

/** Origine du classement de la recherche : la position fraîche, ou `null`. */
export function originOf(state: PositionState): LonLat | null {
  return state.position && isFresh(state.position, Date.now()) ? [state.position.lon, state.position.lat] : null;
}
