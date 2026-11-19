/**
 * Lecture de l'indice pollen du serveur (`/api/pollen`), sans carte : niveaux, taxons, valeur d'une commune
 * un jour donné. Séparé de `pollen.ts` pour pouvoir être testé sans MapLibre (web/scripts/pollen.test.mjs).
 */

// --- Données du serveur ----------------------------------------------------------------------

export interface ApiPollen {
  updatedAt: number;
  issuedAt?: number;
  /** Jours couverts, « AAAA-MM-JJ » (heure de Paris). */
  days: string[];
  sources: string[];
  /** `v` : 7 caractères par jour (global, puis les six taxons de `TAXA`) : `1` à `6`, `o` (aucun pollen), `-` (non évalué). */
  zones: { code: string[]; name: string[]; lon: number[]; lat: number[]; src: number[]; v: string[] };
}

export type PollenData = ApiPollen;

// --- Niveaux ---------------------------------------------------------------------------------

/** Palette officielle de l'indice pollen (Atmo France). */
export const LEVELS: Record<number, { name: string; color: string; text: string }> = {
  1: { name: 'Très faible', color: '#50F0E6', text: 'Le risque allergique est très faible.' },
  2: { name: 'Faible', color: '#50CCAA', text: 'Le risque allergique est faible : seules les personnes les plus sensibles peuvent ressentir une gêne.' },
  3: { name: 'Modéré', color: '#F0E641', text: 'Le risque allergique est modéré : les personnes allergiques peuvent ressentir des symptômes.' },
  4: { name: 'Élevé', color: '#FF5050', text: 'Le risque allergique est élevé : c’est un pic de pollen, les personnes allergiques sont probablement gênées.' },
  5: { name: 'Très élevé', color: '#960032', text: 'Le risque allergique est très élevé : les personnes allergiques sont très probablement gênées.' },
  6: { name: 'Extrêmement élevé', color: '#872181', text: 'Le risque allergique est extrêmement élevé : limitez les activités de plein air si vous êtes allergique.' },
};

/** « Aucun pollen » : niveau 1 avec une concentration nulle. Valeur propre, pour ne pas la peindre comme un « très faible ». */
export const NONE = 9;
export const NONE_COLOR = '#8c93a0';
export const NONE_NAME = 'Aucun pollen';

/** Taxons, dans l'ordre de la réponse du serveur (le global est en tête, au décalage 0). */
export const TAXA = [
  { id: 'aulne', name: 'Aulne', plant: 'l’aulne' },
  { id: 'bouleau', name: 'Bouleau', plant: 'le bouleau' },
  { id: 'olivier', name: 'Olivier', plant: 'l’olivier' },
  { id: 'graminees', name: 'Graminées', plant: 'les graminées' },
  { id: 'armoise', name: 'Armoise', plant: 'l’armoise' },
  { id: 'ambroisie', name: 'Ambroisie', plant: 'l’ambroisie' },
] as const;

export const levelName = (level: number): string => (level === NONE ? NONE_NAME : (LEVELS[level]?.name ?? 'Non évalué'));

/** Niveau d'une commune pour un jour et un décalage (0 global, 1 à 6 taxon) : 1 à 6, `NONE`, ou 0 (non évalué). */
export function cellOf(data: PollenData, zone: number, day: number, offset = 0): number {
  const code = data.zones.v[zone]?.charCodeAt(day * 7 + offset) ?? 45;
  if (code >= 49 && code <= 54) return code - 48;
  return code === 111 ? NONE : 0;
}

