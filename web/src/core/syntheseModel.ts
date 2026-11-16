/**
 * Synthèse « Aujourd'hui en France » : de la réponse de `/api/synthese` (et des séismes de l'EMSC, que le site lit lui-même)
 * à une liste de rubriques triées par gravité, chacune avec ses lignes cliquables.
 *
 * Ce fichier ne touche ni à la carte ni à React : il décrit seulement ce qu'on montre et ce qu'un clic doit faire
 * (`Action`, une donnée), l'interface (`ui/Synthese.tsx`) l'exécute. Aucune couleur ici : la gravité est un cran de 0 à 4,
 * que l'interface montre toujours avec un signe et un mot.
 */
import departements from '../data/departements.json';
import { formatTime } from '../ui/format';

// --- Ce que sert le serveur (server/src/synthese.rs) ---------------------------------------------------------------------

export interface ApiSynthese {
  generatedAt: number;
  vigilance: {
    issuedAt: number;
    periods: Array<{
      name: string;
      begin: number;
      end: number;
      current: boolean;
      orange: number;
      red: number;
      groups: Array<{ phenomenon: number; level: number; departments: string[] }>;
    }>;
  } | null;
  floods: { fetchedAt: number; yellow: number; orange: number; red: number; sections: Array<{ id: string; name: string; level: number; lon: number; lat: number }> } | null;
  rivers: {
    updatedAt: number;
    risingCount: number;
    items: Array<{ id: string; name: string; river?: string; lon: number; lat: number; riseMm: number; heightMm: number; vig?: number }>;
  } | null;
  fires: {
    updatedAt: number;
    detections: number;
    items: Array<{ lon: number; lat: number; time: number; satellite: string; frp: number; totalFrp: number; count: number; latest: number }>;
  } | null;
  planes: {
    updatedAt: number;
    militaryCount: number;
    airborneCount: number;
    items: Array<{ hex: string; callsign?: string; type?: string; lon: number; lat: number; altM?: number }>;
  } | null;
  jamming: {
    updatedAt: number;
    windowS: number;
    coveredS: number;
    cellDeg: number;
    affected: number;
    items: Array<{ lon: number; lat: number; n: number; bad: number; share: number }>;
  } | null;
  air: {
    updatedAt: number;
    day: string;
    badCount: number;
    total: number;
    worst: Array<{ i: number; name: string; lon: number; lat: number; level: number }>;
    episodes: Array<{ zone: string; pol: string; level: number }>;
  } | null;
  trains: {
    feedAt: number;
    running: number;
    late: number;
    veryLate: number;
    canceled: number;
    delayed: ApiTrain[];
    canceledItems: ApiTrain[];
  } | null;
}

interface ApiTrain {
  number: string;
  category: string;
  line: string;
  delayMin: number;
  canceled: boolean;
  firstDeparture: number;
  from: string;
  to: string;
  at: string;
  lon: number;
  lat: number;
}

/** Un séisme tel que la couche des séismes le garde (`modules/earthquakes.ts`), ce dont la synthèse a besoin. */
export interface SynthesisQuake {
  id: string;
  lon: number;
  lat: number;
  depthKm: number;
  mag: number;
  time: number;
  region: string;
}

// --- Le modèle affiché -------------------------------------------------------------------------------------------------

/** 0 rien, 1 à noter, 2 notable (jaune), 3 important (orange), 4 critique (rouge). */
export type Severity = 0 | 1 | 2 | 3 | 4;

/** Ce que fait un clic sur une ligne. */
export type Action =
  /** Affiche la couche, sélectionne l'objet (sa fiche s'ouvre) et centre la carte. */
  | { kind: 'object'; moduleId: string; selection: unknown; lon: number; lat: number; zoom: number }
  /** Affiche la couche et cadre la carte sur ce rectangle (ouest, sud, est, nord). */
  | { kind: 'bounds'; moduleId: string; bounds: [number, number, number, number] }
  /** Affiche la couche et centre la carte. */
  | { kind: 'view'; moduleId: string; lon: number; lat: number; zoom: number };

export interface Row {
  key: string;
  title: string;
  detail?: string;
  /** Niveau officiel de la ligne (vigilance, crues), montré avec son nom : « Orange ». */
  level?: 2 | 3 | 4;
  action?: Action;
}

export type RubricId = 'vigilance' | 'crues' | 'rivieres' | 'incendies' | 'seismes' | 'air' | 'trains' | 'brouillage' | 'avions';

export interface Rubric {
  id: RubricId;
  /** Nom d'icône (`ui/icons.tsx`). */
  icon: string;
  title: string;
  severity: Severity;
  /** Les rubriques de statut officiel (vigilance, crues) nomment la gravité par sa couleur, les autres par un mot. */
  official: boolean;
  /** Une ligne qui résume (compteurs). */
  summary: string;
  rows: Row[];
  /** Ce qu'on dit quand il n'y a rien de notable. */
  calm: string;
  /** Rien à dire plus bas que ce niveau : la rubrique est repliée en une ligne calme. */
  more?: { text: string; action: Action };
}

/** L'ordre des rubriques à gravité égale. */
const ORDER: RubricId[] = ['vigilance', 'crues', 'rivieres', 'incendies', 'seismes', 'air', 'trains', 'brouillage', 'avions'];

export interface Digest {
  /** Rubriques avec quelque chose de notable, les plus graves d'abord. */
  notable: Rubric[];
  /** Rubriques sans rien de notable : une ligne chacune. */
  calm: Rubric[];
  /** Rubriques dont la source n'a pas (encore) répondu : à ne pas confondre avec « calme ». */
  unavailable: string[];
}

// --- Aides ------------------------------------------------------------------------------------------------------------

const nf = (n: number, digits = 0) => n.toLocaleString('fr-FR', { maximumFractionDigits: digits });
const plural = (n: number, one: string, many = `${one}s`) => `${nf(n)} ${n > 1 ? many : one}`;

export const PHENOMENA: Record<number, string> = {
  1: 'Vent violent',
  2: 'Pluie-inondation',
  3: 'Orages',
  4: 'Crues',
  5: 'Neige-verglas',
  6: 'Canicule',
  7: 'Grand froid',
  8: 'Avalanches',
  9: 'Vagues-submersion',
};
const LEVEL_NAME: Record<number, string> = { 2: 'jaune', 3: 'orange', 4: 'rouge' };

/** Niveau de la ligne : un niveau officiel est 2, 3 ou 4. */
const asLevel = (level: number): 2 | 3 | 4 | undefined => (level >= 4 ? 4 : level === 3 ? 3 : level === 2 ? 2 : undefined);
const asSeverity = (n: number): Severity => (n >= 4 ? 4 : n === 3 ? 3 : n === 2 ? 2 : n === 1 ? 1 : 0);

/** Pays entier : pour une action qui n'a pas de lieu précis. */
const FRANCE = { lon: 2.4, lat: 46.6, zoom: 5.4 };

// --- Départements : noms, rectangles, et « dans quel département est ce point ? » -----------------------------------------------

type Ring = number[][];
interface Department {
  code: string;
  name: string;
  polygons: Ring[][];
  bounds: [number, number, number, number];
}

let departmentList: Department[] | undefined;

function loadDepartments(): Department[] {
  if (departmentList) return departmentList;
  const collection = departements as unknown as {
    features: Array<{ properties: { code: string; nom: string }; geometry: { type: string; coordinates: unknown } }>;
  };
  departmentList = collection.features.map((feature) => {
    const polygons = (feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates) as Ring[][];
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const polygon of polygons) {
      for (const [lon, lat] of polygon[0] ?? []) {
        if (lon === undefined || lat === undefined) continue;
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
    }
    return { code: feature.properties.code, name: feature.properties.nom, polygons, bounds: [west, south, east, north] };
  });
  return departmentList;
}

export function departmentByCode(code: string): Department | undefined {
  return loadDepartments().find((department) => department.code === code);
}

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi! > lat !== yj! > lat && lon < ((xj! - xi!) * (lat - yi!)) / (yj! - yi!) + xi!) inside = !inside;
  }
  return inside;
}

/** Le département qui contient ce point, s'il y en a un (en mer ou hors de métropole : `undefined`). */
export function departmentAt(lon: number, lat: number): Department | undefined {
  return loadDepartments().find(({ bounds, polygons }) => {
    if (lon < bounds[0] || lon > bounds[2] || lat < bounds[1] || lat > bounds[3]) return false;
    return polygons.some((polygon) => inRing(lon, lat, polygon[0] ?? []) && !polygon.slice(1).some((hole) => inRing(lon, lat, hole)));
  });
}

const placeOf = (lon: number, lat: number): string | undefined => {
  const department = departmentAt(lon, lat);
  return department ? `${department.name} (${department.code})` : undefined;
};

/** « 48,5° N, 2,0° E » */
const coordinates = (lon: number, lat: number): string =>
  `${nf(Math.abs(lat), 1)}° ${lat >= 0 ? 'N' : 'S'}, ${nf(Math.abs(lon), 1)}° ${lon >= 0 ? 'E' : 'O'}`;

function unionBounds(codes: string[]): [number, number, number, number] | undefined {
  const boxes = codes.map((code) => departmentByCode(code)?.bounds).filter((b): b is [number, number, number, number] => !!b);
  if (boxes.length === 0) return undefined;
  return [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
}

/** « Gironde, Landes et 4 autres » */
function namesOf(codes: string[], shown = 3): string {
  const names = codes.map((code) => departmentByCode(code)?.name ?? code);
  if (names.length <= shown) return names.length > 1 ? `${names.slice(0, -1).join(', ')} et ${names.at(-1)}` : (names[0] ?? '');
  return `${names.slice(0, shown).join(', ')} et ${names.length - shown} autre${names.length - shown > 1 ? 's' : ''}`;
}

/** « il y a 2 h » compact, pour une ligne : « 2 h », « 35 min ». */
function ago(seconds: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - seconds * 1000) / 60_000));
  if (minutes < 2) return 'à l’instant';
  if (minutes < 90) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `il y a ${hours} h` : `il y a ${Math.round(hours / 24)} j`;
}

// --- Rubriques --------------------------------------------------------------------------------------------------------

function vigilanceRubric(data: NonNullable<ApiSynthese['vigilance']>): Rubric {
  const today = data.periods.find((p) => p.current) ?? data.periods[0];
  const tomorrow = data.periods.find((p) => p !== today && p.begin >= (today?.end ?? 0));
  const rows: Row[] = (today?.groups ?? []).map((group) => {
    const single = group.departments.length === 1 ? departmentByCode(group.departments[0]!) : undefined;
    const bounds = unionBounds(group.departments);
    return {
      key: `v-${group.phenomenon}-${group.level}`,
      title: `${PHENOMENA[group.phenomenon] ?? 'Phénomène'} · ${plural(group.departments.length, 'département')}`,
      detail: namesOf(group.departments),
      level: asLevel(group.level),
      action: single
        ? { kind: 'object', moduleId: 'vigilance-meteo', selection: { code: single.code }, lon: (single.bounds[0] + single.bounds[2]) / 2, lat: (single.bounds[1] + single.bounds[3]) / 2, zoom: 7.4 }
        : bounds
          ? { kind: 'bounds', moduleId: 'vigilance-meteo', bounds }
          : { kind: 'view', moduleId: 'vigilance-meteo', ...FRANCE },
    };
  });
  const red = today?.red ?? 0;
  const orange = (today?.orange ?? 0) - red;
  const tomorrowAlert = tomorrow ? tomorrow.orange : 0;
  const todaySeverity = asSeverity(red > 0 ? 4 : orange > 0 ? 3 : 0);
  const parts = [red > 0 ? `${plural(red, 'département')} en rouge` : '', orange > 0 ? `${plural(orange, 'département')} en orange` : ''].filter(Boolean);
  const detail = tomorrow && tomorrowAlert > 0 ? `Demain : ${plural(tomorrowAlert, 'département')} en orange ou rouge (${[...new Set(tomorrow.groups.map((g) => PHENOMENA[g.phenomenon]?.toLowerCase()))].join(', ')})` : '';
  // Demain : une ligne de texte, sans clic (la couche montre le jour de l'horloge, pas le lendemain).
  if (detail) rows.push({ key: 'v-demain', title: detail });
  return {
    id: 'vigilance',
    icon: 'vigilance-meteo',
    title: 'Vigilance météo',
    severity: todaySeverity === 0 && detail ? 1 : todaySeverity,
    official: true,
    summary: parts.join(', ') || 'Pas d’orange ni de rouge aujourd’hui',
    rows,
    calm: 'Aucune vigilance orange ou rouge',
  };
}

function floodsRubric(data: NonNullable<ApiSynthese['floods']>): Rubric {
  const total = data.yellow + data.orange + data.red;
  const rows: Row[] = data.sections.map((section) => ({
    key: `c-${section.id}`,
    title: section.name,
    level: asLevel(section.level),
    action: { kind: 'object', moduleId: 'vigicrues', selection: { id: section.id }, lon: section.lon, lat: section.lat, zoom: 9 },
  }));
  const parts = [
    data.red > 0 ? `${plural(data.red, 'tronçon')} en rouge` : '',
    data.orange > 0 ? `${data.red > 0 ? nf(data.orange) : plural(data.orange, 'tronçon')} en orange` : '',
    data.yellow > 0 ? `${data.red + data.orange > 0 ? nf(data.yellow) : plural(data.yellow, 'tronçon')} en jaune` : '',
  ].filter(Boolean);
  return {
    id: 'crues',
    icon: 'vigicrues',
    title: 'Vigilance crues',
    severity: asSeverity(data.red > 0 ? 4 : data.orange > 0 ? 3 : data.yellow > 0 ? 2 : 0),
    official: true,
    summary: parts.join(', '),
    rows,
    calm: 'Aucun tronçon en vigilance crues',
    more: total > rows.length ? { text: `et ${nf(total - rows.length)} autres tronçons en vigilance`, action: { kind: 'view', moduleId: 'vigicrues', ...FRANCE } } : undefined,
  };
}

function riversRubric(data: NonNullable<ApiSynthese['rivers']>): Rubric {
  const rows: Row[] = data.items.map((station) => ({
    key: `r-${station.id}`,
    title: station.name,
    detail: `${station.river ? `${station.river} · ` : ''}+${nf(station.riseMm / 10)} cm en 3 h · ${nf(station.heightMm / 1000, 2)} m`,
    level: station.vig ? asLevel(station.vig) : undefined,
    action: { kind: 'object', moduleId: 'rivieres', selection: { id: station.id }, lon: station.lon, lat: station.lat, zoom: 11 },
  }));
  const worst = Math.max(0, ...data.items.map((s) => s.vig ?? 0));
  return {
    id: 'rivieres',
    icon: 'rivieres',
    title: 'Rivières en forte montée',
    severity: data.risingCount > 0 ? (worst >= 3 ? 3 : 2) : 0,
    official: false,
    summary: `${plural(data.risingCount, 'station')} : 30 cm ou plus en 3 h`,
    rows,
    calm: 'Aucune rivière en forte montée',
    more: data.risingCount > rows.length ? { text: `et ${nf(data.risingCount - rows.length)} autres stations`, action: { kind: 'view', moduleId: 'rivieres', ...FRANCE } } : undefined,
  };
}

const MAX_FIRE_ROWS = 4;

function firesRubric(data: NonNullable<ApiSynthese['fires']>, now: number): Rubric {
  // Le carré de détection déborde sur les pays voisins : seuls les foyers situés dans un département comptent ici.
  const inFrance = data.items.filter((fire) => departmentAt(fire.lon, fire.lat)).slice(0, MAX_FIRE_ROWS);
  const rows: Row[] = inFrance.map((fire) => ({
    key: `f-${fire.satellite}-${fire.time}-${fire.lon}-${fire.lat}`,
    title: placeOf(fire.lon, fire.lat) ?? coordinates(fire.lon, fire.lat),
    detail: `${nf(fire.totalFrp)} MW · ${plural(fire.count, 'détection')} · ${ago(fire.latest, now)}`,
    // La clé de la fiche est celle de la couche : satellite, heure, position de la détection.
    action: { kind: 'object', moduleId: 'feux', selection: { key: `${fire.satellite}|${fire.time}|${fire.lon}|${fire.lat}` }, lon: fire.lon, lat: fire.lat, zoom: 10.5 },
  }));
  const strongest = Math.max(0, ...inFrance.map((f) => f.totalFrp));
  return {
    id: 'incendies',
    icon: 'feux',
    title: 'Incendies actifs',
    severity: rows.length === 0 ? 0 : strongest >= 100 ? 3 : 2,
    official: false,
    summary: `${plural(rows.length, 'foyer')} notable${rows.length > 1 ? 's' : ''} sur 24 h, vus par satellite`,
    rows,
    calm: data.detections > 0 ? `Aucun incendie notable (${plural(data.detections, 'petite détection', 'petites détections')} sur 24 h)` : 'Aucun incendie détecté sur 24 h',
  };
}

/** Séismes : à partir de la magnitude 3, on les sent ; en dessous, la rubrique reste calme. */
const QUAKE_NOTABLE_MAG = 3;
const QUAKE_WINDOW_MS = 72 * 3_600_000;
const SMALL_WORDS = new Set(['of', 'the', 'and', 'off', 'near']);

/** « NEAR SOUTH COAST OF FRANCE » → « Near South Coast of France » */
function titleCase(text: string): string {
  return text
    .toLowerCase()
    .split(' ')
    .map((word, i) => (i > 0 && SMALL_WORDS.has(word) ? word : word.replace(/(^|-)\p{L}/gu, (m) => m.toUpperCase())))
    .join(' ');
}

function quakesRubric(quakes: SynthesisQuake[], now: number): Rubric {
  const recent = quakes.filter((q) => now - q.time < QUAKE_WINDOW_MS && q.time <= now + 60_000 && q.mag >= QUAKE_NOTABLE_MAG).sort((a, b) => b.mag - a.mag || b.time - a.time);
  const top = recent.slice(0, 3);
  const strongest = top[0]?.mag ?? 0;
  return {
    id: 'seismes',
    icon: 'seismes',
    title: 'Séismes récents',
    severity: recent.length === 0 ? 0 : strongest >= 4.5 ? 3 : 2,
    official: false,
    summary: `${plural(recent.length, 'séisme')} de magnitude ${QUAKE_NOTABLE_MAG} ou plus en 3 jours, en France et autour`,
    rows: top.map((q) => ({
      key: `s-${q.id}`,
      title: `M ${nf(q.mag, 1)} · ${titleCase(q.region)}`,
      detail: `${ago(q.time / 1000, now)} · ${nf(q.depthKm)} km de profondeur`,
      action: { kind: 'object', moduleId: 'seismes', selection: { id: q.id }, lon: q.lon, lat: q.lat, zoom: 7 },
    })),
    calm: `Aucun séisme de magnitude ${QUAKE_NOTABLE_MAG} ou plus en 3 jours`,
    more: recent.length > top.length ? { text: `et ${nf(recent.length - top.length)} autres`, action: { kind: 'view', moduleId: 'seismes', ...FRANCE } } : undefined,
  };
}

const POLLUTANTS: Record<string, string> = {
  O3: 'ozone',
  NO2: 'dioxyde d’azote',
  PM10: 'particules PM10',
  'PM2.5': 'particules fines PM2.5',
  SO2: 'dioxyde de soufre',
};
const EPISODE_LEVEL: Record<number, string> = { 1: 'information et recommandation', 2: 'alerte', 3: 'alerte sur persistance' };
const AIR_LEVEL: Record<number, string> = { 4: 'mauvais', 5: 'très mauvais', 6: 'extrêmement mauvais' };

function airRubric(data: NonNullable<ApiSynthese['air']>): Rubric {
  const capital = (text: string) => text.replace(/^./, (c) => c.toUpperCase());
  const episodes: Row[] = data.episodes.map((episode, i) => ({
    key: `a-e${i}`,
    title: `Épisode de pollution : ${POLLUTANTS[episode.pol] ?? episode.pol}`,
    detail: `${titleCase(episode.zone.toLowerCase())} · ${EPISODE_LEVEL[episode.level] ?? 'épisode'}`,
    action: { kind: 'view', moduleId: 'air', ...FRANCE },
  }));
  const zones: Row[] = data.worst.map((zone) => ({
    key: `a-z${zone.i}`,
    title: titleCase(zone.name),
    detail: capital(`indice ${AIR_LEVEL[zone.level] ?? zone.level}`),
    action: { kind: 'object', moduleId: 'air', selection: { i: zone.i }, lon: zone.lon, lat: zone.lat, zoom: 9 },
  }));
  const alert = data.episodes.some((e) => e.level >= 2);
  const worst = Math.max(0, ...data.worst.map((z) => z.level));
  const severity = asSeverity(alert || worst >= 5 ? 3 : data.episodes.length > 0 || data.badCount > 0 ? 2 : 0);
  const summary = [
    data.badCount > 0 ? `${plural(data.badCount, 'zone')} à l’indice mauvais ou pire` : '',
    data.episodes.length > 0 ? plural(data.episodes.length, 'épisode de pollution', 'épisodes de pollution') : '',
  ].filter(Boolean);
  return {
    id: 'air',
    icon: 'air',
    title: 'Qualité de l’air',
    severity,
    official: false,
    summary: summary.join(' · '),
    rows: [...episodes, ...zones],
    calm: 'Air : aucun indice mauvais ni épisode de pollution aujourd’hui',
  };
}

const trainName = (t: ApiTrain) => `${t.category ? `${t.category} ` : ''}${t.number}`;

function trainsRubric(data: NonNullable<ApiSynthese['trains']>): Rubric {
  const delayed: Row[] = data.delayed.map((t) => ({
    key: `t-${t.number}-${t.firstDeparture}`,
    title: `${trainName(t)} · +${nf(t.delayMin)} min`,
    detail: `${t.from} → ${t.to}`,
    action: { kind: 'object', moduleId: 'trains', selection: { type: 'train', id: `${t.number}@${t.firstDeparture}` }, lon: t.lon, lat: t.lat, zoom: 9.5 },
  }));
  const canceled: Row[] = data.canceledItems.slice(0, 3).map((t) => ({
    key: `t-x-${t.number}-${t.firstDeparture}`,
    title: `${trainName(t)} · supprimé`,
    detail: `${t.from} → ${t.to} · départ prévu à ${formatTime(t.firstDeparture * 1000)}`,
    // Un train supprimé ne roule pas : la couche ouvre sa gare de départ (le tableau des départs le montre supprimé).
    action: { kind: 'object', moduleId: 'trains', selection: { type: 'gare', key: `${t.at}|${t.lon.toFixed(4)}|${t.lat.toFixed(4)}` }, lon: t.lon, lat: t.lat, zoom: 11 },
  }));
  const worst = Math.max(0, ...data.delayed.map((t) => t.delayMin));
  const summary = [
    `${plural(data.late, 'train')} en retard de 15 min ou plus sur ${nf(data.running)} en circulation`,
    data.canceled > 0 ? plural(data.canceled, 'suppression', 'suppressions') : '',
  ].filter(Boolean);
  return {
    id: 'trains',
    icon: 'trains',
    title: 'Trains',
    severity: delayed.length + canceled.length === 0 ? 0 : worst >= 90 || data.canceled >= 15 ? 3 : 2,
    official: false,
    summary: summary.join(' · '),
    rows: [...delayed, ...canceled],
    calm: data.running > 0 ? `Aucun train en retard de plus de 30 min (${nf(data.running)} en circulation)` : 'Aucun train en retard ni supprimé',
  };
}

function jammingRubric(data: NonNullable<ApiSynthese['jamming']>): Rubric {
  const rows: Row[] = data.items.map((cell) => ({
    key: `j-${cell.lon}-${cell.lat}`,
    title: placeOf(cell.lon + data.cellDeg / 2, cell.lat + data.cellDeg / 2) ?? coordinates(cell.lon + data.cellDeg / 2, cell.lat + data.cellDeg / 2),
    detail: `${plural(cell.bad, 'avion')} sur ${nf(cell.n)} à la position dégradée (${nf(cell.share * 100)} %)`,
    action: { kind: 'object', moduleId: 'brouillage-gps', selection: { key: `${cell.lon},${cell.lat}` }, lon: cell.lon + data.cellDeg / 2, lat: cell.lat + data.cellDeg / 2, zoom: 6.5 },
  }));
  const worst = Math.max(0, ...data.items.map((c) => c.share));
  return {
    id: 'brouillage',
    icon: 'brouillage-gps',
    title: 'Brouillage GPS',
    severity: data.affected === 0 ? 0 : worst >= 0.25 ? 3 : 2,
    official: false,
    summary: `${plural(data.affected, 'zone')} touchée${data.affected > 1 ? 's' : ''} (estimation sur ${nf(Math.round(data.windowS / 60))} min)`,
    rows,
    calm: data.coveredS < data.windowS / 2 ? `Aucun brouillage GPS détecté (relevés depuis ${nf(Math.round(data.coveredS / 60))} min seulement)` : 'Aucun brouillage GPS détecté',
    more: data.affected > rows.length ? { text: `et ${nf(data.affected - rows.length)} autres zones`, action: { kind: 'view', moduleId: 'brouillage-gps', ...FRANCE } } : undefined,
  };
}

function planesRubric(data: NonNullable<ApiSynthese['planes']>): Rubric {
  const rows: Row[] = data.items.map((plane) => ({
    key: `p-${plane.hex}`,
    title: plane.callsign ?? `ICAO ${plane.hex.toUpperCase()}`,
    detail: [plane.type, plane.altM !== undefined ? `${nf(plane.altM)} m` : undefined].filter(Boolean).join(' · ') || undefined,
    action: { kind: 'object', moduleId: 'avions', selection: { hex: plane.hex }, lon: plane.lon, lat: plane.lat, zoom: 8 },
  }));
  return {
    id: 'avions',
    icon: 'avions',
    title: 'Avions militaires',
    severity: data.militaryCount > 0 ? 1 : 0,
    official: false,
    summary: `${plural(data.militaryCount, 'avion')} militaire${data.militaryCount > 1 ? 's' : ''} en vol sur ${nf(data.airborneCount)} captés`,
    rows,
    calm: 'Aucun avion militaire en vol capté',
    more: data.militaryCount > rows.length ? { text: `et ${nf(data.militaryCount - rows.length)} autres`, action: { kind: 'view', moduleId: 'avions', ...FRANCE } } : undefined,
  };
}

/** La synthèse : rubriques notables triées par gravité, rubriques calmes, et sources muettes. */
export function buildDigest(api: ApiSynthese, quakes: SynthesisQuake[] | null, now: number): Digest {
  const rubrics: Rubric[] = [];
  const unavailable: string[] = [];
  const add = <T>(source: T | null, label: string, build: (data: T) => Rubric) => {
    if (source) rubrics.push(build(source));
    else unavailable.push(label);
  };
  add(api.vigilance, 'vigilance météo', vigilanceRubric);
  add(api.floods, 'crues', floodsRubric);
  add(api.rivers, 'rivières', riversRubric);
  add(api.fires, 'incendies', (data) => firesRubric(data, now));
  if (quakes) rubrics.push(quakesRubric(quakes, now));
  else unavailable.push('séismes');
  add(api.air, 'qualité de l’air', airRubric);
  add(api.trains, 'trains', trainsRubric);
  add(api.jamming, 'brouillage GPS', jammingRubric);
  add(api.planes, 'avions', planesRubric);

  const byOrder = (a: Rubric, b: Rubric) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id);
  return {
    notable: rubrics.filter((r) => r.severity > 0).sort((a, b) => b.severity - a.severity || byOrder(a, b)),
    calm: rubrics.filter((r) => r.severity === 0).sort(byOrder),
    unavailable,
  };
}

/** Le nom de la gravité d'une rubrique : la couleur officielle pour les statuts, un mot pour le reste. */
export function severityLabel(rubric: Pick<Rubric, 'official' | 'severity' | 'id'>): string {
  if (rubric.id === 'vigilance' && rubric.severity === 1) return 'Demain';
  if (rubric.official) return (LEVEL_NAME[rubric.severity] ?? 'À noter').replace(/^./, (c) => c.toUpperCase());
  return ({ 1: 'À noter', 2: 'Notable', 3: 'Important', 4: 'Critique' } as Record<number, string>)[rubric.severity] ?? '';
}
export const levelLabel = (level: 2 | 3 | 4): string => LEVEL_NAME[level]!.replace(/^./, (c) => c.toUpperCase());
