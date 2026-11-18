/**
 * Position de la personne : la logique pure (arrondi, bonus de proximité, messages, sélection autour d'un point), sans import
 * (ni React, ni navigateur) pour être testée telle quelle (`node --test web/scripts/position.test.mjs`).
 * L'état et l'accès à `navigator.geolocation` sont dans `position.ts`.
 */

/** Longitude, latitude (degrés) : le même ordre que `Position` de `geo.ts`. */
export type LonLat = [lon: number, lat: number];

export interface UserPosition {
  lon: number;
  lat: number;
  /** Rayon d'incertitude (mètres) donné par le navigateur. */
  accuracy: number;
  /** Heure de la mesure (ms). */
  at: number;
}

/** Au-delà, la position gardée en mémoire n'est plus « ici » : on ne s'en sert plus (classement de la recherche). */
export const POSITION_MAX_AGE_MS = 30 * 60_000;

export const isFresh = (position: Pick<UserPosition, 'at'>, now: number): boolean => now - position.at <= POSITION_MAX_AGE_MS;

/** Décimales gardées pour une zone de Veille : 0,01° ≈ 1,1 km en latitude (0,7 km en longitude vers 50° N). */
export const ROUND_DECIMALS = 2;

/** La position arrondie à environ 1 km : la seule forme qui sort du navigateur (zone de Veille). */
export function roundPosition(lon: number, lat: number, decimals = ROUND_DECIMALS): LonLat {
  const k = 10 ** decimals;
  // `+ 0` : jamais de -0 (« -0 » s'écrirait dans l'adresse)
  return [Math.round(lon * k) / k + 0, Math.round(lat * k) / k + 0];
}

/** Rayons proposés pour surveiller autour de soi (km). */
export const WATCH_RADII_KM = [10, 25, 50] as const;
export type WatchRadiusKm = (typeof WATCH_RADII_KM)[number];

/** La définition d'une zone de Veille circulaire autour de la position arrondie (même forme que `ZoneRef` de `veilleLogic.ts`). */
export function aroundMeRef(lon: number, lat: number, radiusKm: number): { kind: 'circle'; lon: number; lat: number; radius: number } {
  const [rlon, rlat] = roundPosition(lon, lat);
  return { kind: 'circle', lon: rlon, lat: rlat, radius: Math.round(radiusKm * 1000) };
}

/** Bonus maximal de la recherche, sur place : de l'ordre d'un départage, jamais plus qu'un bon début de mot. */
export const PROXIMITY_MAX_BONUS = 30;
const PROXIMITY_SCALE_KM = 10;

/**
 * Bonus de classement d'un résultat à `distanceM` mètres de la personne : 30 sur place, 15 à 10 km, 3 à 90 km, rien
 * au-delà de 150 km (là, la distance ne dit plus rien). Décroissant et borné : il ne change que l'ordre de résultats proches.
 */
export function proximityBonus(distanceM: number): number {
  if (!Number.isFinite(distanceM) || distanceM < 0) return 0;
  const km = distanceM / 1000;
  if (km > 150) return 0;
  return Math.round((PROXIMITY_MAX_BONUS / (1 + km / PROXIMITY_SCALE_KM)) * 10) / 10;
}

/** Les résultats avec leur bonus de proximité ajouté au score (ceux sans place gardent le leur). `distance` : `distanceM` de `geo.ts`. */
export function addProximity<T extends { score: number; at?: { lon: number; lat: number } }>(
  results: readonly T[],
  origin: LonLat,
  distance: (a: LonLat, b: LonLat) => number,
): T[] {
  return results.map((r) => (r.at ? { ...r, score: r.score + proximityBonus(distance(origin, [r.at.lon, r.at.lat])) } : r));
}

/** Message (français) d'une erreur de `navigator.geolocation` : 1 refus, 2 position indisponible, 3 délai dépassé. */
export function geolocationMessage(code: number): string {
  if (code === 1) return 'Localisation refusée. Autorisez-la pour ce site dans les réglages du navigateur, puis réessayez.';
  if (code === 2) return 'Position introuvable : l’appareil ne parvient pas à se situer. Réessayez dehors ou avec le Wi-Fi activé.';
  if (code === 3) return 'La localisation a mis trop de temps à répondre. Réessayez.';
  return 'Localisation impossible.';
}

export const INSECURE_MESSAGE = 'La localisation n’est possible qu’en connexion sécurisée (HTTPS) : le navigateur la refuse sur une adresse en HTTP.';
export const UNSUPPORTED_MESSAGE = 'Ce navigateur ne sait pas se localiser.';

/** « 450 m », « 3,4 km », « 12 km ». */
export function distanceText(meters: number): string {
  if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  if (meters < 10_000) return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
  return `${Math.round(meters / 1000)} km`;
}

/** Précision annoncée : « ± 25 m ». */
export function accuracyText(meters: number): string {
  return meters >= 1000 ? `± ${(meters / 1000).toFixed(1).replace('.', ',')} km` : `± ${Math.max(5, Math.round(meters / 5) * 5)} m`;
}

export interface Found<T> {
  item: T;
  /** Mètres, à vol d'oiseau. */
  distance: number;
}

/**
 * Les éléments à moins de `maxM` mètres de `origin`, du plus proche au plus lointain. Un premier tri par degrés écarte vite
 * l'immense majorité (53 000 bornes) avant le calcul de distance, passé en paramètre (`distanceM` de `geo.ts`).
 */
export function within<T>(
  items: readonly T[],
  origin: LonLat,
  maxM: number,
  at: (item: T) => LonLat,
  distance: (a: LonLat, b: LonLat) => number,
): Array<Found<T>> {
  const dLat = maxM / 111_000;
  const cos = Math.cos((origin[1] * Math.PI) / 180);
  // Près des pôles, les méridiens se rejoignent : plus de filtre en longitude.
  const dLon = cos < 0.05 ? 360 : dLat / cos;
  const found: Array<Found<T>> = [];
  for (const item of items) {
    const p = at(item);
    if (Math.abs(p[1] - origin[1]) > dLat || Math.abs(p[0] - origin[0]) > dLon) continue;
    const d = distance(origin, p);
    if (d <= maxM) found.push({ item, distance: d });
  }
  return found.sort((a, b) => a.distance - b.distance);
}
