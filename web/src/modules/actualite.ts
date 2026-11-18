/**
 * Module « Actualité locale » : les titres de la presse régionale et du service public (France 3 Régions, ICI,
 * quotidiens régionaux), placés sur la commune dont ils parlent. Le serveur (server/src/actualite.rs) lit leurs fils RSS
 * publics toutes les 15 minutes et ne garde que le titre, l'adresse de l'article, le nom du fil et l'heure : **ni texte, ni
 * chapô, ni image**. La fiche d'une commune liste ses titres ; chacun ouvre l'article chez l'éditeur.
 *
 * Un point par commune, d'autant plus gros qu'elle compte de titres, avec le nombre écrit dedans. De loin, les communes
 * voisines sont regroupées (une case de 60 px). Un titre qui ne cite aucune commune mais dont l'adresse ou le texte
 * nomme un département est rattaché au département : un anneau, pas un point précis.
 *
 * La période (3 h, 24 h, 3 jours) se compte en arrière depuis l'instant de la frise : en rejouant le passé, on voit les titres
 * tels qu'ils étaient (le serveur garde trois jours).
 */
import type { Color } from '@deck.gl/core';
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { defineModule } from '../core/module';
import type { InfoContent } from '../core/module';
import { measuredStatus, plainStatus } from '../core/infoStatus';
import { ACTUALITE, hexToRgb } from '../design/tokens';
import { declutter, halfZoomBreaks, zoomBand } from '../map/declutter';
import { OVER_MAP } from '../map/parameters';
import { formatDateTime, formatTime } from '../ui/format';
import { HALO, KEY, selectionRing } from './symbols';

interface ApiPlace {
  id: string;
  name: string;
  lon: number;
  lat: number;
  dept: string;
  isDept?: boolean;
}

interface ApiOut {
  generatedAt: number;
  sources: Array<{ group: string; name: string }>;
  places: ApiPlace[];
  /** `[heure (s), fil, lieu, titre, adresse]`, du plus récent au plus ancien. */
  items: Array<[number, number, number, string, string]>;
}

export interface Headline {
  /** Heure de publication (ms). */
  t: number;
  /** Éditeur ou réseau (« ICI ») et fil (« ICI Armorique »). */
  group: string;
  source: string;
  title: string;
  url: string;
}

export interface NewsPlace {
  id: string;
  name: string;
  lon: number;
  lat: number;
  dept: string;
  /** Titre rattaché au département seul (pas à une commune). */
  isDept: boolean;
  /** Du plus récent au plus ancien. */
  headlines: Headline[];
}

export interface ActualiteData {
  places: NewsPlace[];
  byId: Map<string, NewsPlace>;
  updatedAt: number;
}

/** Une commune dans la période affichée. */
interface Spot {
  place: NewsPlace;
  count: number;
  latest: number;
}

/** Des communes regroupées (de loin). */
interface Cluster {
  lon: number;
  lat: number;
  count: number;
  spots: Spot[];
}

const AGES: Record<string, number> = { '3h': 3 * 3600_000, '24h': 24 * 3600_000, '3j': 3 * 24 * 3600_000 };
const AGE_LABELS: Record<string, string> = { '3h': 'les 3 dernières heures', '24h': 'les 24 dernières heures', '3j': 'les 3 derniers jours' };
const COLOR = hexToRgb(ACTUALITE.jour[0]!);
const CSS = ACTUALITE.jour[0]!;

/** Sous ce zoom, les communes voisines sont regroupées ; au-dessus, un point par commune. */
const DETAIL_ZOOM = 9;
/** À partir de ce zoom, le nom de la commune s'écrit sous le point. */
const NAME_ZOOM = 9.5;
const CLUSTER_PX = 60;
const NAME_BOX_PX = { width: 120, height: 30 };
/** Titres listés dans une fiche. */
const MAX_LISTED = 60;
const MAX_CLUSTER_ROWS = 12;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`;

// --- Chargement ---

async function load(signal: AbortSignal): Promise<ActualiteData> {
  const response = await fetch('/api/actualite', { signal });
  if (response.status === 503) throw new Error('le serveur lit encore les fils d’actualité, nouvel essai dans une minute');
  if (!response.ok) throw new Error(`le serveur d’actualité a répondu ${response.status}`);
  const json = (await response.json()) as ApiOut;
  const places: NewsPlace[] = json.places.map((p) => ({ id: p.id, name: p.name, lon: p.lon, lat: p.lat, dept: p.dept, isDept: p.isDept === true, headlines: [] }));
  for (const [t, feed, place, title, url] of json.items) {
    const source = json.sources[feed];
    places[place]?.headlines.push({ t: t * 1000, group: source?.group ?? '', source: source?.name ?? '', title, url });
  }
  return { places, byId: new Map(places.map((p) => [p.id, p])), updatedAt: json.generatedAt * 1000 };
}

// --- Période, regroupement ---

let spotCache: { data: ActualiteData; age: string; minute: number; spots: Spot[] } | undefined;

/** Les communes qui ont au moins un titre dans la période qui finit à `time`. */
export function spotsAt(data: ActualiteData, time: number, age: string): Spot[] {
  const minute = Math.floor(time / 60_000);
  if (spotCache?.data === data && spotCache.age === age && spotCache.minute === minute) return spotCache.spots;
  const from = time - (AGES[age] ?? AGES['24h']!);
  const spots: Spot[] = [];
  for (const place of data.places) {
    let count = 0;
    let latest = 0;
    for (const h of place.headlines) {
      if (h.t > time || h.t <= from) continue;
      count++;
      latest = Math.max(latest, h.t);
    }
    if (count > 0) spots.push({ place, count, latest });
  }
  spotCache = { data, age, minute, spots };
  return spots;
}

/** Position en pixels (projection de Mercator, 512 px au zoom 0). */
function pixel(lon: number, lat: number, zoom: number): [number, number] {
  const scale = 512 * 2 ** zoom;
  const sin = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return [((lon + 180) / 360) * scale, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale];
}

let clusterCache: { spots: Spot[]; band: number; clusters: Cluster[] } | undefined;

/** Les communes d'une même case de `CLUSTER_PX` pixels forment un groupe, placé au barycentre pondéré par le nombre de titres. */
function clustersOf(spots: Spot[], zoom: number): Cluster[] {
  const band = zoomBand(zoom);
  if (clusterCache?.spots === spots && clusterCache.band === band) return clusterCache.clusters;
  const cells = new Map<string, Cluster>();
  for (const spot of spots) {
    const [x, y] = pixel(spot.place.lon, spot.place.lat, band);
    // Un titre rattaché au département seul ne se fond pas dans les communes : il reste son propre point.
    const key = spot.place.isDept ? `d:${spot.place.id}` : `${Math.floor(x / CLUSTER_PX)}:${Math.floor(y / CLUSTER_PX)}`;
    const cell = cells.get(key);
    if (cell) {
      cell.lon = (cell.lon * cell.count + spot.place.lon * spot.count) / (cell.count + spot.count);
      cell.lat = (cell.lat * cell.count + spot.place.lat * spot.count) / (cell.count + spot.count);
      cell.count += spot.count;
      cell.spots.push(spot);
    } else cells.set(key, { lon: spot.place.lon, lat: spot.place.lat, count: spot.count, spots: [spot] });
  }
  const clusters = [...cells.values()];
  clusterCache = { spots, band, clusters };
  return clusters;
}

const radiusOf = (count: number): number => Math.min(26, 9 + 3.6 * Math.sqrt(count));

function countText(count: number): string {
  return count >= 1000 ? `${Math.round(count / 100) / 10} k` : String(count);
}

// --- Fiches ---

function clusterId(cluster: Cluster): string {
  return `g:${cluster.spots
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 40)
    .map((s) => s.place.id)
    .join(',')}`;
}

/** « 14 h », « 25 min » : l'âge du titre le plus récent, en chiffre clé. */
function ago(ms: number): { value: string; unit: string; label: string } {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return { value: String(minutes), unit: 'min', label: 'le plus récent' };
  const hours = Math.round(minutes / 60);
  return hours < 48 ? { value: String(hours), unit: 'h', label: 'le plus récent' } : { value: String(Math.round(hours / 24)), unit: 'j', label: 'le plus récent' };
}

function placeInfo(place: NewsPlace, data: ActualiteData, time: number, age: string): InfoContent {
  const from = time - (AGES[age] ?? AGES['24h']!);
  const inWindow = place.headlines.filter((h) => h.t <= time && h.t > from);
  const listed = inWindow.slice(0, MAX_LISTED);
  const latest = inWindow[0]?.t;
  const today = new Date(time).toDateString();
  const when = (t: number) => (new Date(t).toDateString() === today ? formatTime(t) : formatDateTime(t).replace(/ 20\d\d,?/, ''));
  const sources = new Set(inWindow.map((h) => h.group));
  return {
    kind: place.isDept ? 'Actualité · département' : 'Actualité locale',
    title: place.name,
    subtitle: place.isDept ? 'Titres rattachés au département, pas à une commune' : `Département ${place.dept}`,
    status: latest === undefined ? plainStatus('Aucun titre dans la période') : measuredStatus(time, data.updatedAt),
    figures: [
      { value: String(inWindow.length), label: inWindow.length > 1 ? 'titres' : 'titre' },
      ...(latest !== undefined ? [ago(time - latest)] : []),
      ...(sources.size > 0 ? [{ value: String(sources.size), label: sources.size > 1 ? 'sources' : 'source' }] : []),
    ],
    tables: [
      {
        title: `Titres sur ${AGE_LABELS[age] ?? AGE_LABELS['24h']}${inWindow.length > listed.length ? ` (${listed.length} sur ${inWindow.length})` : ''}`,
        columns: ['Heure', 'Titre', 'Source'],
        layout: 'list',
        empty: 'Aucun titre dans cette période : choisissez une période plus longue.',
        rows: listed.map((h) => ({ cells: [when(h.t), h.title, h.group], href: h.url })),
      },
    ],
    note: 'Titre, source et heure seulement : l’article s’ouvre chez l’éditeur. Lieu déduit, parfois à tort.',
  };
}

function clusterInfo(ids: string[], data: ActualiteData, time: number, age: string): InfoContent | null {
  const spots = spotsAt(data, time, age).filter((s) => ids.includes(s.place.id));
  if (spots.length === 0) return null;
  const total = spots.reduce((sum, s) => sum + s.count, 0);
  const ranked = spots.slice().sort((a, b) => b.count - a.count || b.latest - a.latest);
  return {
    kind: 'Actualité locale · groupe',
    title: `${plural(total, 'titre')} dans ${plural(spots.length, 'commune')}`,
    subtitle: `Sur ${AGE_LABELS[age] ?? AGE_LABELS['24h']}`,
    status: measuredStatus(time, data.updatedAt),
    tables: [
      {
        title: 'Communes dont on parle le plus',
        columns: ['Commune', 'Titres'],
        rows: ranked.slice(0, MAX_CLUSTER_ROWS).map((s) => ({ cells: [s.place.name, String(s.count)], select: { place: s.place.id } })),
      },
    ],
    note: 'Zoomez pour voir chaque commune, ou ouvrez-en une dans la liste.',
  };
}

// --- Le module ---

export const actualite = defineModule<ActualiteData>({
  id: 'actualite',
  name: 'Actualité locale',
  category: 'territoire',
  description: 'Les titres de la presse régionale et du service public, placés sur la commune dont ils parlent. Le titre et le lien seulement : l’article s’ouvre chez l’éditeur.',
  attribution: 'Titres des fils RSS publics de France 3 Régions, ICI, Le Progrès, DNA, La Dépêche, Midi Libre, Nice-Matin, actu.fr… ; communes : INSEE via geo.api.gouv.fr (Licence Ouverte)',
  refreshIntervalMs: 5 * 60_000,
  timeStepMs: 60_000,
  zoomBreaks: halfZoomBreaks(4, 10.5),

  settings: [
    {
      id: 'age',
      label: 'Période',
      options: [
        { value: '3h', label: '3 h' },
        { value: '24h', label: '24 h' },
        { value: '3j', label: '3 jours' },
      ],
      defaultValue: '24h',
    },
  ],

  legend() {
    return [
      { color: CSS, label: 'Une commune : le nombre de titres, écrit et par la taille', size: 'medium' },
      { color: 'transparent', label: 'Un département (titre sans commune) : anneau', size: 'medium' },
    ];
  },

  load: ({ signal }) => load(signal),

  summary({ data, time, settings }) {
    if (!data) return null;
    const spots = spotsAt(data, time, settings.age ?? '24h');
    const communes = spots.filter((s) => !s.place.isDept);
    const total = spots.reduce((sum, s) => sum + s.count, 0);
    return `${plural(total, 'titre')} dans ${plural(communes.length, 'commune')}${spots.length > communes.length ? ' et des départements' : ''}`;
  },

  deckLayers({ data, time, settings, selection, view, night }) {
    if (!data) return [];
    const spots = spotsAt(data, time, settings.age ?? '24h');
    const detail = view.zoom >= DETAIL_ZOOM;
    const points: Cluster[] = detail ? spots.map((s) => ({ lon: s.place.lon, lat: s.place.lat, count: s.count, spots: [s] })) : clustersOf(spots, view.zoom);
    const position = (c: Cluster): [number, number, number] => [c.lon, c.lat, 0];
    const single = (c: Cluster) => (c.spots.length === 1 ? c.spots[0]!.place : undefined);
    const isRing = (c: Cluster) => single(c)?.isDept === true;
    const fill = (c: Cluster): Color => (isRing(c) ? [...COLOR, 70] : [...COLOR, 255]);
    const chosen = selection ? selectedOf(selection as Selection, points) : undefined;
    const parameters = OVER_MAP;
    const named = view.zoom >= NAME_ZOOM ? declutter(points.filter((c) => !isRing(c)), view.zoom, { lon: (c) => c.lon, lat: (c) => c.lat, rank: (c) => -c.count, box: NAME_BOX_PX }) : [];
    const ink: Color = night > 0.5 ? [245, 247, 252, 255] : [22, 26, 38, 255];
    const outline: Color = night > 0.5 ? [20, 26, 38, 235] : [255, 255, 255, 235];
    return [
      new ScatterplotLayer<Cluster>({
        id: 'actualite/halo',
        data: points,
        getPosition: position,
        radiusUnits: 'pixels',
        getRadius: (c) => radiusOf(c.count) + 3,
        getFillColor: HALO,
        billboard: true,
        updateTriggers: { getRadius: [spots] },
        parameters,
      }),
      new ScatterplotLayer<Cluster>({
        id: 'actualite/points',
        data: points,
        getPosition: position,
        radiusUnits: 'pixels',
        getRadius: (c) => radiusOf(c.count),
        getFillColor: fill,
        stroked: true,
        getLineColor: (c) => (isRing(c) ? [...COLOR, 255] : KEY),
        lineWidthUnits: 'pixels',
        getLineWidth: (c) => (isRing(c) ? 3 : 1.5),
        billboard: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 120],
        updateTriggers: { getRadius: [spots], getFillColor: [spots], getLineColor: [spots] },
        parameters,
      }),
      new TextLayer<Cluster>({
        id: 'actualite/nombres',
        data: points,
        getPosition: position,
        getText: (c) => countText(c.count),
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        fontWeight: 700,
        getSize: (c) => (c.count >= 100 ? 12 : 13),
        getColor: (c) => (isRing(c) ? ink : [255, 255, 255, 255]),
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        billboard: true,
        characterSet: 'auto',
        updateTriggers: { getText: [spots], getColor: [night > 0.5] },
        parameters,
      }),
      named.length > 0 &&
        new TextLayer<Cluster>({
          id: 'actualite/noms',
          data: named,
          getPosition: position,
          getText: (c) => single(c)?.name ?? '',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 600,
          getSize: 12,
          getColor: ink,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'top',
          getPixelOffset: (c) => [0, radiusOf(c.count) + 5],
          outlineWidth: 3,
          outlineColor: outline,
          fontSettings: { sdf: true },
          billboard: true,
          characterSet: 'auto',
          parameters,
        }),
      chosen && selectionRing('actualite/choisi', [chosen], position, (c: Cluster) => radiusOf(c.count) + 4, parameters),
    ];
  },

  select(object) {
    const cluster = object as Cluster;
    if (cluster.spots.length === 1) return { place: cluster.spots[0]!.place.id };
    return { group: clusterId(cluster), lon: cluster.lon, lat: cluster.lat };
  },

  describe(selection, { data, time, settings }) {
    if (!data) return null;
    const age = settings.age ?? '24h';
    const picked = selection as Selection;
    if ('place' in picked) {
      const place = data.byId.get(picked.place);
      return place ? placeInfo(place, data, time, age) : null;
    }
    return clusterInfo(picked.group.slice(2).split(','), data, time, age);
  },

  focus(selection, { data }) {
    const picked = selection as Selection;
    if ('place' in picked) {
      const place = data?.byId.get(picked.place);
      return place ? { lon: place.lon, lat: place.lat, fixed: true } : null;
    }
    return { lon: picked.lon, lat: picked.lat, fixed: true };
  },
});

type Selection = { place: string } | { group: string; lon: number; lat: number };

/** Le point à cerner d'un anneau de sélection : la commune ou le groupe choisi, tel qu'il est dessiné maintenant. */
function selectedOf(selection: Selection, points: Cluster[]): Cluster | undefined {
  if ('place' in selection) return points.find((c) => c.spots.some((s) => s.place.id === selection.place));
  const ids = new Set(selection.group.slice(2).split(','));
  return points.find((c) => c.spots.length > 1 && c.spots.some((s) => ids.has(s.place.id)));
}
