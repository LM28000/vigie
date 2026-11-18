/**
 * Comprendre une requête de carburant : « e85 », « sp 95 », « gasoil », « gazole moins cher près de Rennes ».
 *
 * Fonctions pures, sans import (elles se testent sous Node : `web/scripts/recherche.test.mjs`).
 * Le texte est normalisé (sans accents, tirets et ponctuation en espaces) : « e-85 » devient « e 85 ».
 */

/** Même règle que `fold` de `normalize.ts` (recopiée : ce fichier ne doit rien importer pour se tester sous Node). */
function fold(text: string): string {
  return text
    .replace(/œ/gi, 'oe')
    .replace(/æ/gi, 'ae')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export type FuelId = 'gazole' | 'e10' | 'sp98' | 'sp95' | 'e85' | 'gplc';

/** Formes tapées pour chaque carburant ; la première qui correspond l'emporte (« sp95 e10 » est un E10). */
const FUEL_FORMS: ReadonlyArray<{ fuel: FuelId; pattern: RegExp }> = [
  { fuel: 'e10', pattern: /\b(?:sp ?95 )?e ?10\b|\bsans plomb 95 e ?10\b/ },
  { fuel: 'e85', pattern: /\be ?85\b|\bsuper ?ethanol\b|\bbio ?ethanol\b|\bethanol\b/ },
  { fuel: 'sp98', pattern: /\bsp ?98\b|\bsans plomb 98\b|\bsuper ?carburant 98\b/ },
  { fuel: 'sp95', pattern: /\bsp ?95\b|\bsans plomb 95\b|\bsuper ?carburant 95\b/ },
  { fuel: 'gazole', pattern: /\bgazole\b|\bgasoil\b|\bgas oil\b|\bdiesel\b|\bb7\b/ },
  { fuel: 'gplc', pattern: /\bgplc?\b|\bautogaz\b/ },
];
/** « de l'essence » sans précision : on prend le carburant le plus courant (E10) et on le dit. */
const GENERIC_PETROL = /\bessence\b|\bsans plomb\b/;
/** Mots qui parlent d'une station ou d'un prix sans nommer de carburant. */
const STATION_WORDS = /\b(?:stations?|carburants?|pompes?)\b/;
const CHEAP = /\b(?:moins cher|pas cher|meilleur prix|bon marche)\b/;
/** Mots de liaison, retirés pour ne garder que le lieu. */
const FILLER = new Set([
  'pres', 'proche', 'autour', 'de', 'du', 'des', 'la', 'le', 'les', 'a', 'au', 'aux', 'en', 'dans', 'sur', 'pour', 'd', 'l', 'ou', 'et', 'un', 'une', 'ici', 'plein', 'faire', 'moi',
  'pas', 'cher', 'moins', 'plus', 'meilleur', 'prix', 'bon', 'marche', 'station', 'stations', 'service', 'services', 'carburant', 'carburants', 'pompe', 'pompes', 'litre', 'litres',
]);

export interface FuelQuery {
  /** Carburant demandé ; `null` si seule une « station » est demandée (on prend le réglage de la couche). */
  fuel: FuelId | null;
  /** Le carburant vient d'un mot vague (« essence ») : on propose E10, et on le dit. */
  generic: boolean;
  /** Le lieu cité (« rennes », « 35 », « 69003 »), normalisé, vide si aucun. */
  place: string;
  /** « moins cher » dit : la requête vise le prix plutôt que la proximité. */
  cheapest: boolean;
}

/** Lit une requête de carburant ; `null` si elle n'en parle pas. */
export function parseFuelQuery(text: string): FuelQuery | null {
  const folded = fold(text);
  if (!folded) return null;
  let rest = folded;
  let fuel: FuelId | null = null;
  let generic = false;
  for (const { fuel: id, pattern } of FUEL_FORMS) {
    if (!pattern.test(rest)) continue;
    fuel = id;
    rest = rest.replace(pattern, ' ');
    // « sp95 e10 » : le E10 a tout dit, le SP95 qui reste n'est pas un second carburant.
    if (id === 'e10') rest = rest.replace(/\bsp ?95\b|\bsans plomb 95\b/g, ' ');
    break;
  }
  if (!fuel && GENERIC_PETROL.test(rest)) {
    fuel = 'e10';
    generic = true;
    rest = rest.replace(GENERIC_PETROL, ' ');
  }
  const stationWord = STATION_WORDS.test(rest);
  if (!fuel && !stationWord) return null;
  const place = rest
    .split(' ')
    .filter((word) => word && !FILLER.has(word))
    .join(' ');
  // « station » ou « carburant » seul n'est pas une recherche de station : il faut un lieu.
  if (!fuel && !place) return null;
  return { fuel, generic, place, cheapest: CHEAP.test(` ${folded} `) };
}
