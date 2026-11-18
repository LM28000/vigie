/**
 * Module « Neige et avalanches » : le bulletin d'estimation du risque d'avalanche (BRA) de chaque massif des Alpes, des Pyrénées
 * et de la Corse, et la hauteur de neige mesurée aux stations de Météo-France (API du portail Météo-France, relayées par le
 * serveur : `server/src/neige.rs`).
 *
 * - **Massifs** : aplat coloré selon le risque maximal du bulletin (échelle européenne, de 1 faible à 5 très fort, `AVALANCHE`),
 *   contour sombre, et une pastille avec **le chiffre** au centre du massif. La couleur ne porte jamais seule l'information : le
 *   chiffre est sur la carte, et le libellé (« marqué ») dans la légende et la fiche. Contours : fichier « Metadata massifs » de
 *   Météo-France (Licence Ouverte 2.0), embarqué (`src/data/massifs_bra.json`).
 * - **Stations de neige** : un point par station qui mesure la hauteur de neige au sol, de rose clair à foncé selon la hauteur
 *   (quatre classes), avec sa valeur en centimètres (étiquettes selon le zoom : les plus fortes hauteurs d'abord). À 0 cm, un petit
 *   rond gris sans étiquette, visible de plus près. Mesure de plus de 6 h : estompée.
 * - **Fiche d'un massif** : risque, risque par altitude et altitude de transition, rose des pentes dangereuses, évolution,
 *   enneigement, neige fraîche, textes du bulletin, validité, liens vers le bulletin officiel.
 * - **Hors saison** (les bulletins paraissent de novembre à mai environ) : les massifs sont là, grisés, « pas de bulletin en
 *   cours » ; ce n'est pas une erreur. Un bulletin dont la validité est finie depuis plus de 6 h est dit expiré.
 * - **Sans clé Météo-France** côté serveur : la couche le dit (« clé Météo-France absente »).
 *
 * La couche est en direct seulement : le serveur ne garde pas d'historique des bulletins.
 */
import { AVALANCHE, hexToRgb, NEIGE_NULLE, NEIGE_SOL, NEIGE_SOL_SEUILS, STATUS } from '../design/tokens';
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { measuredStatus, plainStatus, scheduledStatus } from '../core/infoStatus';
import { defineModule, type InfoContent, type InfoTable, type LegendItem } from '../core/module';
import { ModuleManager } from '../core/moduleManager';
import { firstSymbolLayerId } from '../map/baseMap';
import { declutter, halfZoomBreaks, zoomBand } from '../map/declutter';
import { OVER_MAP } from '../map/parameters';
import { formatDateTime, formatRelative, parisParts } from '../ui/format';
import { KEY, selectionRing, zoomRamp } from './symbols';
import { addSelectionRing, selectionRingIds, selectionRingLayers, setSelectionRingFilter } from './statusColors';
import massifsGeo from '../data/massifs_bra.json';

// --- Ce que sert le serveur (server/src/neige.rs) ---

interface ApiBulletin {
  issued: number;
  validUntil: number;
  amended: boolean;
  risk: number;
  riskLow?: number;
  riskHigh?: number;
  altitude?: number;
  evolLow?: number;
  evolHigh?: number;
  riskJ2?: number;
  riskJ2Date?: number;
  slopes: string[];
  snowLimitSouth?: number;
  snowLimitNorth?: number;
}

interface Massif {
  id: number;
  name: string;
  mountain: string;
  dep: string;
  lon: number;
  lat: number;
  b?: ApiBulletin;
}

interface SnowStation {
  id: string;
  name: string;
  lon: number;
  lat: number;
  alt?: number;
  /** Hauteur de neige au sol (cm) et heure de la mesure (secondes UTC). */
  cm: number;
  t: number;
}

export interface NeigeData {
  /** Raison pour laquelle la couche n'a rien à montrer (pas de clé, première collecte) : le serveur a répondu 503. */
  unavailable?: string;
  season: boolean;
  updatedAt: number;
  bulletinsAt?: number;
  stationsAt?: number;
  /** Pourquoi les hauteurs de neige manquent (abonnement Observation non accordé…). */
  stationsError?: string;
  massifs: Massif[];
  stations: SnowStation[];
  byMassif: Map<number, Massif>;
  byStation: Map<string, SnowStation>;
}

/** Le bulletin complet, relu à l'ouverture de la fiche (`/api/neige/{id}`). */
interface ApiDetail extends ApiBulletin {
  id: number;
  name: string;
  riskComment: string;
  slopesComment: string;
  accidental: string;
  natural: string;
  summary: string;
  riskJ2Text: string;
  riskJ2Comment: string;
  stabilityTitle: string;
  stabilityText: string;
  qualityText: string;
  snowLevels: Array<{ alt: number; n: number; s: number }>;
  freshAltitude?: number;
  fresh: Array<{ date: number; min?: number; max?: number; rr?: number }>;
}

type Selection = { id: number } | { st: string };

const SOURCE_ID = 'neige-massifs';
const FILL_ID = 'neige-massifs-fond';
const LINE_ID = 'neige-massifs-contour';
const LINE_NONE_ID = 'neige-massifs-sans-bulletin';
const SELECTED_ID = 'neige-massifs-choisi';

const INK = STATUS.ink;
/** Un bulletin n'est plus « en cours » 6 h après la fin de sa validité (comme le serveur). */
const GRACE_MS = 6 * 3600_000;
const DETAIL_TTL_MS = 10 * 60_000;
/** Une mesure de neige plus vieille que cela est grisée. */
const STATION_STALE_MS = 6 * 3600_000;

const WORD: Record<number, string> = { 1: 'faible', 2: 'limité', 3: 'marqué', 4: 'fort', 5: 'très fort' };
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Ce que dit l'échelle européenne pour chaque degré (résumé du guide avalanche de Météo-France). */
const RISK_TEXT: Record<number, string> = {
  1: 'Manteau neigeux bien stabilisé dans la plupart des pentes. Déclenchements d’avalanches improbables, sauf en terrain extrême.',
  2: 'Dans quelques pentes suffisamment raides, le manteau neigeux n’est que modérément stabilisé, ailleurs il est bien stabilisé. Déclenchements possibles surtout par forte surcharge, sur les pentes indiquées. Départs spontanés de grosses avalanches improbables.',
  3: 'Dans de nombreuses pentes suffisamment raides, le manteau neigeux n’est que modérément à faiblement stabilisé. Déclenchements possibles même par faible surcharge, surtout sur les pentes indiquées. Quelques départs spontanés d’avalanches de taille moyenne, voire grande, sont possibles dans certaines situations.',
  4: 'Dans la plupart des pentes suffisamment raides, le manteau neigeux est faiblement stabilisé. Déclenchements probables même par faible surcharge. Dans certaines situations, de nombreux départs spontanés d’avalanches de taille moyenne, parfois grande, sont à attendre.',
  5: 'Instabilité généralisée du manteau neigeux. De nombreuses et grosses avalanches spontanées sont à attendre, y compris en terrain peu raide.',
};

/** Les orientations du serveur (anglais : SW, W, NW) en français (SO, O, NO), et en toutes lettres. */
const ORIENTATION_FR: Record<string, string> = { N: 'N', NE: 'NE', E: 'E', SE: 'SE', S: 'S', SW: 'SO', W: 'O', NW: 'NO' };
const ORIENTATION_NAME: Record<string, string> = { N: 'nord', NE: 'nord-est', E: 'est', SE: 'sud-est', S: 'sud', SW: 'sud-ouest', W: 'ouest', NW: 'nord-ouest' };
const ORIENTATIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Risque en cours d'un massif : 0 sans bulletin en cours (hors saison, ou bulletin expiré depuis plus de 6 h). */
function riskOf(massif: Massif, now: number): number {
  const b = massif.b;
  return b && now <= b.validUntil * 1000 + GRACE_MS ? b.risk : 0;
}

// --- Pastilles de légende ---

const swatchCache = new Map<number, string>();
/** Carré de la couleur du degré, avec son chiffre (0 : massif sans bulletin, tireté gris). */
function swatch(level: number): string {
  const cached = swatchCache.get(level);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 28;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  if (level > 0) {
    ctx.fillStyle = AVALANCHE[level - 1]!;
    ctx.fillRect(2, 2, 24, 24);
  } else {
    ctx.fillStyle = 'rgba(138,143,156,0.25)';
    ctx.fillRect(2, 2, 24, 24);
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = level >= 4 ? 3 : 2;
  if (level === 0) ctx.setLineDash([3, 3]);
  ctx.strokeRect(2, 2, 24, 24);
  ctx.setLineDash([]);
  ctx.fillStyle = level >= 4 ? '#ffffff' : INK;
  ctx.font = '700 16px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(level > 0 ? String(level) : '–', 14, 15);
  const url = canvas.toDataURL();
  swatchCache.set(level, url);
  return url;
}

/** Classe de couleur d'une hauteur de neige (0 : 0 cm, pas de couleur de rampe). */
function snowClass(cm: number): number {
  let k = -1;
  NEIGE_SOL_SEUILS.forEach((min, i) => {
    if (cm >= min) k = i;
  });
  return k;
}

const snowSwatches = new Map<string, string>();
/** Point de station pour la légende : plein de la couleur de la classe, ou creux et gris (0 cm), estompé si `faded`. */
function snowSwatch(cls: number, faded = false): string {
  const key = `${cls}${faded ? 'f' : ''}`;
  const cached = snowSwatches.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 28;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.globalAlpha = faded ? 0.45 : 1;
  const radius = cls < 0 ? 5 : 8;
  if (cls >= 0) {
    ctx.beginPath();
    ctx.arc(14, 14, radius + 2, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(14, 14, radius, 0, Math.PI * 2);
  ctx.fillStyle = cls >= 0 ? NEIGE_SOL[cls]! : 'rgba(255,255,255,0.85)';
  ctx.fill();
  ctx.lineWidth = cls >= 0 ? 1.6 : 1.8;
  ctx.strokeStyle = cls >= 0 ? STATUS.ink : NEIGE_NULLE;
  ctx.stroke();
  const url = canvas.toDataURL();
  snowSwatches.set(key, url);
  return url;
}

// --- Rose des pentes dangereuses (SVG) ---

/**
 * La rose des pentes : huit secteurs (N en haut), ceux des orientations dangereuses pleins de la couleur du risque, les autres
 * vides. Sur un fond blanc de sa propre : lisible sur la fiche claire comme sombre.
 */
function slopeRose(slopes: string[], risk: number): string {
  const cx = 70;
  const cy = 70;
  const outer = 46;
  const inner = 15;
  const color = AVALANCHE[Math.min(Math.max(risk, 1), 5) - 1]!;
  const point = (radius: number, deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return `${(cx + radius * Math.cos(rad)).toFixed(1)} ${(cy + radius * Math.sin(rad)).toFixed(1)}`;
  };
  const sectors = ORIENTATIONS.map((name, i) => {
    const from = i * 45 - 22.5 + 1.5;
    const to = i * 45 + 22.5 - 1.5;
    const on = slopes.includes(name);
    const d = `M${point(inner, from)}L${point(outer, from)}A${outer} ${outer} 0 0 1 ${point(outer, to)}L${point(inner, to)}A${inner} ${inner} 0 0 0 ${point(inner, from)}Z`;
    return `<path d="${d}" fill="${on ? color : '#eef0f4'}" stroke="${on ? INK : '#9aa0ae'}" stroke-width="${on ? 1.6 : 1}"/>`;
  }).join('');
  const letters = ORIENTATIONS.map((name, i) => {
    const [x, y] = point(58, i * 45).split(' ');
    const on = slopes.includes(name);
    return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-size="${name.length > 1 ? 9 : 11}" font-weight="${on ? 700 : 500}" fill="${on ? INK : '#6b7280'}">${ORIENTATION_FR[name]}</text>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="116" height="116" viewBox="0 0 140 140"><rect width="140" height="140" rx="12" fill="#ffffff"/>${sectors}${letters}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// --- Détail du bulletin, relu à l'ouverture de la fiche ---

interface DetailEntry {
  state: 'loading' | 'ready' | 'failed';
  at: number;
  bulletin?: ApiDetail;
}
const details = new Map<number, DetailEntry>();

function wakeCard(id: number): void {
  const manager = ModuleManager.current;
  const selection = manager?.getSelection();
  if (manager && selection?.moduleId === 'neige' && (selection.value as { id?: number }).id === id) manager.setSelection('neige', { id });
}

function ensureDetail(id: number): DetailEntry {
  const known = details.get(id);
  if (known && (known.state === 'loading' || Date.now() - known.at < DETAIL_TTL_MS)) return known;
  const entry: DetailEntry = { state: 'loading', at: Date.now(), bulletin: known?.bulletin };
  details.set(id, entry);
  void (async () => {
    try {
      const response = await fetch(`/api/neige/${id}`);
      if (!response.ok) throw new Error(String(response.status));
      details.set(id, { state: 'ready', at: Date.now(), bulletin: (await response.json()) as ApiDetail });
    } catch {
      details.set(id, { state: 'failed', at: Date.now(), bulletin: known?.bulletin });
    }
    wakeCard(id);
  })();
  return entry;
}

// --- Chargement ---

function unavailable(reason: string): NeigeData {
  return { unavailable: reason, season: false, updatedAt: Date.now() / 1000, massifs: [], stations: [], byMassif: new Map(), byStation: new Map() };
}

async function loadNeige(signal: AbortSignal): Promise<NeigeData> {
  const response = await fetch('/api/neige', { signal });
  if (response.status === 503) {
    const text = (await response.text()).toLowerCase();
    return unavailable(text.includes('clé') ? 'clé Météo-France absente' : 'le serveur récupère encore les bulletins');
  }
  if (!response.ok) throw new Error(`le serveur de la neige a répondu ${response.status}`);
  const json = (await response.json()) as Omit<NeigeData, 'byMassif' | 'byStation' | 'unavailable'>;
  return { ...json, byMassif: new Map(json.massifs.map((m) => [m.id, m])), byStation: new Map(json.stations.map((s) => [s.id, s])) };
}

// --- Couche native : les massifs ---

const geo = massifsGeo as unknown as { features: Array<{ type: 'Feature'; properties: { code: number; name: string }; geometry: unknown }> };

let shown: { data: NeigeData; step: number } | undefined;

function colored(data: NeigeData, now: number) {
  return {
    type: 'FeatureCollection' as const,
    features: geo.features.map((f) => ({ ...f, properties: { code: f.properties.code, name: f.properties.name, risk: data.byMassif.get(f.properties.code) ? riskOf(data.byMassif.get(f.properties.code)!, now) : 0 } })),
  };
}

const byRisk = (values: [number, number, number, number, number], none: number) => ['match', ['get', 'risk'], 1, values[0], 2, values[1], 3, values[2], 4, values[3], 5, values[4], none] as never;

// --- Étiquettes ---

interface Badge {
  massif: Massif;
  risk: number;
}

const NAME_BOX_PX = { width: 150, height: 28 };
const STATION_BOX_PX = { width: 72, height: 24 };
/** Hauteur minimale (cm) d'une station étiquetée selon le zoom : les fortes hauteurs d'abord, toutes celles qui ont de la neige ensuite. */
function labelFloor(zoom: number): number {
  return zoom >= 8.5 ? 1 : zoom >= 7 ? 30 : Infinity;
}

let badgeCache: { data: NeigeData; step: number; badges: Badge[] } | undefined;
function badgesOf(data: NeigeData, step: number): Badge[] {
  if (badgeCache?.data !== data || badgeCache.step !== step) {
    const now = Date.now();
    badgeCache = { data, step, badges: data.massifs.map((massif) => ({ massif, risk: riskOf(massif, now) })) };
  }
  return badgeCache.badges;
}

let labelCache: { badges: Badge[]; band: number; names: Badge[]; stations: SnowStation[]; stationSource: SnowStation[] } | undefined;
function labelled(badges: Badge[], stations: SnowStation[], zoom: number) {
  const band = zoomBand(zoom);
  if (labelCache?.badges !== badges || labelCache.band !== band || labelCache.stationSource !== stations) {
    labelCache = {
      badges,
      band,
      stationSource: stations,
      names: zoom >= 7 ? declutter(badges, zoom, { lon: (b) => b.massif.lon, lat: (b) => b.massif.lat, rank: (b) => -b.risk, box: NAME_BOX_PX }) : [],
      stations: Number.isFinite(labelFloor(zoom))
        ? declutter(stations.filter((s) => s.cm >= labelFloor(zoom)), zoom, { lon: (s) => s.lon, lat: (s) => s.lat, rank: (s) => -s.cm, box: STATION_BOX_PX })
        : [],
    };
  }
  return labelCache;
}

const dayFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });
const shortDay = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric' });
const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

/** Texte d'une liste d'orientations : « nord, nord-est et ouest ». */
function orientationText(slopes: string[]): string {
  if (slopes.length === 0) return 'aucune signalée';
  if (slopes.length === 8) return 'toutes les orientations';
  const names = ORIENTATIONS.filter((o) => slopes.includes(o)).map((o) => ORIENTATION_NAME[o]!);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} et ${names.at(-1)}` : names[0]!;
}

/** Les deux ou trois premières phrases d'un texte de bulletin (la fiche n'est pas le bulletin). */
function lead(text: string, max = 320): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.'));
  return stop > 80 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

const OFFICIAL = { label: 'Bulletin officiel sur Météo-France', href: 'https://meteofrance.com/meteo-montagne' };

function pdfArchive(issuedS: number) {
  const p = parisParts(issuedS * 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  return { label: 'Bulletins PDF du jour (archive Météo-France)', href: `https://files.data.gouv.fr/meteofrance/data/BULLETIN/BRA/${p.year}/${two(p.month)}/${two(p.day)}/pdf/` };
}

export const neige = defineModule<NeigeData>({
  id: 'neige',
  name: 'Neige et avalanches',
  category: 'environnement',
  description:
    'Risque d’avalanche de 1 à 5 par massif (Alpes, Pyrénées, Corse) d’après le bulletin de Météo-France, avec altitude de transition, pentes dangereuses et enneigement, et hauteur de neige aux stations. Les bulletins paraissent de novembre à mai environ.',
  attribution: 'Météo-France, bulletins d’estimation du risque d’avalanche et observations (Licence Ouverte 2.0) · contours des massifs : Météo-France',
  refreshIntervalMs: 10 * 60_000,
  timeStepMs: 300_000,
  followsTerrain: true,
  zoomBreaks: [6, 7, 8.5, ...halfZoomBreaks(9)],

  legend(_settings, data) {
    if (data?.unavailable) return [];
    const items: LegendItem[] = [5, 4, 3, 2, 1].map((level) => ({ color: AVALANCHE[level - 1]!, icon: swatch(level), label: `Risque ${level} sur 5 : ${WORD[level]}${level >= 4 ? ' (pastille blanche sur fond foncé)' : ''}` }));
    items.push({ color: '#8a8f9c', icon: swatch(0), label: 'Massif sans bulletin en cours (hors saison)' });
    if (!data?.stationsError) {
      const labels = ['70 cm et plus', '30 à 69 cm', '10 à 29 cm', '1 à 9 cm'];
      for (const cls of [3, 2, 1, 0]) items.push({ color: NEIGE_SOL[cls]!, icon: snowSwatch(cls), label: `Station : ${labels[3 - cls]} de neige au sol` });
      items.push({ color: NEIGE_NULLE, icon: snowSwatch(-1), label: 'Station sans neige au sol (0 cm), sans étiquette' });
      items.push({ color: NEIGE_NULLE, icon: snowSwatch(1, true), label: 'Estompée : mesure de plus de 6 h' });
    }
    return items;
  },

  load: ({ signal }) => loadNeige(signal),

  summary({ data }) {
    if (!data) return null;
    if (data.unavailable) return `Indisponible : ${data.unavailable}`;
    const now = Date.now();
    const risks = data.massifs.map((m) => riskOf(m, now));
    const withBulletin = risks.filter((r) => r > 0).length;
    const snow = data.stations.filter((s) => s.cm > 0).length;
    const stationText = data.stationsError ? ` · hauteurs de neige indisponibles (${data.stationsError})` : data.stations.length > 0 ? ` · neige au sol à ${snow} station${snow > 1 ? 's' : ''} sur ${data.stations.length}` : '';
    if (withBulletin === 0) return `Pas de bulletin en cours (les bulletins paraissent de novembre à mai environ)${stationText}`;
    const high = risks.filter((r) => r >= 4).length;
    const marked = risks.filter((r) => r === 3).length;
    return `${withBulletin} massifs avec bulletin · ${high} en risque fort ou très fort (4-5), ${marked} en risque marqué (3)${stationText}`;
  },

  native: {
    add(map: MapLibreMap) {
      shown = undefined;
      map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      const before = firstSymbolLayerId(map);
      map.addLayer(
        {
          id: FILL_ID,
          type: 'fill',
          source: SOURCE_ID,
          paint: {
            'fill-color': ['match', ['get', 'risk'], 1, AVALANCHE[0], 2, AVALANCHE[1], 3, AVALANCHE[2], 4, AVALANCHE[3], 5, AVALANCHE[4], '#8a8f9c'] as never,
            'fill-opacity': byRisk([0.5, 0.55, 0.6, 0.68, 0.78], 0.16),
          },
        },
        before,
      );
      map.addLayer(
        {
          id: LINE_ID,
          type: 'line',
          source: SOURCE_ID,
          filter: ['>=', ['get', 'risk'], 1],
          layout: { 'line-join': 'round' },
          paint: {
            'line-color': INK,
            'line-opacity': 0.85,
            'line-width': ['interpolate', ['linear'], ['zoom'], 5, byRisk([0.8, 0.9, 1.1, 1.8, 2.4], 0.8), 9, byRisk([1.2, 1.4, 1.8, 3, 4], 1.2)] as never,
          },
        },
        before,
      );
      // Sans bulletin : contour tireté gris, pour que le massif reste lisible (le tireté ne se règle pas par objet : couche à part).
      map.addLayer(
        {
          id: LINE_NONE_ID,
          type: 'line',
          source: SOURCE_ID,
          filter: ['==', ['get', 'risk'], 0],
          layout: { 'line-join': 'round' },
          paint: { 'line-color': '#6b7280', 'line-opacity': 0.8, 'line-width': 1.2, 'line-dasharray': [2, 2] },
        },
        before,
      );
      addSelectionRing(map, selectionRingLayers(SELECTED_ID, SOURCE_ID, ['==', ['get', 'code'], -1], [[5, 2], [9, 4]], undefined, { 'line-join': 'round' }), before);
    },
    update(map, { data, selection }) {
      const step = Math.floor(Date.now() / 300_000);
      if (data && (!shown || shown.data !== data || shown.step !== step)) {
        (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(colored(data, Date.now()) as unknown as Parameters<GeoJSONSource['setData']>[0]);
        shown = { data, step };
      }
      const id = selection && 'id' in (selection as Selection) ? (selection as { id: number }).id : -1;
      setSelectionRingFilter(map, SELECTED_ID, ['==', ['get', 'code'], id]);
    },
    remove(map) {
      for (const id of [...selectionRingIds(SELECTED_ID), LINE_NONE_ID, LINE_ID, FILL_ID]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      shown = undefined;
    },
    pickable: {
      layerIds: [FILL_ID],
      toObject: (feature) => ({ massifId: Number(feature.properties?.code ?? -1) }),
    },
  },

  deckLayers({ data, selection, terrain, view }) {
    if (!data || data.unavailable) return [];
    const step = Math.floor(Date.now() / 300_000);
    const badges = badgesOf(data, step);
    const labels = labelled(badges, data.stations, view.zoom);
    const onGround = (lon: number, lat: number): [number, number, number] => [lon, lat, terrain.elevation(lon, lat)];
    const pastille = zoomRamp(view.zoom, 5, 9, 12, 17);
    const stationSize = zoomRamp(view.zoom, 6, 10, 3.5, 7.5);
    const now = Date.now();
    const stale = (s: SnowStation) => now - s.t * 1000 > STATION_STALE_MS;
    // Les stations sans neige (0 cm) ne s'affichent qu'à partir d'un zoom où elles ne font plus de bruit.
    const shownStations = view.zoom >= 8 ? data.stations : data.stations.filter((s) => s.cm > 0);
    const snowy = shownStations.filter((s) => s.cm > 0);
    const haloSize = stationSize + 2;
    const chosen = selection as Selection | null;
    const chosenStation = chosen && 'st' in chosen ? data.stations.filter((s) => s.id === chosen.st) : [];
    return [
      // Halo blanc sous les stations avec neige : le point reste lisible sur les aplats foncés du risque (4, 5) comme sur le fond de nuit.
      new ScatterplotLayer<SnowStation>({
        id: 'neige/stations-halo',
        data: snowy,
        getPosition: (s) => onGround(s.lon, s.lat),
        getRadius: haloSize,
        radiusUnits: 'pixels',
        getFillColor: (s) => [255, 255, 255, stale(s) ? 120 : 235],
        stroked: false,
        pickable: false,
        parameters: OVER_MAP,
        updateTriggers: { getPosition: terrain.version, getRadius: stationSize, getFillColor: step },
      }),
      new ScatterplotLayer<SnowStation>({
        id: 'neige/stations',
        data: shownStations,
        getPosition: (s) => onGround(s.lon, s.lat),
        getRadius: (s) => (s.cm > 0 ? stationSize : stationSize * 0.62),
        radiusUnits: 'pixels',
        // Plein de la couleur de la classe de hauteur ; 0 cm : petit rond clair à liseré gris ; estompé si la mesure est ancienne.
        getFillColor: (s) => {
          const cls = snowClass(s.cm);
          return cls < 0 ? [255, 255, 255, stale(s) ? 60 : 150] : [...hexToRgb(NEIGE_SOL[cls]!), stale(s) ? 120 : 255];
        },
        getLineColor: (s) => (s.cm > 0 ? [...hexToRgb(STATUS.ink), stale(s) ? 110 : 255] : [...hexToRgb(NEIGE_NULLE), stale(s) ? 90 : 190]),
        stroked: true,
        filled: true,
        lineWidthUnits: 'pixels',
        getLineWidth: (s) => (s.cm > 0 ? 1.6 : 1.2),
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 140],
        parameters: OVER_MAP,
        updateTriggers: { getPosition: terrain.version, getRadius: stationSize, getFillColor: step, getLineColor: step },
      }),
      labels.stations.length > 0 &&
        new TextLayer<SnowStation>({
          id: 'neige/hauteurs',
          data: labels.stations,
          getPosition: (s) => onGround(s.lon, s.lat),
          getText: (s) => `${nf.format(s.cm)} cm`,
          characterSet: 'auto',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 700,
          getSize: 11,
          getColor: (s) => [20, 26, 38, stale(s) ? 140 : 255],
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'top',
          getPixelOffset: [0, stationSize + 4],
          background: true,
          getBackgroundColor: (s) => [255, 255, 255, stale(s) ? 170 : 240],
          getBorderColor: (s) => [...hexToRgb(NEIGE_SOL[Math.max(snowClass(s.cm), 0)]!), stale(s) ? 120 : 255],
          getBorderWidth: 1.4,
          backgroundBorderRadius: 8,
          backgroundPadding: [5, 2],
          billboard: true,
          pickable: true,
          updateTriggers: { getPosition: terrain.version, getPixelOffset: stationSize, getColor: step, getBackgroundColor: step, getBorderColor: step },
          parameters: OVER_MAP,
        }),
      labels.names.length > 0 &&
        new TextLayer<Badge>({
          id: 'neige/noms',
          data: labels.names,
          getPosition: (b) => onGround(b.massif.lon, b.massif.lat),
          getText: (b) => b.massif.name,
          characterSet: 'auto',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 600,
          getSize: 11.5,
          getColor: KEY,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'top',
          getPixelOffset: [0, pastille + 4],
          background: true,
          getBackgroundColor: [255, 255, 255, 215],
          backgroundBorderRadius: 6,
          backgroundPadding: [5, 1],
          billboard: true,
          pickable: true,
          updateTriggers: { getPosition: terrain.version, getPixelOffset: pastille },
          parameters: OVER_MAP,
        }),
      // La pastille du massif : le chiffre du risque (« – » sans bulletin), sur la couleur du degré.
      new TextLayer<Badge>({
        id: 'neige/risques',
        data: badges.filter((b) => view.zoom >= 6.3 || b.risk >= 3),
        getPosition: (b) => onGround(b.massif.lon, b.massif.lat),
        getText: (b) => (b.risk > 0 ? String(b.risk) : '–'),
        characterSet: 'auto',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        fontWeight: 800,
        getSize: pastille,
        getColor: (b) => (b.risk >= 4 ? [255, 255, 255, 255] : KEY),
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        background: true,
        getBackgroundColor: (b) => {
          if (b.risk === 0) return [238, 240, 244, 235];
          const hex = AVALANCHE[b.risk - 1]!;
          return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];
        },
        getBorderColor: [22, 26, 38, 255],
        getBorderWidth: 1.6,
        backgroundBorderRadius: 9,
        backgroundPadding: [6, 2],
        billboard: true,
        pickable: true,
        updateTriggers: { getPosition: terrain.version, getText: step, getColor: step, getBackgroundColor: step, getSize: pastille },
        parameters: OVER_MAP,
      }),
      chosenStation.length > 0 && selectionRing('neige/choisi', chosenStation, (s) => onGround(s.lon, s.lat), stationSize + 5, OVER_MAP),
    ];
  },

  select(object) {
    const o = object as { massifId?: number; massif?: Massif; id?: string; cm?: number };
    if (o.massifId !== undefined) return o.massifId >= 0 ? { id: o.massifId } : null;
    if (o.massif) return { id: o.massif.id };
    if (typeof o.id === 'string' && o.cm !== undefined) return { st: o.id };
    return null;
  },

  focus(selection, { data }) {
    const sel = selection as Selection;
    if ('st' in sel) {
      const s = data?.byStation.get(sel.st);
      return s ? { lon: s.lon, lat: s.lat, fixed: true } : null;
    }
    const m = data?.byMassif.get(sel.id) ?? massifFromGeo(sel.id);
    return m ? { lon: m.lon, lat: m.lat, fixed: true } : null;
  },

  describe(selection, { data, time }): InfoContent | null {
    if (!data) return null;
    const sel = selection as Selection;
    const now = Date.now();
    if ('st' in sel) return describeStation(data.byStation.get(sel.st), time, now);
    const massif = data.byMassif.get(sel.id);
    if (!massif) return null;
    return describeMassif(massif, now);
  },
});

/** Un massif connu seulement par ses contours (avant le premier chargement, ou sans clé) : de quoi centrer la carte. */
function massifFromGeo(id: number): { lon: number; lat: number } | undefined {
  const f = (massifsGeo as unknown as { features: Array<{ properties: { code: number; lon: number; lat: number } }> }).features.find((x) => x.properties.code === id);
  return f ? { lon: f.properties.lon, lat: f.properties.lat } : undefined;
}

function describeStation(s: SnowStation | undefined, time: number, now: number): InfoContent | null {
  if (!s) return null;
  const measuredAt = s.t * 1000;
  const old = now - measuredAt > STATION_STALE_MS;
  return {
    kind: s.name.endsWith('(Nivôse)') ? 'Station de haute montagne · neige au sol' : 'Station de mesure · neige au sol',
    title: s.name,
    subtitle: s.alt !== undefined ? `Altitude ${nf.format(s.alt)} m` : undefined,
    status: old ? plainStatus(`Mesure ancienne · ${formatRelative(measuredAt, now)}`) : measuredStatus(time, measuredAt),
    figures: [{ value: nf.format(s.cm), unit: 'cm', label: s.cm > 0 ? 'neige au sol' : 'pas de neige au sol' }],
    fields: [
      ['Dernière mesure', `${formatDateTime(measuredAt)} (heure de Paris), ${formatRelative(measuredAt, now)}`],
      ...(s.alt !== undefined ? ([['Altitude', `${nf.format(s.alt)} m`]] as Array<[string, string]>) : []),
    ],
    note:
      (s.name.endsWith('(Nivôse)') ? 'Station Nivôse : station automatique de haute montagne. ' : '') +
      'Hauteur totale de la couche de neige au sol, mesurée par la station automatique de Météo-France (observation horaire, brute, non validée). Seules les stations qui mesurent la neige sont montrées ; la hauteur à un endroit ne dit pas l’enneigement du massif alentour.' +
      (old ? ' Cette mesure date de plus de 6 h : la station n’a rien transmis depuis, elle est estompée sur la carte.' : ''),
    actions: [{ label: 'Observations sur Météo-France', href: 'https://meteofrance.com/meteo-montagne' }],
  };
}

function describeMassif(massif: Massif, now: number): InfoContent {
  const b = massif.b;
  const subtitle = `${massif.mountain} · ${massif.dep}`;
  const risk = riskOf(massif, now);
  if (!b || risk === 0) {
    const expired = !!b;
    return {
      kind: 'Massif · risque d’avalanche',
      title: massif.name,
      subtitle,
      status: plainStatus(expired ? `Bulletin expiré · dernier valable jusqu’au ${formatDateTime(b!.validUntil * 1000)}` : 'Pas de bulletin en cours'),
      figures: [{ value: '–', label: 'pas de bulletin en cours' }],
      note:
        'Météo-France rédige un bulletin d’estimation du risque d’avalanche (BRA) pour chaque massif de novembre à mai environ, chaque jour vers 16 h pour le lendemain, d’abord ponctuellement à l’automne puis tous les jours de la mi-décembre à la fin avril. En dehors de cette période, il n’y a pas de bulletin : ce n’est pas une erreur de la carte, et cela ne veut pas dire que le risque est nul.',
      actions: [OFFICIAL],
    };
  }
  const entry = ensureDetail(massif.id);
  const d = entry.bulletin;
  const split = b.riskLow !== undefined && b.riskHigh !== undefined && b.altitude !== undefined && b.riskLow !== b.riskHigh;

  const figures: InfoContent['figures'] = [{ value: `${risk}/5`, label: WORD[risk]! }];
  if (split) {
    figures.push({ value: String(b.riskLow), label: `sous ${nf.format(b.altitude!)} m · ${WORD[b.riskLow!]}` });
    figures.push({ value: String(b.riskHigh), label: `au-dessus · ${WORD[b.riskHigh!]}` });
  } else if (b.riskJ2 !== undefined && b.riskJ2Date !== undefined) {
    figures.push({ value: `${b.riskJ2}/5`, label: `${shortDay.format(b.riskJ2Date * 1000)} · ${WORD[b.riskJ2]}` });
  }

  const fields: Array<[string, string]> = [];
  if (split) fields.push(['Altitude de transition', `${nf.format(b.altitude!)} m : risque ${b.riskLow} (${WORD[b.riskLow!]}) en dessous, ${b.riskHigh} (${WORD[b.riskHigh!]}) au-dessus`]);
  fields.push(['Pentes les plus dangereuses', orientationText(b.slopes)]);
  if (b.evolLow !== undefined || b.evolHigh !== undefined) {
    const evol = [b.evolLow !== undefined ? `${b.evolLow} sous l’altitude de transition` : '', b.evolHigh !== undefined ? `${b.evolHigh} au-dessus` : ''].filter(Boolean).join(', ');
    fields.push(['Évolution dans la journée', `risque ${evol} en fin de journée`]);
  }
  if (split && b.riskJ2 !== undefined && b.riskJ2Date !== undefined) fields.push([`Risque du ${dayFormat.format(b.riskJ2Date * 1000)}`, `${b.riskJ2}/5 · ${WORD[b.riskJ2]}`]);
  const limits = [b.snowLimitNorth !== undefined && b.snowLimitNorth > 0 ? `${nf.format(b.snowLimitNorth)} m en versant nord` : '', b.snowLimitSouth !== undefined && b.snowLimitSouth > 0 ? `${nf.format(b.snowLimitSouth)} m en versant sud` : ''].filter(Boolean);
  if (limits.length) fields.push(['Limite de la neige', limits.join(', ')]);
  if (d) {
    if (d.riskComment) fields.push(['Précision du risque', d.riskComment]);
    if (d.accidental) fields.push(['Déclenchements accidentels', lead(d.accidental)]);
    if (d.natural) fields.push(['Départs spontanés', lead(d.natural)]);
    if (d.stabilityTitle) fields.push(['Stabilité du manteau', lead(d.stabilityTitle)]);
    if (d.qualityText) fields.push(['Enneigement', lead(d.qualityText)]);
    if (d.slopesComment) fields.push(['Pentes, précision', d.slopesComment]);
  } else if (entry.state === 'loading') fields.push(['Détail du bulletin', 'chargement…']);
  else if (entry.state === 'failed') fields.push(['Détail du bulletin', 'indisponible pour l’instant']);
  fields.push(['Rédigé', formatDateTime(b.issued * 1000) + (b.amended ? ' · bulletin amendé' : '')]);
  fields.push(['Valable jusqu’au', formatDateTime(b.validUntil * 1000)]);

  const tables: InfoTable[] = [];
  if (d && d.snowLevels.length > 0) {
    tables.push({
      title: 'Épaisseur de neige par altitude (cm)',
      columns: ['Altitude', 'Versant nord', 'Versant sud'],
      rows: [...d.snowLevels].sort((a, c) => c.alt - a.alt).map((l) => ({ cells: [`${nf.format(l.alt)} m`, nf.format(l.n), nf.format(l.s)] })),
    });
  }
  if (d && d.fresh.length > 0) {
    tables.push({
      title: `Neige fraîche en 24 h${d.freshAltitude ? ` à ${nf.format(d.freshAltitude)} m` : ''}`,
      columns: ['Jour', 'Neige (cm)', 'Eau (mm)'],
      rows: d.fresh.map((f) => ({
        cells: [cap(shortDay.format(f.date * 1000)), f.min !== undefined && f.max !== undefined ? (f.min === f.max ? nf.format(f.min) : `${nf.format(f.min)} à ${nf.format(f.max)}`) : '–', f.rr !== undefined ? nf.format(f.rr) : '–'],
        tone: f.date * 1000 < now - 24 * 3600_000 ? ('muted' as const) : undefined,
      })),
    });
  }

  const content: InfoContent = {
    kind: `Massif · risque d’avalanche ${risk} sur 5 · ${WORD[risk]}`,
    title: massif.name,
    subtitle,
    // Un bulletin est une estimation de Météo-France, pas une mesure : point gris.
    status: scheduledStatus(`Bulletin du ${formatDateTime(b.issued * 1000)} · valable jusqu’au ${formatDateTime(b.validUntil * 1000)}`),
    figures,
    fields,
    tables,
    note:
      `Risque ${risk} sur 5, ${WORD[risk]}. ${RISK_TEXT[risk]} ` +
      'Échelle européenne du risque d’avalanche ; le risque est une estimation par massif, pas une prévision pour une pente donnée : le bulletin officiel et un jugement sur le terrain restent indispensables.',
    actions: [OFFICIAL, pdfArchive(b.issued)],
  };
  // La rose des pentes dangereuses, en image (SVG sous forme d'adresse de données) : les orientations sont aussi dites en texte, plus haut.
  if (b.slopes.length > 0) {
    content.image = {
      src: slopeRose(b.slopes, risk),
      alt: `Rose des pentes dangereuses : ${orientationText(b.slopes)}.`,
      time: b.issued * 1000,
      credit: 'Rose des pentes dangereuses',
    };
  }
  return content;
}
