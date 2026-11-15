/**
 * Module « Brouillage GPS » : où les avions annoncent une position dégradée, signe possible d'un brouillage ou d'un leurre
 * du signal GPS (méthode de gpsjam.org).
 *
 * **C'est une estimation indirecte.** Chaque avion en ADS-B diffuse deux indicateurs de la qualité de sa position (NIC et
 * NACp). Le serveur (server/src/jamming.rs) compte, par case de 0,5° et sur les 20 dernières minutes, les avions vus et ceux
 * dont la position est dégradée (NIC inférieur à 7 ou NACp inférieur à 8, hors MLAT et TIS-B). On ne mesure donc pas le
 * brouillage lui-même : on voit ses effets sur les avions qui passent. Un transpondeur défectueux ou ancien, une zone peu
 * couverte par les récepteurs, ou un avion brouillé qui cesse d'émettre, faussent la lecture ; la fiche le rappelle.
 *
 * Une case est dessinée en rouge brique d'autant plus foncé (le jour) que la part d'avions dégradés est forte ; en gris quand
 * elle a trop peu d'avions pour que la part veuille dire quelque chose. Une case sans avion n'est pas dessinée : on n'y sait
 * rien. Une case calme (moins de 2 avions dégradés, ou moins de 2 % d'entre eux) reste très discrète.
 *
 * Direct seulement : le serveur ne garde pas d'historique de cette grille.
 */
import { BROUILLAGE, hexToRgb } from '../design/tokens';
import type { Color } from '@deck.gl/core';
import { PolygonLayer } from '@deck.gl/layers';
import { estimatedStatus } from '../core/infoStatus';
import { defineModule, type InfoContent, type LegendItem } from '../core/module';
import { isReplayTime } from '../core/replay';
import { OVER_MAP } from '../map/parameters';

interface ApiCell {
  /** Coin sud-ouest de la case. */
  lon: number;
  lat: number;
  /** Avions vus dans la fenêtre, et ceux dont la position est dégradée. */
  n: number;
  bad: number;
}

interface ApiJamming {
  updatedAt: number;
  cellDeg: number;
  windowS: number;
  coveredS: number;
  minAircraft: number;
  minDegraded: number;
  cells: ApiCell[];
}

/** Une case prête à dessiner. `level` : cran de la rampe (0 à 4), ou -1 quand il y a trop peu d'avions. */
interface Cell {
  key: string;
  lon: number;
  lat: number;
  n: number;
  bad: number;
  /** Part d'avions dégradés (0 à 1). */
  share: number;
  level: number;
  polygon: Array<[number, number]>;
}

export interface JammingData {
  cells: Cell[];
  byKey: Map<string, Cell>;
  cellDeg: number;
  windowS: number;
  coveredS: number;
  minAircraft: number;
  minDegraded: number;
  /** Instant du calcul du serveur (ms). */
  updatedAt: number;
}

/** Bornes basses (part d'avions dégradés) des cinq crans de la rampe. */
const LEVEL_FROM = [0, 0.02, 0.05, 0.1, 0.25] as const;
const LEVEL_LABELS = ['Moins de 2 %', '2 à 5 %', '5 à 10 %', '10 à 25 %', '25 % et plus'] as const;
/** Opacité de chaque cran : une case calme s'efface, une case très touchée se lit tout de suite. */
const LEVEL_ALPHA = [0.1, 0.42, 0.58, 0.74, 0.86] as const;
/** Gris des cases trop peu fréquentées (neutre, sans teinte de donnée). */
const SPARSE_HEX = '#8b92a1';
const SPARSE_ALPHA = 0.22;
/** Contour de la case choisie. */
const WHITE: Color = [255, 255, 255, 245];
const INK: Color = [20, 26, 38, 235];

const nf = (n: number, digits = 0) => n.toLocaleString('fr-FR', { maximumFractionDigits: digits });
const pct = (share: number) => `${nf(share * 100, share < 0.1 ? 1 : 0)} %`;
/** « 48,5° N », « 2,0° E », « 1,5° O ». */
const degrees = (value: number, positive: string, negative: string) => `${nf(Math.abs(value), 1)}° ${value >= 0 ? positive : negative}`;

/** Cran de la rampe : une case dont moins de `minDegraded` avions sont dégradés est calme, quelle que soit la part. */
export function levelOf(n: number, bad: number, minAircraft: number, minDegraded: number): number {
  if (n < minAircraft) return -1;
  if (bad < minDegraded) return 0;
  const share = bad / n;
  let level = 0;
  LEVEL_FROM.forEach((from, i) => {
    if (share >= from) level = i;
  });
  return level;
}

async function loadJamming(signal: AbortSignal): Promise<JammingData> {
  const response = await fetch('/api/brouillage', { signal });
  if (response.status === 503) throw new Error('le serveur n’a pas encore reçu assez de positions, nouvel essai dans quelques secondes');
  if (!response.ok) throw new Error(`le serveur du brouillage GPS a répondu ${response.status}`);
  const json = (await response.json()) as ApiJamming;
  const d = json.cellDeg;
  const cells: Cell[] = json.cells.map((c) => ({
    key: `${c.lon},${c.lat}`,
    lon: c.lon,
    lat: c.lat,
    n: c.n,
    bad: c.bad,
    share: c.n > 0 ? c.bad / c.n : 0,
    level: levelOf(c.n, c.bad, json.minAircraft, json.minDegraded),
    polygon: [
      [c.lon, c.lat],
      [c.lon + d, c.lat],
      [c.lon + d, c.lat + d],
      [c.lon, c.lat + d],
    ],
  }));
  return {
    cells,
    byKey: new Map(cells.map((c) => [c.key, c])),
    cellDeg: d,
    windowS: json.windowS,
    coveredS: json.coveredS,
    minAircraft: json.minAircraft,
    minDegraded: json.minDegraded,
    updatedAt: json.updatedAt * 1000,
  };
}

/** Couleur de remplissage d'une case, selon que le fond est de jour ou de nuit. */
function fill(cell: Cell, night: boolean): Color {
  if (cell.level < 0) return [...hexToRgb(SPARSE_HEX), Math.round(SPARSE_ALPHA * 255)];
  const ramp = night ? BROUILLAGE.nuit : BROUILLAGE.jour;
  return [...hexToRgb(ramp[cell.level]!), Math.round(LEVEL_ALPHA[cell.level]! * 255)];
}

const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));

export const jamming = defineModule<JammingData>({
  id: 'brouillage-gps',
  name: 'Brouillage GPS',
  category: 'ciel',
  description:
    'Estimation du brouillage ou du leurre GPS d’après la qualité de position que les avions annoncent, par case de 0,5° sur les 20 dernières minutes. Une estimation indirecte, en direct seulement.',
  attribution: 'adsb.lol et adsb.fi (qualité de position des avions, ODbL) ; calcul Vigie, méthode de gpsjam.org',
  refreshIntervalMs: 60_000,
  timeStepMs: 60_000,

  legend(_settings, data): LegendItem[] {
    const minAircraft = data?.minAircraft ?? 5;
    const items: LegendItem[] = BROUILLAGE.jour.map((color, level) => ({ color, label: `${LEVEL_LABELS[level]} d’avions à la position dégradée` }));
    items.push({ color: SPARSE_HEX, label: `Moins de ${minAircraft} avions : trop peu pour conclure` });
    items.push({ color: 'transparent', label: 'Pas de case : aucun avion vu en 20 min' });
    return items;
  },

  load: ({ signal }) => loadJamming(signal),

  summary({ data, time }) {
    if (!data) return null;
    if (isReplayTime(time)) return 'Direct seulement : pas d’historique du brouillage';
    const touched = data.cells.filter((c) => c.level >= 3).length;
    const partial = data.coveredS < data.windowS ? ` · relevés depuis ${minutes(data.coveredS)} min seulement` : '';
    const how = touched > 0 ? `${nf(touched)} case${touched > 1 ? 's' : ''} à 10 % ou plus` : 'aucune case à 10 % ou plus';
    return `En direct, estimation sur ${minutes(data.windowS)} min · ${how}${partial}`;
  },

  deckLayers({ data, time, selection, night }) {
    if (!data || isReplayTime(time)) return [];
    const dark = night >= 0.5;
    const chosen = selection ? data.byKey.get((selection as { key: string }).key) : undefined;
    return [
      new PolygonLayer<Cell>({
        id: 'brouillage/cases',
        data: data.cells,
        getPolygon: (c) => c.polygon,
        getFillColor: (c) => fill(c, dark),
        stroked: true,
        getLineColor: [255, 255, 255, 70],
        lineWidthUnits: 'pixels',
        getLineWidth: 0.6,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 80],
        updateTriggers: { getFillColor: dark },
        parameters: OVER_MAP,
      }),
      chosen &&
        // La case choisie : un contour blanc cerné de sombre, comme les anneaux des autres couches.
        [
          ['brouillage/choisie-contour', INK, 4],
          ['brouillage/choisie', WHITE, 1.8],
        ].map(
          ([id, color, width]) =>
            new PolygonLayer<Cell>({
              id: id as string,
              data: [chosen],
              getPolygon: (c) => c.polygon,
              filled: false,
              stroked: true,
              getLineColor: color as Color,
              lineWidthUnits: 'pixels',
              getLineWidth: width as number,
              parameters: OVER_MAP,
            }),
        ),
    ].flat();
  },

  select(object) {
    return { key: (object as Cell).key };
  },

  describe(selection, { data }): InfoContent | null {
    const cell = data?.byKey.get((selection as { key: string }).key);
    if (!data || !cell) return null;
    const d = data.cellDeg;
    const sparse = cell.level < 0;
    const reading = sparse
      ? `Trop peu d’avions (moins de ${data.minAircraft}) pour que la part d’avions dégradés veuille dire quelque chose.`
      : cell.bad < data.minDegraded
        ? `Moins de ${data.minDegraded} avions à la position dégradée : un transpondeur isolé ne fait pas un brouillage, la case est comptée comme calme.`
        : `${nf(cell.bad)} avion${cell.bad > 1 ? 's' : ''} sur ${nf(cell.n)} annoncent une position dégradée dans cette case.`;
    return {
      kind: 'Brouillage GPS · estimation',
      title: `${degrees(cell.lat, 'N', 'S')} à ${degrees(cell.lat + d, 'N', 'S')}, ${degrees(cell.lon, 'E', 'O')} à ${degrees(cell.lon + d, 'E', 'O')}`,
      subtitle: `Case de ${nf(d, 1)}° (environ ${nf(d * 111)} km de côté)`,
      // Calculée par le serveur sur une fenêtre, pas mesurée en un point : une estimation, pas un direct.
      status: estimatedStatus(`Estimation sur ${minutes(data.windowS)} min`),
      figures: [
        sparse ? { value: '—', label: 'part dégradée' } : { value: pct(cell.share), label: 'avions dégradés' },
        { value: nf(cell.n), label: `avions vus en ${minutes(data.windowS)} min` },
        { value: nf(cell.bad), label: 'positions dégradées' },
      ],
      fields: [
        ['Lecture', reading],
        ['Seuil', 'NIC inférieur à 7 ou NACp inférieur à 8, hors MLAT et TIS-B, transpondeurs de version 2'],
        ['Relevés', data.coveredS < data.windowS ? `depuis ${minutes(data.coveredS)} min seulement (serveur récemment démarré)` : `${minutes(data.windowS)} min complètes`],
      ],
      note: 'Estimation indirecte : on ne mesure pas le brouillage, on observe la qualité de position que les avions de passage annoncent. Un transpondeur ancien ou défectueux, un trou de couverture des récepteurs, ou des avions brouillés qui cessent d’émettre peuvent la fausser. Une case seule ne prouve rien ; c’est un ensemble de cases voisines touchées, sur la durée, qui évoque un brouillage.',
      actions: [{ label: 'Comparer avec gpsjam.org', href: 'https://gpsjam.org' }],
    };
  },

  focus(selection, { data }) {
    const cell = data?.byKey.get((selection as { key: string }).key);
    if (!data || !cell) return null;
    return { lon: cell.lon + data.cellDeg / 2, lat: cell.lat + data.cellDeg / 2 };
  },
});
