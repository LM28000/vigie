/**
 * Module « Parkings » : les places libres, en direct, des parkings et parcs relais des villes qui
 * publient leur disponibilité en données ouvertes (Rennes, Nantes, Strasbourg, Bordeaux, Clermont-Ferrand,
 * Tours, Aix-Marseille, Orléans, Grenoble). Le serveur (server/src/parkings.rs) rassemble les sources
 * toutes les 5 minutes et garde les places libres des dernières 24 heures pour la courbe de la fiche.
 *
 * De loin, un disque par agglomération (places libres au total) ; puis un point par parking ; de près, une
 * jauge en anneau, comme les vélos : la part de places libres, colorée selon le taux d'occupation
 * (une seule teinte ardoise, du clair au foncé). Un parking complet est un anneau plein barré de blanc et
 * porte le mot « Complet » ; un parking fermé ou réservé aux abonnés est un anneau gris ; une donnée de
 * plus d'une demi-heure passe au gris neutre, jauge pointillée.
 */
import type { Color } from '@deck.gl/core';
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { defineModule } from '../core/module';
import type { InfoChart } from '../core/module';
import { measuredStatus, plainStatus } from '../core/infoStatus';
import { PARKING, hexToRgb } from '../design/tokens';
import { declutter, halfZoomBreaks, zoomBand } from '../map/declutter';
import { OVER_MAP } from '../map/parameters';
import { formatRelative } from '../ui/format';
import { HALO, ink, type IconSheet, KEY, packIcons, selectionRing, zoomRamp } from './symbols';

interface ApiParking {
  id: string;
  source: number;
  name: string;
  lon: number;
  lat: number;
  capacity: number | null;
  free: number;
  measuredAt: number | null;
  kind: 'parking' | 'relais';
  status: 'ouvert' | 'complet' | 'ferme' | 'abonnes';
}

interface ApiSource {
  area: string;
  name: string;
  licence: string;
  link: string;
  updatedAt: number | null;
}

export interface Parking extends Omit<ApiParking, 'source' | 'measuredAt'> {
  area: string;
  source: ApiSource;
  /** Heure du relevé (ms) : celle de l'exploitant, sinon celle du dernier relevé de la source. */
  at: number | null;
  /** Relevé de plus d'une demi-heure : la jauge passe au gris. */
  stale: boolean;
}

export interface Area {
  name: string;
  lon: number;
  lat: number;
  parkings: number;
  free: number;
  capacity: number;
}

export interface ParkingsData {
  parkings: Parking[];
  byId: Map<string, Parking>;
  sources: ApiSource[];
  updatedAt: number;
}

type Level = 0 | 1 | 2 | 3;
type Types = 'tous' | 'parkings' | 'relais';

const STALE_MS = 30 * 60_000;
const LEVELS: Array<{ color: [number, number, number]; css: string; text: [number, number, number]; label: string }> = PARKING.jour.map((css, i) => ({
  color: hexToRgb(css),
  css,
  text: (i < 2 ? [22, 26, 38] : [255, 255, 255]) as [number, number, number],
  label: ['Au moins 40 % de places libres', '15 à 40 % de places libres', 'Moins de 15 % de places libres', 'Complet'][i]!,
}));
const STALE_CSS = '#a3a7b3';
const STALE_COLOR: [number, number, number] = [163, 167, 179];
const CLOSED: Color = [120, 124, 134, 230];

/** Zooms : agglomérations (disque), points, jauges, nombres. */
const POINT_MIN_ZOOM = 10.5;
const GAUGE_MIN_ZOOM = 12;
const LABEL_MIN_ZOOM = 14;
const LABEL_BOX_PX = { width: 64, height: 26 };

const isOut = (p: Parking) => p.status === 'ferme' || p.status === 'abonnes';
const isFull = (p: Parking) => p.status === 'complet';

function share(p: Parking): number | null {
  return p.capacity ? Math.min(1, p.free / p.capacity) : null;
}

function levelOf(p: Parking): Level {
  if (isFull(p)) return 3;
  const s = share(p);
  if (s === null) return p.free >= 50 ? 0 : p.free >= 10 ? 1 : 2;
  return s >= 0.4 ? 0 : s >= 0.15 ? 1 : 2;
}

function matchesTypes(p: Parking, types: Types): boolean {
  return types === 'tous' || (types === 'relais' ? p.kind === 'relais' : p.kind === 'parking');
}

// --- Jauge ---

const GAUGE_STEPS = 12;
const GAUGE_SCALE = 1.4;
const GAUGE_R = { disc: 26, fill: 22, hole: 11 };
const GAUGE_CELL = Math.ceil((2 * (GAUGE_R.disc + 1 + 2.4) + 1) * GAUGE_SCALE);
const gaugeKey = (level: Level | 'ancien', step: number) => `jauge:${level}:${step}`;
const CLOSED_KEY = 'jauge:ferme';
const FULL_KEY = 'jauge:complet';

let gauges: IconSheet | undefined;
function gaugeSheet(): IconSheet {
  if (gauges) return gauges;
  const cells: Parameters<typeof packIcons>[0][number][] = [];
  const disc = (c: CanvasRenderingContext2D) => {
    c.beginPath();
    c.arc(0, 0, GAUGE_R.disc, 0, Math.PI * 2);
  };
  const hole = (c: CanvasRenderingContext2D) => {
    c.beginPath();
    c.arc(0, 0, GAUGE_R.hole, 0, Math.PI * 2);
  };
  const frame = (draw: (c: CanvasRenderingContext2D) => void) => (c: CanvasRenderingContext2D) => {
    c.translate(GAUGE_CELL / 2, GAUGE_CELL / 2);
    c.scale(GAUGE_SCALE, GAUGE_SCALE);
    draw(c);
  };
  const pie = (c: CanvasRenderingContext2D, step: number, css: string) => {
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, GAUGE_R.fill, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * step) / GAUGE_STEPS);
    c.closePath();
    c.fillStyle = css;
    c.fill();
  };
  const add = (key: string, css: string, step: number, dashed = false) =>
    cells.push({
      key,
      width: GAUGE_CELL,
      height: GAUGE_CELL,
      draw: frame((c) => {
        ink(c, disc, '#ffffff', { key: 2 });
        if (step > 0) pie(c, step, css);
        ink(c, hole, '#ffffff', { key: 1.4, noHalo: true });
        if (dashed) {
          // Donnée ancienne : un liseré pointillé autour de la jauge.
          c.beginPath();
          c.arc(0, 0, GAUGE_R.fill + 3.5, 0, Math.PI * 2);
          c.setLineDash([4, 4]);
          c.strokeStyle = '#4b5060';
          c.lineWidth = 1.6;
          c.stroke();
        }
      }),
    });
  for (const level of [0, 1, 2] as const) for (let step = 1; step <= GAUGE_STEPS; step++) add(gaugeKey(level, step), LEVELS[level]!.css, step);
  for (let step = 1; step <= GAUGE_STEPS; step++) add(gaugeKey('ancien', step), STALE_CSS, step, true);
  add(gaugeKey(0, 0), LEVELS[0]!.css, 0);
  // Complet : l'anneau plein et foncé, une barre blanche en travers (comme un sens interdit).
  cells.push({
    key: FULL_KEY,
    width: GAUGE_CELL,
    height: GAUGE_CELL,
    draw: frame((c) => {
      ink(c, disc, '#ffffff', { key: 2 });
      pie(c, GAUGE_STEPS, LEVELS[3]!.css);
      c.beginPath();
      c.arc(0, 0, GAUGE_R.hole + 3, 0, Math.PI * 2);
      c.fillStyle = '#ffffff';
      c.fill();
      c.fillStyle = LEVELS[3]!.css;
      c.beginPath();
      c.roundRect(-GAUGE_R.hole - 1, -4, 2 * GAUGE_R.hole + 2, 8, 2);
      c.fill();
    }),
  });
  cells.push({
    key: CLOSED_KEY,
    width: GAUGE_CELL,
    height: GAUGE_CELL,
    draw: frame((c) => {
      c.beginPath();
      c.arc(0, 0, GAUGE_R.fill, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(255,255,255,0.93)';
      c.lineWidth = 8;
      c.stroke();
      c.strokeStyle = '#787c86';
      c.lineWidth = 3.5;
      c.stroke();
    }),
  });
  gauges = packIcons(cells);
  return gauges;
}

function gaugeIcon(p: Parking): string {
  if (isOut(p)) return CLOSED_KEY;
  if (isFull(p)) return FULL_KEY;
  if (p.free === 0) return FULL_KEY;
  const s = share(p);
  const level = levelOf(p);
  // Sans capacité : une part indicative selon le niveau, pour ne pas inventer un rapport.
  const step = Math.max(1, Math.round((s ?? [0.75, 0.4, 0.15][level]!) * GAUGE_STEPS));
  return gaugeKey(p.stale ? 'ancien' : level, step);
}

const colorOf = (p: Parking): [number, number, number] => (p.stale ? STALE_COLOR : LEVELS[levelOf(p)]!.color);

function labelText(p: Parking): string {
  if (p.status === 'ferme') return 'Fermé';
  if (p.status === 'abonnes') return 'Abonnés';
  return isFull(p) ? 'Complet' : String(p.free);
}

// --- Chargement ---

async function loadParkings(signal: AbortSignal): Promise<ParkingsData> {
  const response = await fetch('/api/parkings', { signal });
  if (response.status === 503) throw new Error('le serveur rassemble encore les parkings, nouvel essai dans une minute');
  if (!response.ok) throw new Error(`le serveur des parkings a répondu ${response.status}`);
  const json = (await response.json()) as { updatedAt: number; sources: ApiSource[]; parkings: ApiParking[] };
  const now = Date.now();
  const parkings: Parking[] = json.parkings.map(({ source, measuredAt, ...p }) => {
    const src = json.sources[source]!;
    const at = measuredAt !== null ? measuredAt * 1000 : src.updatedAt !== null ? src.updatedAt * 1000 : null;
    return { ...p, area: src.area, source: src, at, stale: at === null || now - at > STALE_MS };
  });
  return { parkings, byId: new Map(parkings.map((p) => [p.id, p])), sources: json.sources, updatedAt: json.updatedAt * 1000 };
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

let areaCache: { data: ParkingsData; types: Types; areas: Area[] } | undefined;
/** Une agglomération = un disque de loin : places libres des parkings en service, position médiane. */
function areasOf(data: ParkingsData, types: Types): Area[] {
  if (areaCache?.data === data && areaCache.types === types) return areaCache.areas;
  const groups = new Map<string, Parking[]>();
  for (const p of data.parkings) if (matchesTypes(p, types)) (groups.get(p.area) ?? groups.set(p.area, []).get(p.area)!).push(p);
  const areas: Area[] = [...groups].map(([name, list]) => {
    const open = list.filter((p) => !isOut(p));
    return {
      name,
      lon: median(list.map((p) => p.lon)),
      lat: median(list.map((p) => p.lat)),
      parkings: list.length,
      free: open.reduce((sum, p) => sum + p.free, 0),
      capacity: open.reduce((sum, p) => sum + (p.capacity ?? 0), 0),
    };
  });
  areaCache = { data, types, areas };
  return areas;
}

function areaLevel(a: Area): Level {
  if (a.capacity <= 0) return 1;
  const s = a.free / a.capacity;
  return s >= 0.4 ? 0 : s >= 0.15 ? 1 : 2;
}

const number = (n: number) => n.toLocaleString('fr-FR');

let labelCache: { data: ParkingsData; types: Types; band: number; items: Parking[] } | undefined;
function labelled(data: ParkingsData, types: Types, zoom: number): Parking[] {
  const band = zoomBand(zoom);
  if (labelCache?.data !== data || labelCache.types !== types || labelCache.band !== band) {
    const items = declutter(
      data.parkings.filter((p) => matchesTypes(p, types)),
      zoom,
      { lon: (p) => p.lon, lat: (p) => p.lat, rank: (p) => (isFull(p) ? -1e6 : p.stale ? 1e6 : -p.free), box: LABEL_BOX_PX },
    );
    labelCache = { data, types, band, items };
  }
  return labelCache.items;
}

// --- Courbe de la journée (gardée par le serveur depuis son démarrage) ---

interface Curve {
  at: number;
  points: Array<readonly [number, number]>;
  loading: boolean;
}
const curves = new Map<string, Curve>();
const CURVE_REFRESH_MS = 5 * 60_000;

/** La courbe en cache ; son chargement part à la première demande, et se refait toutes les 5 minutes tant que la fiche reste ouverte. */
function curveOf(id: string): Curve | undefined {
  const known = curves.get(id);
  if (known && (known.loading || Date.now() - known.at < CURVE_REFRESH_MS)) return known;
  const entry: Curve = { at: Date.now(), points: known?.points ?? [], loading: true };
  curves.set(id, entry);
  void fetch(`/api/parkings/courbe?id=${encodeURIComponent(id)}`)
    .then((r) => (r.ok ? (r.json() as Promise<{ points: Array<[number, number]> }>) : Promise.reject(new Error(String(r.status)))))
    .then((json) => {
      entry.points = json.points.map(([t, v]) => [t * 1000, v] as const);
    })
    .catch(() => undefined)
    .finally(() => {
      entry.loading = false;
      entry.at = Date.now();
    });
  return entry;
}

function chartOf(p: Parking, time: number): InfoChart | undefined {
  const points = curveOf(p.id)?.points ?? [];
  if (points.length < 3) return undefined;
  const lowest = Math.min(...points.map((q) => q[1]));
  const highest = Math.max(...points.map((q) => q[1]));
  return {
    title: 'Places libres : relevés gardés par le serveur (24 h au plus)',
    unit: 'places',
    points,
    now: time,
    integer: true,
    hourStep: points.at(-1)![0] - points[0]![0] > 12 * 3600_000 ? 6 : 2,
    summary: `Places libres à ${p.name} : de ${lowest} à ${highest} sur la période relevée.`,
  };
}

export const parkings = defineModule<ParkingsData>({
  id: 'parkings',
  name: 'Parkings',
  category: 'transport',
  description: 'Places libres en direct dans les parkings et parcs relais des villes qui publient leurs données.',
  attribution: 'Rennes Métropole, STAR, Nantes Métropole, Strasbourg, Bordeaux Métropole, Clermont Auvergne Métropole, Tours Métropole, Aix-Marseille-Provence, Orléans Métropole, Grenoble-Alpes Métropole (données ouvertes)',
  refreshIntervalMs: 60_000,
  timeStepMs: 3_600_000, // état du moment : ne dépend pas de l'instant affiché
  zoomBreaks: [POINT_MIN_ZOOM, ...halfZoomBreaks(GAUGE_MIN_ZOOM)],
  followsTerrain: true,

  settings: [
    {
      id: 'types',
      label: 'Afficher',
      options: [
        { value: 'tous', label: 'Tous' },
        { value: 'parkings', label: 'Parkings' },
        { value: 'relais', label: 'Parcs relais' },
      ],
      defaultValue: 'tous',
    },
  ],

  legend() {
    return [
      ...LEVELS.map((l) => ({ color: l.css, label: l.label, size: 'small' as const })),
      { color: STALE_CSS, label: 'Relevé de plus de 30 minutes', size: 'small' as const },
      { color: 'transparent', label: 'Fermé ou réservé aux abonnés (anneau)', size: 'small' as const },
    ];
  },

  load: ({ signal }) => loadParkings(signal),

  summary({ data, settings }) {
    if (!data) return null;
    const list = data.parkings.filter((p) => matchesTypes(p, settings.types as Types) && !isOut(p));
    const free = list.reduce((sum, p) => sum + p.free, 0);
    const full = list.filter(isFull).length;
    const areas = new Set(list.map((p) => p.area)).size;
    return `${number(list.length)} parkings dans ${areas} agglomérations · ${number(free)} places libres${full ? ` · ${full} complets` : ''}`;
  },

  deckLayers({ data, settings, selection, view, terrain }) {
    if (!data) return [];
    const types = settings.types as Types;
    const shown = data.parkings.filter((p) => matchesTypes(p, types));
    const onGround = (p: Parking): [number, number, number] => [p.lon, p.lat, terrain.elevation(p.lon, p.lat)];
    const chosen = selection && 'id' in (selection as object) ? data.byId.get((selection as { id: string }).id) : undefined;
    const parameters = OVER_MAP;
    const gaugeLayers = view.zoom >= GAUGE_MIN_ZOOM;
    const gaugeSize = zoomRamp(view.zoom, GAUGE_MIN_ZOOM, 15, 22, 34);
    const sheet = gaugeLayers ? gaugeSheet() : undefined;
    const showLabels = view.zoom >= LABEL_MIN_ZOOM;
    const overview = view.zoom < POINT_MIN_ZOOM;
    const areas = overview ? areasOf(data, types) : [];
    const areaPosition = (a: Area): [number, number, number] => [a.lon, a.lat, 0];

    return [
      // De loin : un disque par agglomération, avec son nom et le total de places libres.
      overview &&
        new ScatterplotLayer<Area>({
          id: 'parkings/agglomerations-halo',
          data: areas,
          getPosition: areaPosition,
          radiusUnits: 'pixels',
          getRadius: (a) => 17 + Math.min(10, Math.sqrt(a.parkings) * 2.2) + 3,
          getFillColor: HALO,
          billboard: true,
          parameters,
        }),
      overview &&
        new ScatterplotLayer<Area>({
          id: 'parkings/agglomerations',
          data: areas,
          getPosition: areaPosition,
          radiusUnits: 'pixels',
          getRadius: (a) => 17 + Math.min(10, Math.sqrt(a.parkings) * 2.2),
          getFillColor: (a) => LEVELS[areaLevel(a)]!.color,
          stroked: true,
          getLineColor: KEY,
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          billboard: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 140],
          parameters,
        }),
      overview &&
        new TextLayer<Area>({
          id: 'parkings/agglomerations-places',
          data: areas,
          getPosition: areaPosition,
          getText: (a) => number(a.free),
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 700,
          getSize: 12.5,
          getColor: (a) => LEVELS[areaLevel(a)]!.text,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          billboard: true,
          characterSet: 'auto',
          parameters,
        }),
      overview &&
        new TextLayer<Area>({
          id: 'parkings/agglomerations-noms',
          data: areas,
          getPosition: areaPosition,
          getText: (a) => a.name,
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 600,
          getSize: 12,
          getColor: [22, 26, 38, 255],
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'top',
          getPixelOffset: (a) => [0, 22 + Math.min(10, Math.sqrt(a.parkings) * 2.2)],
          outlineWidth: 3,
          outlineColor: [255, 255, 255, 235],
          fontSettings: { sdf: true },
          billboard: true,
          characterSet: 'auto',
          parameters,
        }),
      // Entre les deux : un point par parking.
      !overview &&
        !gaugeLayers &&
        new ScatterplotLayer<Parking>({
          id: 'parkings/points-halo',
          data: shown,
          getPosition: onGround,
          radiusUnits: 'pixels',
          getRadius: 6,
          getFillColor: HALO,
          billboard: true,
          updateTriggers: { getPosition: terrain.version },
          parameters,
        }),
      !overview &&
        !gaugeLayers &&
        new ScatterplotLayer<Parking>({
          id: 'parkings/points',
          data: shown,
          getPosition: onGround,
          radiusUnits: 'pixels',
          getRadius: 4.2,
          getFillColor: (p) => (isOut(p) ? [0, 0, 0, 0] : isFull(p) ? [...LEVELS[3]!.color, 255] : [...colorOf(p), 255]),
          stroked: true,
          getLineColor: (p) => (isOut(p) ? CLOSED : KEY),
          lineWidthUnits: 'pixels',
          getLineWidth: (p) => (isOut(p) ? 2 : 1),
          billboard: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 160],
          updateTriggers: { getPosition: terrain.version },
          parameters,
        }),
      // De près : la jauge de places libres.
      sheet &&
        new IconLayer<Parking>({
          id: 'parkings/jauges',
          data: shown,
          iconAtlas: sheet.atlas,
          iconMapping: sheet.mapping,
          getIcon: gaugeIcon,
          getPosition: onGround,
          sizeUnits: 'pixels',
          getSize: gaugeSize,
          billboard: true,
          pickable: true,
          autoHighlight: !showLabels,
          highlightColor: [255, 255, 255, 120],
          updateTriggers: { getPosition: terrain.version },
          parameters,
        }),
      showLabels &&
        new TextLayer<Parking>({
          id: 'parkings/nombres',
          data: labelled(data, types, view.zoom),
          getPosition: onGround,
          getText: labelText,
          characterSet: 'auto',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 700,
          getSize: 12.5,
          getColor: (p) => (isOut(p) || p.stale ? [22, 26, 38] : LEVELS[levelOf(p)]!.text),
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          getPixelOffset: [gaugeSize / 2 + 3, 0],
          background: true,
          getBackgroundColor: (p) => (isOut(p) || p.stale ? [...STALE_COLOR, 245] : [...LEVELS[levelOf(p)]!.color, 245]),
          getBorderColor: [20, 26, 38, 170],
          getBorderWidth: 1,
          backgroundBorderRadius: 9,
          backgroundPadding: [7, 3],
          billboard: true,
          pickable: true,
          updateTriggers: { getPosition: terrain.version },
          parameters,
        }),
      chosen && selectionRing('parkings/choisi', [chosen], onGround, gaugeLayers ? gaugeSize * 0.62 : 12, parameters),
    ];
  },

  select(object) {
    if (object && typeof object === 'object' && 'parkings' in object) return { area: (object as Area).name };
    return { id: (object as Parking).id };
  },

  describe(selection, { data, time, settings }) {
    if (!data) return null;
    const picked = selection as { id?: string; area?: string };
    if (picked.area) {
      const area = areasOf(data, settings.types as Types).find((a) => a.name === picked.area);
      if (!area) return null;
      const names = [...new Set(data.sources.filter((s) => s.area === area.name).map((s) => s.name))];
      return {
        kind: 'Agglomération',
        title: area.name,
        subtitle: 'Places libres des parkings en service',
        status: measuredStatus(time, data.updatedAt),
        figures: [
          { value: number(area.free), label: 'places libres' },
          { value: String(area.parkings), label: 'parkings' },
          ...(area.capacity > 0 ? [{ value: `${Math.round((1 - area.free / area.capacity) * 100)} %`, label: 'occupé' }] : []),
        ],
        fields: [['Sources', names.join(' · ')]],
        note: 'Zoomez pour voir chaque parking.',
      };
    }
    const p = picked.id ? data.byId.get(picked.id) : undefined;
    if (!p) return null;
    const status = p.stale && p.at !== null ? plainStatus(`Relevé ${formatRelative(p.at)} : donnée ancienne`) : measuredStatus(time, p.at ?? undefined);
    const state = { ouvert: 'Ouvert', complet: 'Complet', ferme: 'Fermé', abonnes: 'Réservé aux abonnés' }[p.status];
    const out = isOut(p);
    return {
      kind: p.kind === 'relais' ? 'Parc relais' : 'Parking',
      title: p.name,
      subtitle: p.area,
      status,
      figures: out
        ? undefined
        : [
            { value: String(p.free), label: 'places libres' },
            ...(p.capacity ? [{ value: String(p.capacity), label: 'capacité' }] : []),
            ...(p.capacity ? [{ value: `${Math.round((1 - Math.min(1, p.free / p.capacity)) * 100)} %`, label: 'occupé' }] : []),
          ],
      chart: out ? undefined : chartOf(p, time),
      fields: [
        ['État', state],
        ['Type', p.kind === 'relais' ? 'Parc relais' : 'Parking'],
        ['Source', p.source.name],
        ['Licence', p.source.licence],
      ],
      note: isFull(p) && p.free > 0 ? `Complet selon l’exploitant, qui l’affiche dès qu’il reste ${p.free} place${p.free > 1 ? 's' : ''} ou moins.` : undefined,
      actions: [{ label: 'Source', href: p.source.link }],
    };
  },
});
