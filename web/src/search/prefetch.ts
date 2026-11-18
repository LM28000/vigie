/**
 * Quand la recherche charge-t-elle une couche que personne n'a ouverte ?
 *
 * Les fournisseurs cherchent dans les données déjà chargées par leur module. Pour que « webcam chamonix »
 * ou « borne ionity » donnent quelque chose sur une page fraîche, la barre déclenche le chargement du module
 * (sans l'afficher) dès que la requête contient un mot qui le désigne. Jamais sans mot explicite : les 53 000
 * bornes ne se chargent pas à chaque frappe. Ce fichier ne dépend de rien : il se teste seul.
 *
 * Les carburants (résultat « Afficher les prix ») et les événements (leur propre chargement) ont déjà leur mécanisme ;
 * les navires, avions et satellites n'ont pas de mot propre (on les cherche par nom ou indicatif) : ils ne se préchargent pas.
 */

/** Même normalisation que `fold` (normalize.ts), recopiée pour que ce fichier n'importe rien et se teste sous Node. */
const fold = (text: string): string =>
  text
    .replace(/œ/gi, 'oe')
    .replace(/æ/gi, 'ae')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export interface PrefetchRule {
  /** Identifiant du module à charger. */
  module: string;
  /** Message d'échec : « Webcams indisponibles ». */
  unavailable: string;
  /** Même contenu après « Chargement » : « des webcams ». */
  loading: string;
  /** Mots (normalisés) qui justifient le chargement ; une étoile finale accepte toute suite (« velo* » : vélos, vélo’v). */
  words: readonly string[];
}

export const PREFETCH_RULES: readonly PrefetchRule[] = [
  { module: 'cameras', unavailable: 'Webcams indisponibles', loading: 'des webcams', words: ['webcam*', 'cam', 'cams', 'camera*', 'criter'] },
  { module: 'bornes', unavailable: 'Bornes de recharge indisponibles', loading: 'des bornes de recharge', words: ['borne*', 'recharge*', 'charge', 'chargeur*', 'ionity', 'tesla', 'supercharger*', 'fastned', 'izivia', 'electrique*', 'irve'] },
  { module: 'velos', unavailable: 'Vélos en libre-service indisponibles', loading: 'des vélos en libre-service', words: ['velo*', 'velib*', 'velov*', 'vlille', 'vcub', 'bicloo', 'v3', 'velhop'] },
  { module: 'parkings', unavailable: 'Parkings indisponibles', loading: 'des parkings', words: ['parking*', 'relais'] },
  { module: 'monuments', unavailable: 'Monuments indisponibles', loading: 'des monuments', words: ['monument*', 'patrimoine', 'chateau*', 'eglise*', 'cathedrale*', 'abbaye*', 'chapelle*', 'basilique*'] },
  { module: 'actualite', unavailable: 'Actualité locale indisponible', loading: 'de l’actualité locale', words: ['actualite*', 'actu', 'actus', 'presse'] },
  { module: 'rivieres', unavailable: 'Rivières indisponibles', loading: 'des rivières', words: ['riviere*', 'fleuve*', 'hydro*', 'crue*', 'debit'] },
  { module: 'marees', unavailable: 'Marées indisponibles', loading: 'des marées', words: ['maree*', 'maregraphe*'] },
  { module: 'vigicrues', unavailable: 'Vigicrues indisponible', loading: 'de Vigicrues', words: ['vigicrue*', 'crue*'] },
];

const matches = (words: readonly string[], token: string): boolean =>
  words.some((word) => (word.endsWith('*') ? token.startsWith(word.slice(0, -1)) : token === word));

/** Les chargements que justifie cette requête (texte brut ou déjà normalisé), dans l'ordre des règles. */
export function prefetchRules(text: string): PrefetchRule[] {
  const tokens = fold(text).split(' ').filter(Boolean);
  if (tokens.length === 0) return [];
  return PREFETCH_RULES.filter((rule) => tokens.some((token) => matches(rule.words, token)));
}
