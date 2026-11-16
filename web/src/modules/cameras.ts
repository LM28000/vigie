/**
 * Module « Caméras » : deux familles, chacune avec son réglage d'affichage.
 *
 * 1. **Vidéoprotection d'OpenStreetMap** : les points `man_made=surveillance` de la France métropolitaine
 *    (environ 80 000), extraits chaque semaine par le serveur (server/src/cameras.rs). Un point par caméra
 *    à partir du zoom 11 ; de près (zoom 15), un **cône de vision** posé sur le relief quand la direction est
 *    connue (secteur de 60°, 120° pour une caméra panoramique, portée de 35 m, ou déduite de la hauteur et de
 *    l'inclinaison `camera:angle`), un cercle pour un dôme sans direction ; à partir du zoom 16, le volume du
 *    cône, de la caméra au sol.
 * 2. **Webcams publiques** : Windy Webcams (clé `WINDY_WEBCAMS_KEY` côté serveur seulement) et les
 *    caméras de trafic Criter de la Métropole de Lyon (données ouvertes), avec, en plus, quelques webcams d'Orléans et d'Anglet
 *    dont les jeux ouverts ne donnent que la page (fiche sans image, lien vers la page). La fiche montre l'image, rechargée
 *    toute seule tant qu'elle est ouverte, jamais agrandie, avec un lien vers la page de la webcam.
 *
 * Les couleurs : des symboles noir et blanc, comme les monuments (aucune teinte de plus sur une carte déjà
 * chargée) ; seul le cône est jaune, la couleur des panneaux « vidéoprotection », un peu transparent, gris pour
 * un lieu privé ou intérieur. Le rond sombre est une webcam, le carré sombre une caméra de trafic.
 */
import type { LayersList, Position } from '@deck.gl/core';
import { IconLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer } from '@deck.gl/layers';
import { plainStatus } from '../core/infoStatus';
import { defineModule, type InfoContent, type LegendItem, type TerrainSampler } from '../core/module';
import { declutter, halfZoomBreaks, zoomBand } from '../map/declutter';
import { OVER_MAP } from '../map/parameters';
import { HALO_CSS, KEY, KEY_CSS, ink, packIcons, selectionRing, type IconSheet, zoomRamp } from './symbols';

// --- Données ---

/** Une caméra de vidéoprotection d'OpenStreetMap (tableau de 12 cases, voir `cameras.rs`). */
export interface OsmCamera {
  id: number;
  lon: number;
  lat: number;
  /** 0 caméra, 1 lecture de plaques. */
  kind: number;
  /** 0 fixe, 1 dôme, 2 panoramique, 3 autre, 4 inconnu. */
  type: number;
  /** Direction en degrés depuis le nord, `null` si inconnue. */
  dir: number | null;
  /** Inclinaison sous l'horizontale (degrés), `null` si inconnue. */
  tilt: number | null;
  /** 0 espace public, 1 extérieur privé, 2 intérieur, 3 privé, 4 inconnu. */
  level: number;
  zone: number;
  mount: number;
  /** Hauteur de fixation (m). */
  height: number | null;
  operator: string;
}

type OsmRow = [number, number, number, number, number, number | null, number | null, number, number, number, number | null, string];

export interface WebcamWindy {
  id: number;
  lon: number;
  lat: number;
  title: string;
  city: string;
  detail: string;
}

/** Webcam d'un jeu ouvert (Orléans Métropole, Anglet) : une position et la page de la webcam, pas d'image. */
export interface WebcamOpen {
  id: number;
  lon: number;
  lat: number;
  name: string;
  town: string;
  /** Page de la webcam, chez son éditeur. */
  page: string;
  /** Qui publie le jeu de données : « Orléans Métropole », « Commune d'Anglet ». */
  source: string;
}

export interface CameraCriter {
  id: number;
  lon: number;
  lat: number;
  name: string;
  place: string;
  observation: string;
  image: string;
  /** Heure de l'image (ms). */
  time: number;
}

type Family = 'osm' | 'windy' | 'criter' | 'open';

export interface CamerasData {
  osm?: { list: OsmCamera[]; byId: Map<number, OsmCamera>; updatedAt: number };
  windy?: { active: boolean; reason: string; list: WebcamWindy[]; byId: Map<number, WebcamWindy> };
  criter?: { list: CameraCriter[]; byId: Map<number, CameraCriter>; updatedAt: number };
  open?: { list: WebcamOpen[]; byId: Map<number, WebcamOpen> };
  /** Dernier échec de chaque source (instant en ms) : on ne réessaie pas en boucle. */
  failedAt: Partial<Record<Family, number>>;
}

const DAY = 24 * 3600_000;
/** Mémoire des sources lentes entre deux chargements (la couche se recharge chaque minute pour Criter). */
const cache: {
  osm?: { at: number; value: NonNullable<CamerasData['osm']> };
  windy?: { at: number; value: NonNullable<CamerasData['windy']> };
  open?: { at: number; value: NonNullable<CamerasData['open']> };
} = {};

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url} : le serveur a répondu ${response.status}`);
  return (await response.json()) as T;
}

async function loadOsm(signal: AbortSignal): Promise<NonNullable<CamerasData['osm']>> {
  const json = await getJson<{ updatedAt: number; cameras: OsmRow[] }>('/api/cameras', signal);
  const list: OsmCamera[] = json.cameras.map(([id, lon, lat, kind, type, dir, tilt, level, zone, mount, height, operator]) => ({
    id, lon, lat, kind, type, dir, tilt, level, zone, mount, height, operator,
  }));
  return { list, byId: new Map(list.map((c) => [c.id, c])), updatedAt: json.updatedAt * 1000 };
}

async function loadWindy(signal: AbortSignal): Promise<NonNullable<CamerasData['windy']>> {
  const json = await getJson<{ actif: boolean; raison?: string; webcams: Array<[number, number, number, string, string, string]> }>('/api/webcams/windy', signal);
  const list: WebcamWindy[] = json.webcams.map(([id, lon, lat, title, city, detail]) => ({ id, lon, lat, title, city, detail }));
  return { active: json.actif, reason: json.raison ?? '', list, byId: new Map(list.map((w) => [w.id, w])) };
}

async function loadCriter(signal: AbortSignal): Promise<NonNullable<CamerasData['criter']>> {
  const json = await getJson<{ updatedAt: number; cameras: Array<[number, number, number, string, string, string, string, number]> }>('/api/webcams/criter', signal);
  const list: CameraCriter[] = json.cameras.map(([id, lon, lat, name, place, observation, image, time]) => ({
    id, lon, lat, name, place, observation, image, time: time * 1000,
  }));
  return { list, byId: new Map(list.map((c) => [c.id, c])), updatedAt: json.updatedAt * 1000 };
}

async function loadOpen(signal: AbortSignal): Promise<NonNullable<CamerasData['open']>> {
  const json = await getJson<{ webcams: Array<[number, number, number, string, string, string, string]> }>('/api/webcams/ouvertes', signal);
  const list: WebcamOpen[] = json.webcams.map(([id, lon, lat, name, town, page, source]) => ({ id, lon, lat, name, town, page, source }));
  return { list, byId: new Map(list.map((w) => [w.id, w])) };
}

/** Familles que les réglages demandent d'afficher. */
function wanted(settings: Readonly<Record<string, string>>): Record<Family, boolean> {
  const webcams = settings.webcams ?? 'all';
  return { osm: (settings.osm ?? 'cones') !== 'off', windy: webcams === 'all', criter: webcams !== 'off', open: webcams !== 'off' };
}

// --- Libellés ---

const TYPE_LABELS = ['Caméra fixe', 'Caméra dôme', 'Caméra panoramique', 'Caméra', 'Caméra'];
const LEVEL_LABELS = ['Espace public', 'Extérieur privé', 'Intérieur', 'Lieu privé', 'Non précisé'];
const ZONE_LABELS = ['', 'ville ou rue', 'parking', 'circulation routière', 'commerce', 'banque', 'bâtiment ou entrée', 'gare ou quai', 'autre'];
const MOUNT_LABELS = ['', 'mur', 'poteau', 'plafond', 'lampadaire', 'feux tricolores', 'bâtiment ou toit', 'autre'];
const CARDINALS = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];

const typeLabel = (c: OsmCamera) => (c.kind === 1 ? 'Lecteur de plaques' : (TYPE_LABELS[c.type] ?? 'Caméra'));
/** Espace public ou voie : cône jaune ; lieu privé ou intérieur : gris. */
const isPublic = (c: OsmCamera) => c.level === 0 || c.zone === 3 || (c.level === 4 && c.zone === 1);

function directionText(degrees: number): string {
  return `${degrees}° (${CARDINALS[Math.round(degrees / 45) % 8]})`;
}

// --- Cônes de vision ---

/** Teintes du cône : jaune (espace public), gris (privé ou intérieur). Le contour reste sombre. */
const PUBLIC_RGB: [number, number, number] = [245, 181, 0];
const PRIVATE_RGB: [number, number, number] = [132, 140, 156];
const coneRgb = (c: OsmCamera) => (isPublic(c) ? PUBLIC_RGB : PRIVATE_RGB);

const CONE_ZOOM = 15;
const VOLUME_ZOOM = 16;
const POINT_ZOOM = 11;
/** Au plus ce nombre de cônes à la fois (les plus proches du centre de l'écran). */
const MAX_CONES = 1200;
const MAX_VOLUMES = 700;
const DEFAULT_RANGE_M = 35;
const DOME_RADIUS_M = 16;

/** Champ de vision horizontal : 60° (fixe, par défaut), 120° (panoramique : il balaie), 90° (dôme orienté). */
export function fieldOfView(c: OsmCamera): number {
  return c.type === 2 ? 120 : c.type === 1 ? 90 : 60;
}

/**
 * Portée au sol (m). `camera:angle` est l'inclinaison de la caméra sous l'horizontale : avec la hauteur de fixation,
 * l'axe touche le sol à `hauteur / tan(inclinaison)`. Sans ces deux valeurs : 35 m dehors, 12 m à l'intérieur.
 */
export function rangeMeters(c: OsmCamera): number {
  if (c.height != null && c.tilt != null && Math.abs(c.tilt) >= 10 && Math.abs(c.tilt) <= 80) {
    return Math.min(50, Math.max(8, c.height / Math.tan((Math.abs(c.tilt) * Math.PI) / 180)));
  }
  return c.level === 2 ? 12 : DEFAULT_RANGE_M;
}

/** Hauteur de la caméra au-dessus du sol (m) pour le volume du cône. */
const mountHeight = (c: OsmCamera) => c.height ?? (c.mount === 3 ? 2.5 : 5);

/** Cône ou cercle d'une caméra : l'anneau posé au sol, et les faces du volume (apex en l'air, base au sol). */
export interface Cone {
  camera: OsmCamera;
  ground: Position[];
  faces: Position[][];
  round: boolean;
}

/** Point à `meters` de (lon, lat), dans la direction `bearing` (degrés depuis le nord). */
function offset(lon: number, lat: number, bearing: number, meters: number): [number, number] {
  const rad = (bearing * Math.PI) / 180;
  const mPerDegLat = 111_320;
  return [lon + (meters * Math.sin(rad)) / (mPerDegLat * Math.cos((lat * Math.PI) / 180)), lat + (meters * Math.cos(rad)) / mPerDegLat];
}

/** Construit le cône (ou le cercle des dômes sans direction) d'une caméra, posé sur le relief. */
export function buildCone(c: OsmCamera, terrain: Pick<TerrainSampler, 'elevation'>, withVolume: boolean): Cone {
  const lift = 0.6;
  const z = (lon: number, lat: number) => terrain.elevation(lon, lat) + lift;
  const apexGround: Position = [c.lon, c.lat, z(c.lon, c.lat)];
  if (c.dir == null) {
    // Sans direction : un cercle (un dôme voit tout autour de lui).
    const ground: Position[] = Array.from({ length: 28 }, (_, i) => {
      const [lon, lat] = offset(c.lon, c.lat, (i * 360) / 28, DOME_RADIUS_M);
      return [lon, lat, z(lon, lat)];
    });
    return { camera: c, ground, faces: [], round: true };
  }
  const fov = fieldOfView(c);
  const range = rangeMeters(c);
  const steps = Math.max(5, Math.round(fov / 8));
  const arc: Position[] = Array.from({ length: steps + 1 }, (_, i) => {
    const [lon, lat] = offset(c.lon, c.lat, c.dir! - fov / 2 + (fov * i) / steps, range);
    return [lon, lat, z(lon, lat)];
  });
  const ground = [apexGround, ...arc];
  const faces: Position[][] = [];
  if (withVolume) {
    const apex: Position = [c.lon, c.lat, apexGround[2]! - lift + mountHeight(c)];
    for (let i = 0; i < steps; i++) faces.push([apex, arc[i]!, arc[i + 1]!]);
    faces.push([apex, apexGround, arc[0]!], [apex, apexGround, arc[steps]!]);
  }
  return { camera: c, ground, faces, round: false };
}

/** Les cônes à dessiner : les caméras de l'emprise, les plus proches du centre d'abord, au plus `max`. */
function conesInView(list: readonly OsmCamera[], bounds: readonly [number, number, number, number], terrain: TerrainSampler, withVolume: boolean): Cone[] {
  const [west, south, east, north] = bounds;
  const padLon = (east - west) * 0.1;
  const padLat = (north - south) * 0.1;
  const centerLon = (west + east) / 2;
  const centerLat = (south + north) / 2;
  const inside = list.filter(
    (c) => c.lon >= west - padLon && c.lon <= east + padLon && c.lat >= south - padLat && c.lat <= north + padLat && (c.dir != null || c.type === 1),
  );
  if (inside.length > MAX_CONES) {
    inside.sort((a, b) => (a.lon - centerLon) ** 2 + (a.lat - centerLat) ** 2 - ((b.lon - centerLon) ** 2 + (b.lat - centerLat) ** 2));
    inside.length = MAX_CONES;
  }
  return inside.map((c, i) => buildCone(c, terrain, withVolume && i < MAX_VOLUMES));
}

// --- Pictogrammes des webcams ---

const CELL = 64;
const BADGE = 24;

/** Une caméra de dessin : boîtier arrondi, objectif, petit pied. Tracée en blanc sur le badge sombre. */
function drawCameraGlyph(c: CanvasRenderingContext2D): void {
  c.beginPath();
  c.roundRect(-11, -7, 22, 15, 3);
  c.moveTo(-5, -7);
  c.lineTo(-3, -11);
  c.lineTo(3, -11);
  c.lineTo(5, -7);
  c.moveTo(5, 0.5);
  c.arc(0, 0.5, 5, 0, Math.PI * 2);
}

function drawBadge(c: CanvasRenderingContext2D, square: boolean): void {
  c.translate(CELL / 2, CELL / 2);
  ink(
    c,
    (ctx) => {
      ctx.beginPath();
      if (square) ctx.roundRect(-BADGE, -BADGE, BADGE * 2, BADGE * 2, 7);
      else ctx.arc(0, 0, BADGE, 0, Math.PI * 2);
    },
    KEY_CSS,
    { key: 3, halo: 2.6 },
  );
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.scale(0.95, 0.95);
  drawCameraGlyph(c);
  c.strokeStyle = '#ffffff';
  c.lineWidth = 2.8;
  c.stroke();
}

let sheet: IconSheet | undefined;
function icons(): IconSheet {
  sheet ??= packIcons(
    [
      ['webcam', false],
      ['trafic', true],
    ].map(([key, square]) => ({ key: key as string, width: CELL, height: CELL, draw: (c: CanvasRenderingContext2D) => drawBadge(c, square as boolean) })),
  );
  return sheet;
}

// --- Désencombrement des webcams ---

/** Sous ce zoom, une webcam par case de 24 px ; au-dessus, toutes. */
const ALL_WEBCAMS_ZOOM = 11;

let sparseCache: { list: readonly WebcamWindy[]; band: number; items: WebcamWindy[] } | undefined;
function sparseWindy(list: readonly WebcamWindy[], zoom: number): WebcamWindy[] {
  if (zoom >= ALL_WEBCAMS_ZOOM) return list as WebcamWindy[];
  const band = zoomBand(zoom);
  if (sparseCache?.list !== list || sparseCache.band !== band) {
    sparseCache = { list, band, items: declutter(list, zoom, { lon: (w) => w.lon, lat: (w) => w.lat, rank: (w) => w.id, box: { width: 24, height: 24 } }) };
  }
  return sparseCache.items;
}

// --- Sélection ---

interface Chosen {
  family: Family;
  id: number;
}

// --- Module ---

const FRENCH_DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const CRITER_DATASET = 'https://www.data.gouv.fr/datasets/cameras-web-criter-de-la-metropole-de-lyon';

export const cameras = defineModule<CamerasData>({
  id: 'cameras',
  name: 'Caméras',
  category: 'territoire',
  description:
    'Les caméras de vidéoprotection d’OpenStreetMap, avec leur cône de vision quand leur direction est connue, et des webcams publiques avec leur image (Windy, Criter à Lyon) ou leur page (Orléans, Anglet).',
  attribution:
    'Vidéoprotection : © contributeurs OpenStreetMap (ODbL) · Webcams : Windy Webcams (windy.com) · Criter : Métropole de Lyon, Orléans Métropole, commune d’Anglet, data.gouv.fr (Licence Ouverte 2.0)',
  // Criter renouvelle ses images chaque minute ; les sources lentes sont gardées en mémoire (voir `load`).
  refreshIntervalMs: 60_000,
  // Pas d'historique : le dessin ne dépend pas de l'instant affiché.
  timeStepMs: 3_600_000,
  zoomBreaks: [...new Set([5, 7, 9, POINT_ZOOM, 13, 14, CONE_ZOOM, VOLUME_ZOOM, 17, ...halfZoomBreaks(POINT_ZOOM, 12)])].sort((a, b) => a - b),
  followsTerrain: true,
  followsView: true,

  settings: [
    {
      id: 'osm',
      label: 'Vidéoprotection (OpenStreetMap)',
      options: [
        { value: 'cones', label: 'Points et cônes de vision' },
        { value: 'points', label: 'Points seulement' },
        { value: 'off', label: 'Masquée' },
      ],
      defaultValue: 'cones',
    },
    {
      id: 'webcams',
      label: 'Webcams avec image',
      options: [
        { value: 'all', label: 'Windy et webcams ouvertes' },
        { value: 'criter', label: 'Webcams ouvertes seulement (sans Windy)' },
        { value: 'off', label: 'Masquées' },
      ],
      defaultValue: 'all',
    },
  ],

  legend(settings, data): LegendItem[] {
    const sheet = icons();
    const show = wanted(settings);
    const items: LegendItem[] = [];
    if (show.osm) {
      items.push(
        { color: `rgb(${PUBLIC_RGB.join(',')})`, label: 'Cône jaune : caméra sur l’espace public ou une voie (60°, 35 m par défaut)' },
        { color: `rgb(${PRIVATE_RGB.join(',')})`, label: 'Cône gris : lieu privé ou intérieur' },
        { color: HALO_CSS, label: 'Cercle : dôme ou caméra sans direction connue' },
      );
    }
    if (show.windy) {
      const windy = data?.windy;
      items.push({
        color: KEY_CSS,
        label: windy && !windy.active ? 'Rond sombre : webcam Windy (source désactivée : clé WINDY_WEBCAMS_KEY absente du serveur)' : 'Rond sombre : webcam Windy',
        icon: sheet.dataUrl('webcam'),
      });
    }
    if (show.criter) items.push({ color: KEY_CSS, label: 'Carré sombre : caméra de trafic Criter (Métropole de Lyon, image chaque minute)', icon: sheet.dataUrl('trafic') });
    if (show.open) items.push({ color: KEY_CSS, label: 'Rond sombre : webcam ouverte sans image (Orléans, Anglet), lien vers sa page', icon: sheet.dataUrl('webcam') });
    return items;
  },

  async load({ signal, settings }) {
    const show = wanted(settings);
    const now = Date.now();
    const data: CamerasData = { failedAt: {}, osm: cache.osm?.value, windy: cache.windy?.value, open: cache.open?.value };
    const tasks: Array<Promise<void>> = [];
    const run = (family: Family, job: () => Promise<void>) =>
      tasks.push(
        job().catch((error: unknown) => {
          if (signal.aborted) return;
          data.failedAt[family] = Date.now();
          console.warn(`[cameras] ${family} :`, error);
        }),
      );
    // Vidéoprotection : une extraction par semaine côté serveur, relue au plus une fois par jour.
    if (show.osm && (!cache.osm || now - cache.osm.at > DAY)) {
      run('osm', async () => {
        const value = await loadOsm(signal);
        cache.osm = { at: now, value };
        data.osm = value;
      });
    }
    // Catalogue Windy : relevé toutes les 12 h côté serveur, relu toutes les heures au plus.
    if (show.windy && (!cache.windy || now - cache.windy.at > 3600_000)) {
      run('windy', async () => {
        const value = await loadWindy(signal);
        cache.windy = { at: now, value };
        data.windy = value;
      });
    }
    // Webcams ouvertes : listes statiques, relues par le serveur quatre fois par jour, ici au plus toutes les 3 h.
    if (show.open && (!cache.open || now - cache.open.at > 3 * 3600_000)) {
      run('open', async () => {
        const value = await loadOpen(signal);
        cache.open = { at: now, value };
        data.open = value;
      });
    }
    // Criter : la liste (heure des images) est relue à chaque chargement, une fois par minute.
    if (show.criter) {
      run('criter', async () => {
        data.criter = await loadCriter(signal);
      });
    }
    await Promise.all(tasks);
    const failed = Object.keys(data.failedAt).length;
    const requested = Number(show.osm && !data.osm) + Number(show.windy && !data.windy) + Number(show.criter && !data.criter) + Number(show.open && !data.open);
    if (failed > 0 && requested > 0 && !data.osm && !data.windy && !data.criter && !data.open) throw new Error('le serveur ne donne aucune caméra pour le moment');
    return data;
  },

  /** Une famille demandée par les réglages mais jamais chargée (réglage changé depuis) : rechargement, au plus toutes les 30 s par famille en échec. */
  needsReload(data, _time, settings) {
    const show = wanted(settings);
    const now = Date.now();
    return (['osm', 'windy', 'criter', 'open'] as const).some((family) => show[family] && !data[family] && now - (data.failedAt[family] ?? 0) > 30_000);
  },

  summary({ data, settings, view }) {
    if (!data) return null;
    const show = wanted(settings);
    const parts: string[] = [];
    if (show.osm && data.osm) {
      parts.push(`${data.osm.list.length.toLocaleString('fr-FR')} caméras OpenStreetMap${view.zoom < POINT_ZOOM ? ' (zoom 11 et plus)' : ''}`);
    } else if (show.osm) parts.push('vidéoprotection indisponible');
    const webcams = (show.windy && data.windy?.active ? data.windy.list.length : 0) + (show.criter ? (data.criter?.list.length ?? 0) : 0) + (show.open ? (data.open?.list.length ?? 0) : 0);
    if (webcams > 0) parts.push(`${webcams.toLocaleString('fr-FR')} webcams`);
    if (show.windy && data.windy && !data.windy.active) parts.push('Windy désactivé (clé absente)');
    return parts.join(' · ') || null;
  },

  deckLayers({ data, settings, selection, view, terrain }) {
    if (!data) return [];
    const show = wanted(settings);
    const layers: LayersList = [];
    const onGround = <T extends { lon: number; lat: number }>(item: T): [number, number, number] => [item.lon, item.lat, terrain.elevation(item.lon, item.lat)];
    const picked = selection as Chosen | null;

    // --- Vidéoprotection OpenStreetMap ---
    if (show.osm && data.osm && view.zoom >= POINT_ZOOM) {
      const [west, south, east, north] = view.bounds();
      const padLon = (east - west) * 0.1;
      const padLat = (north - south) * 0.1;
      const visible = data.osm.list.filter((c) => c.lon >= west - padLon && c.lon <= east + padLon && c.lat >= south - padLat && c.lat <= north + padLat);
      if (settings.osm !== 'points' && view.zoom >= CONE_ZOOM) {
        const cones = conesInView(visible, view.bounds(), terrain, view.zoom >= VOLUME_ZOOM);
        const color = (cone: Cone, alpha: number): [number, number, number, number] => [...coneRgb(cone.camera), alpha];
        layers.push(
          new SolidPolygonLayer<Cone>({
            id: 'cameras/cones-sol',
            data: cones,
            getPolygon: (cone) => cone.ground,
            getFillColor: (cone) => color(cone, cone.round ? 70 : 96),
            _full3d: true,
            parameters: OVER_MAP,
            updateTriggers: { getPolygon: terrain.version },
          }),
          new PathLayer<Cone>({
            id: 'cameras/cones-contour',
            data: cones,
            getPath: (cone) => [...cone.ground, cone.ground[0]!],
            getColor: (cone) => (cone.round ? [20, 26, 38, 150] : [20, 26, 38, 190]),
            getWidth: 1,
            widthUnits: 'pixels',
            parameters: OVER_MAP,
            updateTriggers: { getPath: terrain.version },
          }),
        );
        if (view.zoom >= VOLUME_ZOOM) {
          const faces = cones.flatMap((cone) => cone.faces.map((face) => ({ face, cone })));
          layers.push(
            new SolidPolygonLayer<{ face: Position[]; cone: Cone }>({
              id: 'cameras/cones-volume',
              data: faces,
              getPolygon: (f) => f.face,
              getFillColor: (f) => color(f.cone, 64),
              _full3d: true,
              parameters: OVER_MAP,
              updateTriggers: { getPolygon: terrain.version },
            }),
          );
        }
      }
      const radius = zoomRamp(view.zoom, POINT_ZOOM, 17, 2.2, 5.2);
      layers.push(
        new ScatterplotLayer<OsmCamera>({
          id: 'cameras/osm-halo',
          data: visible,
          getPosition: onGround,
          getRadius: radius + 1.6,
          radiusUnits: 'pixels',
          getFillColor: [255, 255, 255, 235],
          billboard: true,
          updateTriggers: { getPosition: terrain.version },
          parameters: OVER_MAP,
        }),
        new ScatterplotLayer<OsmCamera>({
          id: 'cameras/osm-points',
          data: visible,
          getPosition: onGround,
          getRadius: radius,
          radiusUnits: 'pixels',
          // Valeur et non teinte : sombre pour l'espace public, clair cerné de sombre pour un lieu privé.
          getFillColor: (c) => (isPublic(c) ? KEY : [255, 255, 255, 255]),
          stroked: true,
          getLineColor: KEY,
          getLineWidth: 1,
          lineWidthUnits: 'pixels',
          billboard: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 170],
          updateTriggers: { getPosition: terrain.version, getRadius: Math.round(view.zoom * 4) },
          parameters: OVER_MAP,
        }),
      );
      const chosen = picked?.family === 'osm' ? data.osm.byId.get(picked.id) : undefined;
      if (chosen) layers.push(...selectionRing('cameras/osm-choisie', [chosen], onGround, radius + 8, OVER_MAP));
    }

    // --- Webcams avec image ---
    const sheet = icons();
    const size = zoomRamp(view.zoom, 5, 13, 16, 30);
    const webcamLayer = <T extends { lon: number; lat: number }>(id: string, items: readonly T[], key: string) =>
      new IconLayer<T>({
        id,
        data: items as T[],
        iconAtlas: sheet.atlas,
        iconMapping: sheet.mapping,
        getIcon: () => key,
        getPosition: onGround,
        sizeUnits: 'pixels',
        // La cellule fait 64 px dont ~16 de marge : on agrandit pour que le badge ait la taille demandée.
        getSize: size * 1.3,
        billboard: true,
        pickable: true,
        updateTriggers: { getPosition: terrain.version, getSize: Math.round(view.zoom * 4) },
        parameters: OVER_MAP,
      });
    if (show.windy && data.windy?.active) layers.push(webcamLayer('cameras/windy', sparseWindy(data.windy.list, view.zoom), 'webcam'));
    if (show.criter && data.criter) layers.push(webcamLayer('cameras/criter', data.criter.list, 'trafic'));
    if (show.open && data.open) layers.push(webcamLayer('cameras/ouvertes', data.open.list, 'webcam'));
    const chosenWebcam = picked?.family === 'windy' ? data.windy?.byId.get(picked.id) : picked?.family === 'criter' ? data.criter?.byId.get(picked.id) : picked?.family === 'open' ? data.open?.byId.get(picked.id) : undefined;
    if (chosenWebcam) layers.push(...selectionRing('cameras/webcam-choisie', [chosenWebcam], onGround, size * 0.72, OVER_MAP));
    return layers;
  },

  select(object) {
    const o = object as { id: number };
    // Les familles se reconnaissent à leurs champs : `detail` (Windy), `image` (Criter), `page` (webcams ouvertes), sinon OpenStreetMap.
    const family: Family = 'detail' in o ? 'windy' : 'image' in o ? 'criter' : 'page' in o ? 'open' : 'osm';
    return { family, id: o.id } satisfies Chosen;
  },

  focus(selection, { data }) {
    const pick = selection as Chosen | null;
    const byId = { osm: data?.osm?.byId, windy: data?.windy?.byId, criter: data?.criter?.byId, open: data?.open?.byId };
    const item = pick && (byId[pick.family] as Map<number, { lon: number; lat: number }> | undefined)?.get(pick.id);
    return item ? { lon: item.lon, lat: item.lat, fixed: true } : null;
  },

  describe(selection, { data }): InfoContent | null {
    const pick = selection as Chosen | null;
    if (!pick || !data) return null;

    if (pick.family === 'windy') {
      const cam = data.windy?.byId.get(pick.id);
      if (!cam) return null;
      return {
        kind: 'Webcam · Windy',
        title: cam.title,
        subtitle: cam.city || undefined,
        status: plainStatus('Image renouvelée par Windy toutes les 10 minutes environ'),
        // L'adresse passe par le serveur, qui garde la clé et renvoie vers le lien (valable 10 minutes) que Windy donne.
        image: { src: `/api/webcams/windy/image/${cam.id}`, alt: `Image de la webcam « ${cam.title} »`, refreshMs: 120_000, href: cam.detail, credit: 'Image : Windy Webcams' },
        fields: [
          ['Lieu', cam.city || 'non renseigné'],
          ['Source', 'Windy Webcams (windy.com)'],
        ],
        note: 'L’image renvoie vers la page de la webcam sur Windy. Les webcams sont publiées par leurs propriétaires.',
        link: { href: cam.detail, label: 'Voir sur Windy' },
      };
    }

    if (pick.family === 'criter') {
      const cam = data.criter?.byId.get(pick.id);
      if (!cam) return null;
      return {
        kind: 'Caméra de trafic · Criter',
        title: cam.name,
        subtitle: cam.place || undefined,
        status: plainStatus('Image renouvelée chaque minute'),
        image: { src: cam.image, alt: `Image de la caméra de trafic « ${cam.name} »${cam.place ? `, ${cam.place}` : ''}`, time: cam.time || undefined, refreshMs: 60_000, credit: 'Image : Métropole de Lyon, Criter' },
        fields: [
          ['Lieu', cam.place || 'non renseigné'],
          ...(cam.observation ? ([['Vue', cam.observation.replace(/^Direction\s*:\s*/i, 'Vers ')]] as Array<[string, string]>) : []),
          ['Source', 'Métropole de Lyon, système Criter (Licence Ouverte 2.0)'],
        ],
        link: { href: CRITER_DATASET, label: 'Jeu de données' },
      };
    }

    if (pick.family === 'open') {
      const cam = data.open?.byId.get(pick.id);
      if (!cam) return null;
      return {
        kind: 'Webcam · données ouvertes',
        title: cam.name,
        subtitle: cam.town || undefined,
        status: plainStatus('Vue en direct sur la page de la webcam'),
        fields: [
          ['Lieu', cam.town || 'non renseigné'],
          ['Source', `${cam.source}, data.gouv.fr (Licence Ouverte 2.0)`],
        ],
        note: 'Le jeu de données donne la position et la page de la webcam, pas son image : elle s’ouvre chez son éditeur, qui la publie volontairement.',
        link: { href: cam.page, label: 'Voir la webcam' },
      };
    }

    const camera = data.osm?.byId.get(pick.id);
    if (!camera) return null;
    const fields: Array<[string, string]> = [['Type', typeLabel(camera)]];
    const zone = ZONE_LABELS[camera.zone];
    fields.push(['Zone surveillée', `${LEVEL_LABELS[camera.level] ?? 'Non précisé'}${zone ? ` · ${zone}` : ''}`]);
    fields.push(['Exploitant', camera.operator || 'non renseigné']);
    fields.push(['Direction', camera.dir != null ? directionText(camera.dir) : camera.type === 1 ? 'tout autour (dôme)' : 'non renseignée']);
    if (camera.tilt != null) fields.push(['Inclinaison', `${Math.abs(camera.tilt)}° sous l’horizontale`]);
    if (camera.mount) fields.push(['Fixation', `${MOUNT_LABELS[camera.mount]}${camera.height != null ? `, à ${camera.height.toLocaleString('fr-FR')} m` : ''}`]);
    else if (camera.height != null) fields.push(['Hauteur', `${camera.height.toLocaleString('fr-FR')} m`]);
    const figures = [];
    if (camera.dir != null) figures.push({ value: `${camera.dir}°`, label: 'direction' });
    if (camera.height != null) figures.push({ value: camera.height.toLocaleString('fr-FR'), unit: 'm', label: 'hauteur' });
    return {
      kind: 'Caméra de vidéoprotection · OpenStreetMap',
      title: typeLabel(camera),
      subtitle: camera.operator || undefined,
      status: plainStatus(`Base OpenStreetMap du ${FRENCH_DATE.format(data.osm!.updatedAt)}`),
      figures,
      fields,
      note:
        camera.dir != null
          ? `Cône dessiné avec un champ de 60° (120° pour une caméra panoramique) et une portée ${camera.height != null && camera.tilt != null ? 'déduite de la hauteur et de l’inclinaison' : 'de 35 m par défaut'} : une indication, pas la zone réellement filmée.`
          : 'Informations saisies par des contributeurs d’OpenStreetMap : position et caractéristiques ne sont pas garanties.',
      link: { href: `https://www.openstreetmap.org/node/${camera.id}`, label: 'Objet OpenStreetMap' },
    };
  },
});
