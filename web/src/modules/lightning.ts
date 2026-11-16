/**
 * Module « Foudre en direct » : les éclairs détectés depuis l'espace par l'imageur d'éclairs (LI) du
 * satellite Meteosat Troisième Génération (MTG-I1, EUMETSAT), sur les 45 dernières minutes.
 *
 * Source et conditions (vérifiées en novembre 2026) :
 * - le service d'images EUMETView (`view.eumetsat.int`, WMS) publie la couche « LI Accumulated Flash
 *   Area » : nombre d'éclairs par case de 2 km et par tranche de 5 minutes, une image toutes les 5 minutes,
 *   avec un retard d'environ 15 minutes et une archive depuis mai 2025 (la relecture du passé fonctionne) ;
 * - le service est ouvert : ni compte ni clé (`Fees: none`, `AccessConstraints: none`), en-têtes CORS
 *   `*`, donc le navigateur le lit directement. Limites annoncées par les en-têtes : 20 requêtes par
 *   seconde (les excédents sont retardés) et 8 requêtes en parallèle ;
 * - mention de la source : © EUMETSAT. Les données brutes du LI (NetCDF) demandent un compte
 *   EUMETSAT et un décodeur HDF5 : elles ne sont pas utilisées ici. Blitzortung.org, dont les
 *   conditions interdisent la réutilisation de son flux sans accord, n'est pas utilisé non plus.
 *
 * Les images sont en jaune-orange-rouge ; comme pour le radar de pluie, un protocole MapLibre
 * (`eclair://`) télécharge la tuile, retrouve le nombre d'éclairs de chaque case d'après la légende
 * publiée et la redessine dans une rampe d'une seule teinte (`ECLAIR`). L'âge passe par l'opacité :
 * chaque image des 45 dernières minutes est une couche raster native, d'autant plus transparente
 * qu'elle est ancienne. À l'arrivée d'une nouvelle image, ses cases apparaissent en fondu (pas
 * de fondu pour qui demande moins de mouvement).
 */
import { ECLAIR } from '../design/tokens';
import { addProtocol, type Map as MapLibreMap, type RasterSourceSpecification } from 'maplibre-gl';
import { defineModule, type LegendItem } from '../core/module';
import { firstSymbolLayerId } from '../map/baseMap';
import { formatTime } from '../ui/format';

const WMS = 'https://view.eumetsat.int/geoserver/mtg_fd/ows';
const LAYER = 'li_afa';
const PROTOCOL = 'eclair';
const ATTRIBUTION = '<a href="https://view.eumetsat.int/" target="_blank" rel="noreferrer">© EUMETSAT</a>';
/** Pas entre deux images. */
const STEP_MS = 5 * 60_000;
/** Durée montrée : les éclairs plus vieux disparaissent. */
const WINDOW_MS = 45 * 60_000;
/** Opacité de l'image la plus récente, et de la plus ancienne (juste avant de disparaître). */
const OPACITY_NEWEST = 0.95;
const OPACITY_OLDEST = 0.08;
/**
 * Tuiles de 1024 pixels : 3 fois moins de requêtes qu'avec 512 (9 images × une dizaine de tuiles
 * sur la France), alors que le pixel natif du LI (2 km) est déjà plus gros que celui de la carte.
 */
const TILE_SIZE = 1024;
const TILE_MAX_ZOOM = 6;
/** Requêtes en parallèle : le service en accepte 8 par utilisateur. */
const MAX_PARALLEL_FETCHES = 6;

interface LightningData {
  /** Instant (ms) de la dernière image publiée. */
  latest: number;
  /** Instant (ms) de la plus ancienne image de l'archive. */
  earliest: number;
}

/**
 * Nombre d'éclairs par case et par 5 minutes : 1, 2 à 3, 4 à 9, 10 et plus. Valeurs validées avec
 * `validate_palette.js --ordinal` en clair et en sombre (voir `ECLAIR` dans `design/tokens.ts`).
 */
const LEGEND_LABELS = ['1 éclair', '2 à 3 éclairs', '4 à 9 éclairs', '10 éclairs et plus'];

const hexToRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const RAMPS = { jour: ECLAIR.jour.map(hexToRgb), nuit: ECLAIR.nuit.map(hexToRgb) } as const;

/**
 * Couleurs de la légende de la couche d'EUMETSAT (jaune pâle à rouge sombre, mesurées sur sa
 * légende publiée) et nombre d'éclairs par 5 minutes correspondant : l'échelle est linéaire de 1 à 20.
 */
const SOURCE_STOPS: ReadonlyArray<readonly [count: number, r: number, g: number, b: number]> = [
  [1, 255, 255, 201],
  [2.4, 255, 242, 174],
  [3.6, 255, 232, 151],
  [4.9, 254, 220, 125],
  [6.2, 254, 202, 102],
  [7.5, 254, 181, 79],
  [8.8, 253, 161, 68],
  [10.1, 253, 137, 58],
  [11.4, 252, 102, 49],
  [12.7, 248, 70, 40],
  [14, 235, 43, 32],
  [15.2, 216, 18, 30],
  [16.5, 195, 3, 36],
  [17.8, 167, 0, 38],
];

/** Cran de la rampe (0 à 3) pour un nombre d'éclairs. */
export function stepOfCount(count: number): number {
  if (count < 1.7) return 0;
  if (count < 3.7) return 1;
  if (count < 9.5) return 2;
  return 3;
}

const stepOfColor = new Map<number, number>();

/** Cran de la rampe pour un pixel de l'image d'EUMETSAT : la couleur de légende la plus proche donne le nombre d'éclairs. */
export function stepOfPixel(r: number, g: number, b: number): number {
  const key = (r << 16) | (g << 8) | b;
  const known = stepOfColor.get(key);
  if (known !== undefined) return known;
  let best = SOURCE_STOPS[0]!;
  let bestDistance = Infinity;
  for (const stop of SOURCE_STOPS) {
    const distance = (r - stop[1]) ** 2 + (g - stop[2]) ** 2 + (b - stop[3]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = stop;
    }
  }
  const step = stepOfCount(best[0]);
  stepOfColor.set(key, step);
  return step;
}

/** Redessine une tuile : mêmes cases, couleurs de la rampe du jour ou de la nuit. */
export function recolor(pixels: Uint8ClampedArray, theme: 'jour' | 'nuit'): void {
  const ramp = RAMPS[theme];
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3]! < 64) {
      pixels[i + 3] = 0;
      continue;
    }
    const [r, g, b] = ramp[stepOfPixel(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!)]!;
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = 255;
  }
}

// --- Images à montrer à l'instant t ---

/** Images (instants en ms, au pas de 5 minutes) des 45 minutes qui précèdent t, sans dépasser la dernière publiée. */
export function framesFor(data: LightningData, t: number): number[] {
  const reference = Math.min(t, data.latest);
  const newest = Math.floor(reference / STEP_MS) * STEP_MS;
  const frames: number[] = [];
  for (let time = newest; time > reference - WINDOW_MS; time -= STEP_MS) {
    if (time >= data.earliest) frames.push(time);
  }
  return frames.reverse();
}

/** Opacité d'une image selon son âge (par rapport à l'image la plus récente disponible à l'instant t), arrondie au vingtième. */
export function opacityFor(frameTime: number, reference: number): number {
  const age = Math.min(WINDOW_MS, Math.max(0, reference - frameTime));
  // Décroissance en carré : les images anciennes s'effacent vite, sinon leur cumul fait une tache uniforme.
  const value = OPACITY_OLDEST + (OPACITY_NEWEST - OPACITY_OLDEST) * (1 - age / WINDOW_MS) ** 2;
  return Math.round(value * 20) / 20;
}

// --- Capacités du service : dernière image et début de l'archive ---

/** Lit la dimension de temps de la couche : `début/fin/PT5M` et l'instant par défaut (la dernière image). */
export function parseTimeExtent(xml: string): LightningData | null {
  const start = xml.indexOf(`<Name>${LAYER}</Name>`);
  if (start < 0) return null;
  const end = xml.indexOf('</Layer>', start);
  const match = /<Dimension[^>]*name="time"[^>]*default="([^"]+)"[^>]*>\s*([^</\s]+)\/([^</\s]+)\/PT\d+M/.exec(xml.slice(start, end < 0 ? undefined : end));
  if (!match) return null;
  const earliest = Date.parse(match[2]!);
  const latest = Date.parse(match[1]!);
  return Number.isFinite(earliest) && Number.isFinite(latest) ? { earliest, latest } : null;
}

async function loadLightning(signal: AbortSignal): Promise<LightningData> {
  const response = await fetch(`${WMS}?service=WMS&version=1.3.0&request=GetCapabilities`, { signal });
  if (!response.ok) throw new Error(`EUMETSAT a répondu ${response.status}`);
  const extent = parseTimeExtent(await response.text());
  if (!extent) throw new Error('EUMETSAT ne publie pas la couche des éclairs');
  return extent;
}

// --- Téléchargement des tuiles, par le protocole « eclair:// » ---

let running = 0;
const waiting: Array<() => void> = [];
let protocolRegistered = false;

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL_FETCHES) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

const WORLD = 40075016.68557849;

/** Emprise d'une tuile en projection Web Mercator (mètres) : ouest, sud, est, nord. */
export function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const size = WORLD / 2 ** z;
  const west = -WORLD / 2 + x * size;
  const north = WORLD / 2 - y * size;
  return [west, north - size, west + size, north];
}

function registerProtocol(): void {
  if (protocolRegistered) return;
  protocolRegistered = true;
  // Adresse demandée par MapLibre : eclair://<jour|nuit>/<instant en s>/<z>/<x>/<y>
  addProtocol(PROTOCOL, async (request, abortController) => {
    const match = /^eclair:\/\/(jour|nuit)\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/.exec(request.url);
    if (!match) throw new Error(`adresse de tuile inattendue : ${request.url}`);
    const theme = match[1] as 'jour' | 'nuit';
    const [seconds, z, x, y] = [match[2], match[3], match[4], match[5]].map(Number) as [number, number, number, number];
    const time = new Date(seconds * 1000).toISOString().slice(0, 19) + 'Z';
    const bbox = tileBounds(z, x, y).join(',');
    const url =
      `${WMS}?service=WMS&version=1.3.0&request=GetMap&layers=${LAYER}&styles=&crs=EPSG:3857` +
      `&bbox=${bbox}&width=${TILE_SIZE}&height=${TILE_SIZE}&format=image/png&transparent=true&time=${time}`;
    const bitmap = await withSlot(async () => {
      const response = await fetch(url, { signal: abortController.signal });
      if (!response.ok) throw new Error(`EUMETSAT a répondu ${response.status}`);
      return createImageBitmap(await response.blob());
    });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('canvas indisponible');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    recolor(image.data, theme);
    context.putImageData(image, 0, 0);
    return { data: canvas.transferToImageBitmap() };
  });
}

// --- Couches MapLibre ---

const PREFIX = 'eclair-';
const layerId = (theme: string, time: number) => `${PREFIX}${theme}-${time / 1000}`;
/** Opacité réellement posée sur chaque couche (pour ne pas réécrire le style à chaque pas). */
const appliedOpacity = new Map<string, number>();

const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function frameLayers(map: MapLibreMap): string[] {
  return map
    .getStyle()
    .layers.filter((layer) => layer.id.startsWith(PREFIX))
    .map((layer) => layer.id);
}

function removeFrame(map: MapLibreMap, id: string): void {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
  appliedOpacity.delete(id);
}

function addFrame(map: MapLibreMap, theme: 'jour' | 'nuit', time: number, opacity: number): void {
  const id = layerId(theme, time);
  if (map.getSource(id)) return;
  const source: RasterSourceSpecification = {
    type: 'raster',
    tiles: [`${PROTOCOL}://${theme}/${time / 1000}/{z}/{x}/{y}`],
    tileSize: TILE_SIZE,
    maxzoom: TILE_MAX_ZOOM,
    attribution: ATTRIBUTION,
  };
  map.addSource(id, source);
  // Sous l'ombre de la nuit si elle est là, sinon sous les étiquettes.
  const before = map.getLayer('jour-nuit') ? 'jour-nuit' : firstSymbolLayerId(map);
  map.addLayer(
    {
      id,
      type: 'raster',
      source: id,
      // Les cases d'une nouvelle image apparaissent en fondu, sauf si l'on demande moins de mouvement.
      paint: { 'raster-opacity': opacity, 'raster-fade-duration': reducedMotion() ? 0 : 500, 'raster-resampling': 'nearest' },
    },
    before,
  );
  appliedOpacity.set(id, opacity);
}

function setOpacity(map: MapLibreMap, id: string, opacity: number): void {
  if (appliedOpacity.get(id) === opacity || !map.getLayer(id)) return;
  map.setPaintProperty(id, 'raster-opacity', opacity);
  appliedOpacity.set(id, opacity);
}

export const lightning = defineModule<LightningData>({
  id: 'foudre',
  name: 'Foudre en direct',
  category: 'ciel',
  description: 'Les éclairs des 45 dernières minutes, vus du satellite météo MTG : plus ils sont anciens, plus ils s’estompent.',
  attribution: 'EUMETSAT, Meteosat Troisième Génération (imageur d’éclairs LI), via EUMETView ; recoloré ici',
  refreshIntervalMs: 5 * 60_000,
  // L'opacité suit l'âge : un pas de 30 s simulées suffit (elle est arrondie au vingtième).
  timeStepMs: 30_000,

  load: ({ signal }) => loadLightning(signal),

  legend(): LegendItem[] {
    return [
      ...ECLAIR.jour.map((color, i) => ({ color, label: `${LEGEND_LABELS[i]} par case de 2 km et par 5 min`, size: 'medium' as const })),
      { color: ECLAIR.jour[1]!, label: 'Plus l’éclair est ancien, plus il est transparent (45 min au plus)', size: 'small' as const },
    ];
  },

  summary({ data, time }) {
    if (!data) return null;
    if (time < data.earliest) return `Archive depuis le ${new Date(data.earliest).toLocaleDateString('fr-FR')} seulement`;
    const frames = framesFor(data, time);
    const last = frames[frames.length - 1];
    if (last === undefined) return null;
    return `Dernière image de ${formatTime(last)} · retard d’environ 15 min · 45 dernières minutes`;
  },

  native: {
    add() {
      registerProtocol();
    },

    update(map, { data, time, night }) {
      if (!data) return;
      const theme = night >= 0.5 ? 'nuit' : 'jour';
      const frames = time < data.earliest ? [] : framesFor(data, time);
      const reference = Math.min(time, data.latest);
      const wanted = new Map(frames.map((frame) => [layerId(theme, frame), frame]));
      // Les images sorties de la fenêtre (ou d'un autre thème) sont retirées : aucune requête inutile.
      for (const id of frameLayers(map)) if (!wanted.has(id)) removeFrame(map, id);
      // La plus récente d'abord : c'est elle qu'on veut voir en premier.
      for (const [id, frame] of [...wanted].reverse()) {
        const opacity = opacityFor(frame, reference);
        if (map.getSource(id)) setOpacity(map, id, opacity);
        else addFrame(map, theme, frame, opacity);
      }
    },

    remove(map) {
      for (const id of frameLayers(map)) removeFrame(map, id);
    },
  },
});
