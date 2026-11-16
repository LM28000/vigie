/**
 * Module « Satellite du jour » : la France vue par un satellite d'observation de la Terre, dans la
 * journée, d'après NASA GIBS (Global Imagery Browse Services, NASA EOSDIS).
 *
 * Source et conditions (vérifiées en novembre 2026) :
 * - tuiles WMTS « REST » gratuites, sans clé ni compte, en-têtes CORS `*` : le navigateur les lit
 *   directement, le serveur n'est pas sollicité. Projection Web Mercator (`epsg3857/best`), jeu de tuiles
 *   `GoogleMapsCompatible_Level9` : tuiles de 256 px, niveau de zoom 9 au plus (≈ 300 m par pixel à
 *   l'équateur, ≈ 200 m en France). Au-delà, MapLibre agrandit les tuiles du niveau 9 (`maxzoom` de la source) ;
 * - « Corrected Reflectance » : l'image du jour, en vraies couleurs (nuages, neige, fumées) ou en fausses
 *   couleurs (neige et glace cyan, feux rouges) ; une mosaïque par jour UTC, assemblée avec quelques heures
 *   de retard (produits « quasi temps réel », NRT). Les tuiles ne sont pas mises en cache par GIBS
 *   (`cache-control: no-store`) : c'est le cache du navigateur et celui de MapLibre qui servent ;
 * - mention de la source : « NASA EOSDIS GIBS / Worldview » (voir `ATTRIBUTION`).
 *
 * Quelle date ? Le jour UTC de l'instant affiché (frise du temps, relecture comprise : GIBS archive depuis
 * 2000 pour Terra, 2002 pour Aqua, 2018 pour NOAA-20, 2023 pour NOAA-21). Pour aujourd'hui, la mosaïque se
 * remplit au fil des passages : tant que la France n'y est pas (pixels noirs), on montre la veille. Ce
 * contrôle (`load`) lit deux tuiles de zoom 4 qui couvrent la France et mesure la part de pixels noirs.
 *
 * Dessin : une couche raster native (drapée sur le relief par MapLibre), sous les bâtiments 3D et les noms.
 * Aucun filtre de nuit : l'image est une photo de jour, elle reste lisible la nuit ; seul le voile d'ombre de
 * la Terre vu de loin (couche « Jour et nuit »), posé au-dessus, la nuance.
 */
import type { Map as MapLibreMap, RasterSourceSpecification } from 'maplibre-gl';
import { defineModule, type InfoContent, type LegendItem, type ModuleSetting } from '../core/module';
import { ModuleManager } from '../core/moduleManager';
import { plainStatus } from '../core/infoStatus';
import { fillInsertionId } from '../map/baseMap';
import './satelliteImagery.css';

const MODULE_ID = 'satellite-jour';
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const TILE_MATRIX_SET = 'GoogleMapsCompatible_Level9';
const MAX_ZOOM = 9;
const ATTRIBUTION =
  '<a href="https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api" target="_blank" rel="noreferrer">NASA EOSDIS GIBS / Worldview</a>';
const DAY_MS = 86_400_000;
/** Pas de la contrôle de couverture de la journée en cours (la mosaïque se remplit au fil des passages). */
const RECHECK_MS = 30 * 60_000;
/** Part minimale de pixels non noirs sur les deux tuiles de contrôle pour juger la France couverte. */
const COVERAGE_MIN = 0.9;

export interface Satellite {
  value: string;
  /** Nom court, pour le résumé et le bandeau. */
  short: string;
  label: string;
  /** Capteur, pour la fiche. */
  sensor: string;
  /** Couche GIBS en vraies couleurs. */
  trueColor: string;
  /** Couche GIBS en fausses couleurs (neige et feux). */
  falseColor: string;
  /** Premier jour archivé (AAAA-MM-JJ). */
  since: string;
  /** Résolution de la couche, en mètres par pixel au niveau 9. */
}

export const SATELLITES: readonly Satellite[] = [
  {
    value: 'noaa20',
    short: 'NOAA-20',
    label: 'NOAA-20 (VIIRS)',
    sensor: 'VIIRS',
    trueColor: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
    falseColor: 'VIIRS_NOAA20_CorrectedReflectance_BandsM11-I2-I1',
    since: '2018-01-05',
  },
  {
    value: 'noaa21',
    short: 'NOAA-21',
    label: 'NOAA-21 (VIIRS)',
    sensor: 'VIIRS',
    trueColor: 'VIIRS_NOAA21_CorrectedReflectance_TrueColor',
    falseColor: 'VIIRS_NOAA21_CorrectedReflectance_BandsM11-I2-I1',
    since: '2023-02-10',
  },
  {
    value: 'terra',
    short: 'Terra',
    label: 'Terra (MODIS, matin)',
    sensor: 'MODIS',
    trueColor: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    falseColor: 'MODIS_Terra_CorrectedReflectance_Bands721',
    since: '2000-02-24',
  },
  {
    value: 'aqua',
    short: 'Aqua',
    label: 'Aqua (MODIS, après-midi)',
    sensor: 'MODIS',
    trueColor: 'MODIS_Aqua_CorrectedReflectance_TrueColor',
    falseColor: 'MODIS_Aqua_CorrectedReflectance_Bands721',
    since: '2002-07-03',
  },
];

export const satelliteOf = (settings: Readonly<Record<string, string>>): Satellite =>
  SATELLITES.find((s) => s.value === settings.satellite) ?? SATELLITES[0]!;

export const isFalseColor = (settings: Readonly<Record<string, string>>): boolean => settings.couleurs === 'fausses';

// --- Jours ---

/** Jour UTC (AAAA-MM-JJ) d'un instant. */
export const dayOf = (time: number): string => new Date(time).toISOString().slice(0, 10);

/** Jour de l'image demandée pour l'instant affiché : le jour UTC de l'instant, sans dépasser aujourd'hui. */
export function requestedDay(time: number, now: number): string {
  return dayOf(Math.min(time, now));
}

/** La veille d'un jour AAAA-MM-JJ. */
export function previousDay(day: string): string {
  return dayOf(Date.parse(`${day}T00:00:00Z`) - DAY_MS);
}

/** « 15 nov. 2026 » (jour UTC de l'image). */
export function formatDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** « 15 novembre 2026 ». */
const formatDayLong = (day: string): string =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Adresse d'une tuile, avec `{z}/{y}/{x}` laissés pour MapLibre (l'ordre de GIBS est ligne, puis colonne). */
export function tilesUrl(layer: string, day: string): string {
  return `${GIBS}/${layer}/default/${day}/${TILE_MATRIX_SET}/{z}/{y}/{x}.jpg`;
}

// --- Données : quelle image montrer ---

export interface SatelliteData {
  satellite: string;
  /** `true` : fausses couleurs. */
  falseColor: boolean;
  /** Jour correspondant à l'instant affiché. */
  requested: string;
  /** Jour de l'image montrée, ou `null` si le satellite n'archive pas encore ce jour-là. */
  day: string | null;
  /** Vrai quand on montre la veille faute d'image du jour en cours. */
  fellBack: boolean;
  checkedAt: number;
}

/** Part de pixels « vivants » (pas noirs) d'une image RVB : le noir pur est ce que GIBS dessine hors des passages du jour. */
export function litFraction(pixels: Uint8ClampedArray): number {
  let lit = 0;
  const count = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! + pixels[i + 1]! + pixels[i + 2]! > 15) lit++;
  return count > 0 ? lit / count : 0;
}

/** Les deux tuiles de zoom 4 qui couvrent la France (de 22° O à 22° E, de 41° N à 56° N). */
const PROBE_TILES: ReadonlyArray<readonly [x: number, y: number]> = [
  [7, 5],
  [8, 5],
];

/** La mosaïque de ce jour couvre-t-elle la France ? */
async function franceCovered(layer: string, day: string, signal: AbortSignal): Promise<boolean> {
  const fractions = await Promise.all(
    PROBE_TILES.map(async ([x, y]) => {
      const response = await fetch(tilesUrl(layer, day).replace('{z}', '4').replace('{y}', String(y)).replace('{x}', String(x)), { signal });
      if (!response.ok) return 0;
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = new OffscreenCanvas(64, 64);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('canvas indisponible');
      context.drawImage(bitmap, 0, 0, 64, 64);
      bitmap.close();
      return litFraction(context.getImageData(0, 0, 64, 64).data);
    }),
  );
  return Math.min(...fractions) >= COVERAGE_MIN;
}

async function loadImagery(time: number, settings: Readonly<Record<string, string>>, signal: AbortSignal): Promise<SatelliteData> {
  const satellite = satelliteOf(settings);
  const now = Date.now();
  const requested = requestedDay(time, now);
  const base = { satellite: satellite.value, falseColor: isFalseColor(settings), requested, checkedAt: now };
  if (requested < satellite.since) return { ...base, day: null, fellBack: false };
  // Un jour terminé est complet. Seul le jour en cours se remplit : on vérifie qu'il couvre la France.
  if (requested < dayOf(now)) return { ...base, day: requested, fellBack: false };
  const covered = await franceCovered(satellite.trueColor, requested, signal).catch((error: unknown) => {
    if (signal.aborted) throw error;
    return false;
  });
  if (covered) return { ...base, day: requested, fellBack: false };
  const yesterday = previousDay(requested);
  return { ...base, day: yesterday < satellite.since ? null : yesterday, fellBack: true };
}

/** Faut-il recalculer l'image pour cet instant et ces réglages ? */
export function needsReload(data: SatelliteData, time: number, settings: Readonly<Record<string, string>>, now = Date.now()): boolean {
  if (data.satellite !== satelliteOf(settings).value || data.falseColor !== isFalseColor(settings)) return true;
  if (data.requested !== requestedDay(time, now)) return true;
  // La veille montrée faute de mieux : on regarde de temps en temps si le jour en cours est arrivé.
  return data.fellBack && now - data.checkedAt > RECHECK_MS;
}

const layerOf = (satellite: Satellite, falseColor: boolean): string => (falseColor ? satellite.falseColor : satellite.trueColor);
const satelliteById = (value: string): Satellite => SATELLITES.find((s) => s.value === value) ?? SATELLITES[0]!;

// --- Couches MapLibre ---

const PREFIX = 'satellite-jour-';
const idOf = (layer: string, day: string): string => `${PREFIX}${layer}-${day}`;
const opacityOf = (settings: Readonly<Record<string, string>>): number => Math.min(1, Math.max(0.2, Number(settings.opacite ?? '100') / 100));
const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const frameLayers = (map: MapLibreMap): string[] =>
  map
    .getStyle()
    .layers.filter((layer) => layer.id.startsWith(PREFIX))
    .map((layer) => layer.id);

function removeFrame(map: MapLibreMap, id: string): void {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
}

let appliedOpacity = new Map<string, number>();

function addFrame(map: MapLibreMap, id: string, layer: string, day: string, opacity: number): void {
  const source: RasterSourceSpecification = {
    type: 'raster',
    tiles: [tilesUrl(layer, day)],
    tileSize: 256,
    // Au-delà du niveau 9, MapLibre agrandit les tuiles du niveau 9 : pas de tuile manquante.
    maxzoom: MAX_ZOOM,
    attribution: ATTRIBUTION,
  };
  map.addSource(id, source);
  // Au-dessus des routes et des ponts du fond, sous les bâtiments 3D et les noms.
  map.addLayer(
    {
      id,
      type: 'raster',
      source: id,
      paint: { 'raster-opacity': opacity, 'raster-fade-duration': reducedMotion() ? 0 : 300, 'raster-resampling': 'linear' },
    },
    fillInsertionId(map),
  );
  appliedOpacity.set(id, opacity);
}

// --- Bandeau : date et satellite de l'image, sur la carte ---

interface Badge {
  root: HTMLButtonElement;
}
let badge: Badge | undefined;

function showBadge(text: string | null): void {
  if (!badge) return;
  badge.root.hidden = text === null;
  if (text !== null) badge.root.textContent = text;
}

// --- Texte ---

/** « NOAA-20 (VIIRS), vraies couleurs, 15 nov. 2026 ». */
function imageLabel(data: SatelliteData): string {
  const satellite = satelliteById(data.satellite);
  return `${satellite.short}, ${formatDay(data.day ?? data.requested)}`;
}

const COLOR_LEGEND_TRUE: LegendItem[] = [
  { color: '#f4f6f8', label: 'Nuages, brouillard et neige : blancs', size: 'medium' },
  { color: '#b8bcc4', label: 'Fumées et brumes : gris, voile jaunâtre', size: 'medium' },
  { color: '#2f5d3a', label: 'Terres : verts et bruns ; mers : bleu sombre', size: 'medium' },
];
const COLOR_LEGEND_FALSE: LegendItem[] = [
  { color: '#5cc8e6', label: 'Neige et glace : cyan', size: 'medium' },
  { color: '#f4f6f8', label: 'Nuages d’eau : blanc', size: 'medium' },
  { color: '#e04a2f', label: 'Feux actifs : rouge-orange', size: 'medium' },
  { color: '#6f8b3a', label: 'Végétation : vert, sol nu : brun', size: 'medium' },
];

const SETTINGS: readonly ModuleSetting[] = [
  {
    id: 'satellite',
    label: 'Satellite',
    options: SATELLITES.map((s) => ({ value: s.value, label: s.label })),
    defaultValue: 'noaa20',
  },
  {
    id: 'couleurs',
    label: 'Couleurs',
    options: [
      { value: 'vraies', label: 'Vraies couleurs' },
      { value: 'fausses', label: 'Neige et feux (fausses couleurs)' },
    ],
    defaultValue: 'vraies',
  },
  {
    id: 'opacite',
    label: 'Opacité',
    options: [
      { value: '100', label: '100 %' },
      { value: '70', label: '70 %' },
      { value: '40', label: '40 %' },
    ],
    defaultValue: '100',
    range: { min: 20, max: 100, step: 10, format: (value) => `${value} %` },
  },
];

export const satelliteImagery = defineModule<SatelliteData>({
  id: MODULE_ID,
  name: 'Satellite du jour',
  category: 'ciel',
  description: 'La France vue du ciel dans la journée : nuages, neige et fumées, d’après les satellites NOAA-20, NOAA-21, Terra et Aqua (NASA GIBS).',
  attribution: 'NASA EOSDIS GIBS / Worldview (VIIRS NOAA-20 et NOAA-21, MODIS Terra et Aqua)',
  // Le jour en cours se remplit au fil des passages : on relit toutes les 30 minutes quand on montre la veille.
  refreshIntervalMs: RECHECK_MS,
  // Une image par jour : la couche ne bouge pas avec l'horloge (changement de jour vérifié à chaque case d'une heure).
  timeStepMs: 3_600_000,
  // Au sol, sous les noms et les couches deck.gl.
  drawOrder: -6,
  settings: SETTINGS,

  load: ({ signal, time, settings }) => loadImagery(time, settings, signal),
  needsReload: (data, time, settings) => needsReload(data, time, settings),

  legend(settings, data) {
    const satellite = data ? satelliteById(data.satellite) : satelliteOf(settings);
    const falseColor = data ? data.falseColor : isFalseColor(settings);
    const head: LegendItem = {
      color: '#8a8f9c',
      label: data?.day ? `${satellite.short}, image du ${formatDay(data.day)}` : `${satellite.short}, NASA GIBS`,
      size: 'small',
    };
    return [head, ...(falseColor ? COLOR_LEGEND_FALSE : COLOR_LEGEND_TRUE)];
  },

  summary({ data, view }) {
    if (!data) return null;
    const satellite = satelliteById(data.satellite);
    if (data.day === null) return `${satellite.short} n’archive rien avant le ${formatDay(satellite.since)}`;
    const mode = data.falseColor ? 'neige et feux' : 'vraies couleurs';
    const fallback = data.fellBack ? ` · image du jour pas encore complète (${formatDay(data.requested)})` : '';
    const zoom = view.zoom > MAX_ZOOM + 1 ? ' · agrandie au-delà du zoom 9' : '';
    return `${satellite.short} · image du ${formatDay(data.day)} · ${mode}${fallback}${zoom}`;
  },

  native: {
    add(map) {
      appliedOpacity = new Map();
      const root = document.createElement('button');
      root.type = 'button';
      root.className = 'satellite-bandeau';
      root.hidden = true;
      root.title = 'Voir la fiche de cette image';
      root.addEventListener('click', () => ModuleManager.current?.setSelection(MODULE_ID, { type: 'image' }));
      map.getContainer().appendChild(root);
      badge = { root };
    },

    update(map, { data, settings }) {
      if (!data) return;
      const wantedId = data.day ? idOf(layerOf(satelliteById(data.satellite), data.falseColor), data.day) : null;
      if (data.day && wantedId) {
        const layer = layerOf(satelliteById(data.satellite), data.falseColor);
        const opacity = opacityOf(settings);
        if (!map.getSource(wantedId)) {
          addFrame(map, wantedId, layer, data.day, opacity);
          // L'ancienne image reste dessous le temps que la nouvelle se charge (pas de flash du fond), puis part.
          const old = frameLayers(map).filter((id) => id !== wantedId);
          if (old.length > 0) {
            map.once('idle', () => {
              for (const id of old) if (id !== wantedId) removeFrame(map, id);
            });
          }
        } else if (appliedOpacity.get(wantedId) !== opacity && map.getLayer(wantedId)) {
          map.setPaintProperty(wantedId, 'raster-opacity', opacity);
          appliedOpacity.set(wantedId, opacity);
        }
        showBadge(`Satellite · ${imageLabel(data)}`);
      } else {
        for (const id of frameLayers(map)) removeFrame(map, id);
        showBadge(null);
      }
    },

    remove(map) {
      for (const id of frameLayers(map)) removeFrame(map, id);
      badge?.root.remove();
      badge = undefined;
    },
  },

  select() {
    return { type: 'image' };
  },

  describe(_selection, { data, settings }): InfoContent {
    const satellite = data ? satelliteById(data.satellite) : satelliteOf(settings);
    const falseColor = data ? data.falseColor : isFalseColor(settings);
    const day = data?.day ?? null;
    return {
      kind: 'Satellite du jour',
      title: day ? `${satellite.short}, image du ${formatDayLong(day)}` : `${satellite.short}, pas d’image`,
      subtitle: `${satellite.sensor} · ${falseColor ? 'fausses couleurs : neige et feux' : 'vraies couleurs'}`,
      status: plainStatus(data?.fellBack ? 'Image de la veille · celle du jour n’est pas encore complète' : 'Image de la journée · pas en temps réel'),
      figures: [
        { value: day ? formatDay(day) : '—', label: 'jour de l’image' },
        { value: satellite.short, label: satellite.sensor },
        { value: '250', unit: 'm', label: 'par pixel' },
      ],
      fields: [
        ['Date', day ? `${formatDayLong(day)} (jour UTC)` : `Rien avant le ${formatDayLong(satellite.since)}`],
        [
          'Ce que l’on voit',
          falseColor
            ? 'Infrarouges (bandes 7-2-1 pour MODIS, M11-I2-I1 pour VIIRS) : la neige et la glace sont cyan, les nuages d’eau blancs, les feux actifs rouge-orange'
            : 'Une photo : nuages et neige blancs, fumées grises ou brunâtres, mers bleu sombre. Les trous noirs sont des zones non survolées ce jour-là',
        ],
        ['Source', 'NASA EOSDIS GIBS / Worldview, produit quasi temps réel'],
      ],
      note: 'La France est survolée le matin par Terra, l’après-midi par Aqua, NOAA-20 et NOAA-21. L’image est une mosaïque des passages du satellite sur la journée : un nuage peut avoir bougé entre deux passages, et un pli sombre marque parfois le raccord. Zoomer au-delà du niveau 9 agrandit les mêmes pixels (≈ 250 m). La date suit l’instant choisi sur la frise du temps.',
      link: { href: 'https://worldview.earthdata.nasa.gov/', label: 'NASA Worldview' },
    };
  },
});
