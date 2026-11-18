import { useSyncExternalStore } from 'react';
import { canRegisterServiceWorker, isIos, isIosSafari, isStandalone } from './pwaLogic';

/**
 * Application installable : service worker (coque hors ligne, mise à jour proposée), invite
 * d'installation de Chrome/Android (`beforeinstallprompt`), aide pour iOS, état hors ligne.
 * Tout se dégrade : en HTTP sur le réseau local (contexte non sûr) rien n'est enregistré ni proposé.
 */
export interface PwaState {
  /** Chrome/Android a mis l'installation de côté : le bouton peut la lancer. */
  canInstall: boolean;
  /** iPhone/iPad hors écran d'accueil : pas d'invite, une aide « Partager → Sur l'écran d'accueil ». */
  iosHelp: boolean;
  /** Une nouvelle version du site est prête, en attente d'un clic sur « Recharger ». */
  updateReady: boolean;
  /** Le navigateur se dit sans réseau. */
  offline: boolean;
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const UPDATE_CHECK_MS = 60 * 60_000;

const standalone = () =>
  isStandalone({
    displayStandalone: window.matchMedia('(display-mode: standalone)').matches,
    iosStandalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
  });

let state: PwaState = { canInstall: false, iosHelp: false, updateReady: false, offline: typeof navigator !== 'undefined' && navigator.onLine === false };
let installEvent: InstallPromptEvent | null = null;
let waiting: ServiceWorker | null = null;
const listeners = new Set<() => void>();

function update(patch: Partial<PwaState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function usePwa(): PwaState {
  return useSyncExternalStore(subscribe, () => state);
}

/** À appeler une fois au démarrage. Ne fait rien d'utile hors navigateur ; sans effet en double. */
let started = false;
export function startPwa(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  window.addEventListener('online', () => update({ offline: false }));
  window.addEventListener('offline', () => update({ offline: true }));

  if (!standalone()) {
    if (isIos(navigator.userAgent, navigator.platform, navigator.maxTouchPoints) && isIosSafari(navigator.userAgent)) update({ iosHelp: true });
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault(); // l'entrée du catalogue prend le relais de la mini-barre du navigateur
      installEvent = event as InstallPromptEvent;
      update({ canInstall: true });
    });
  }
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    update({ canInstall: false, iosHelp: false });
  });

  const supported = 'serviceWorker' in navigator;
  if (canRegisterServiceWorker({ prod: import.meta.env.PROD, secure: window.isSecureContext, supported })) void registerServiceWorker();
}

/** Ouvre l'invite d'installation du navigateur ; l'événement ne sert qu'une fois. */
export async function promptInstall(): Promise<void> {
  const event = installEvent;
  if (!event) return;
  installEvent = null;
  update({ canInstall: false });
  await event.prompt();
}

/** « Recharger » : la nouvelle version prend la main, la page se recharge une fois qu'elle l'a fait. */
export function applyUpdate(): void {
  if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
  else window.location.reload();
}

async function registerServiceWorker(): Promise<void> {
  try {
    // La première prise de contrôle (premier chargement du site) ne recharge rien ; les suivantes sont une mise à jour acceptée.
    let controlled = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!controlled) {
        controlled = true;
        return;
      }
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });

    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    // Une première installation n'a pas de version à remplacer : seule une mise à jour se propose.
    const watch = (worker: ServiceWorker | null) => {
      if (!worker) return;
      const check = () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          waiting = worker;
          update({ updateReady: true });
        }
      };
      worker.addEventListener('statechange', check);
      check();
    };
    watch(registration.waiting);
    registration.addEventListener('updatefound', () => watch(registration.installing));

    // Une session de carte dure : on cherche une nouvelle version chaque heure et au retour sur l'onglet.
    const check = () => void registration.update().catch(() => undefined);
    setInterval(check, UPDATE_CHECK_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  } catch {
    // Enregistrement refusé (navigation privée, politique du navigateur) : le site fonctionne sans.
  }
}
