/** Logique pure de l'installation de l'application (testable sans navigateur) : `core/pwa.ts` s'en sert. */

/** iPhone, iPad (dont ceux qui se disent « Mac ») : seul Safari y installe, par « Partager » puis « Sur l'écran d'accueil ». */
export function isIos(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return /iPad|iPhone|iPod/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
}

/** Navigateurs iOS qui ne sont pas Safari (Chrome, Firefox, Edge…) : ils n'offrent « Sur l'écran d'accueil » que depuis le menu Partager récent, on l'indique sans promettre. */
export function isIosSafari(userAgent: string): boolean {
  return !/CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent);
}

/** Le service worker n'est enregistré que sur le site construit, en contexte sûr (HTTPS ou localhost), si le navigateur le permet. */
export function canRegisterServiceWorker(env: { prod: boolean; secure: boolean; supported: boolean }): boolean {
  return env.prod && env.secure && env.supported;
}

/** Vrai quand l'application tourne installée : fenêtre autonome (Chrome, Android, TWA) ou écran d'accueil iOS. */
export function isStandalone(env: { displayStandalone: boolean; iosStandalone: boolean }): boolean {
  return env.displayStandalone || env.iosStandalone;
}
