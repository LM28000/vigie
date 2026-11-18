/**
 * Module « Qualité de l'air » : l'indice ATMO de chaque commune (ou intercommunalité, selon
 * l'association régionale) de métropole, et les épisodes de pollution en cours.
 *
 * Source : Atmo Data (Atmo France), qui agrège les flux ouverts des associations agréées de
 * surveillance de la qualité de l'air (AASQA). Le serveur la relève toutes les heures
 * (server/src/air.rs) : l'indice est publié une fois par jour, vers 12–14 h, pour le jour
 * même et les jours qui viennent. Il n'y a pas d'historique : avant le premier jour publié,
 * la carte est vide et le dit.
 *
 * Forme : une couche MapLibre native (cercles flous sous les étiquettes du fond de carte). Il y a
 * près de 29 000 points, espacés de quelques kilomètres : de loin, des cercles qui se recouvrent
 * forment un champ de couleur continu ; de près, ils se resserrent en pastilles nettes autour des
 * communes. Les plus mauvais indices sont dessinés par-dessus pour ne jamais être masqués par
 * leurs voisins. Les intercommunalités (Occitanie, Pays de la Loire, Bretagne…) n'ont qu'un point
 * pour tout un territoire : leur cercle est plus grand.
 *
 * Couleurs : la palette officielle de l'indice ATMO (2021), que le public connaît. Elle n'est
 * jamais seule : la légende, la fiche et le résumé donnent le libellé du niveau.
 *
 * Mesures des stations (LCSQA / Geod'air, server/src/air_mesures.rs) : en complément de l'indice, qui
 * est calculé et prévu, les concentrations horaires réellement mesurées aux stations officielles
 * (NO2, O3, PM10, PM2.5, SO2). Un point par station, de la couleur de son pire sous-indice ATMO
 * (seuils du 1er janvier 2021, appliqués à la valeur horaire : une approximation, dite dans la fiche),
 * posé par-dessus le champ de l'indice. Même palette : les deux vues se lisent comme un seul système.
 * Le réglage « Afficher » en montre l'une, l'autre ou les deux (par défaut les deux : c'est leur écart
 * qui est instructif, par exemple un indice prévu bon et un pic d'ozone mesuré) ; « Polluant » choisit
 * ce que les points montrent. Une mesure de plus de 3 h est estompée et signalée.
 * Le code sans carte (seuils, valeur d'une station à un instant) est dans `airMesures.ts`.
 */
import { STATUS } from '../design/tokens';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { plainStatus, scheduledStatus } from '../core/infoStatus';
import { defineModule, type InfoContent, type LegendItem } from '../core/module';
import { firstSymbolLayerId } from '../map/baseMap';
import { formatTime } from '../ui/format';
import departements from '../data/departements.json';
import { measuredStatus } from '../core/infoStatus';
import {
  POLLUTANTS as MEASURED,
  STALE_MS,
  prepareMesures,
  readingAt,
  slotAt,
  slotEndMs,
  stationState,
  valueText,
  type ApiMesures,
  type Mesures,
  type Reading,
  type StationState,
} from './airMesures';

// --- Données du serveur ----------------------------------------------------------------------

interface ApiEpisode {
  zone: string;
  /** « O3 », « NO2 », « PM10 », « PM2.5 », « SO2 ». */
  pol: string;
  /** 1 information et recommandation, 2 alerte, 3 alerte sur persistance. */
  level: number;
  day: string;
}

interface ApiAir {
  updatedAt: number;
  issuedAt?: number;
  days: string[];
  sources: string[];
  zones: { name: string[]; lon: number[]; lat: number[]; src: number[]; epci: number[]; v: string[] };
  episodes: ApiEpisode[];
}

interface IndexData extends ApiAir {
  geo: { type: 'FeatureCollection'; features: Array<{ type: 'Feature'; id: number; geometry: { type: 'Point'; coordinates: [number, number] }; properties: Record<string, number> }> };
}

/**
 * Les deux sources du module, qui peuvent manquer l'une sans l'autre (l'indice demande un compte Atmo Data sur le serveur) :
 * une source absente est vide, avec la raison dans `indexError` ou `mesuresError`.
 */
export interface AirData extends IndexData {
  mesures?: Mesures;
  indexError?: string;
  mesuresError?: string;
}

// --- Niveaux ---------------------------------------------------------------------------------

/** Palette officielle de l'indice ATMO 2021 ; le 7 (événement) n'a pas de couleur officielle : gris. */
const LEVELS: Record<number, { name: string; color: string; text: string }> = {
  1: { name: 'Bon', color: '#50F0E6', text: 'La qualité de l’air est bonne.' },
  2: { name: 'Moyen', color: '#50CCAA', text: 'La qualité de l’air est moyenne : pas de gêne attendue pour la plupart des personnes.' },
  3: { name: 'Dégradé', color: '#F0E641', text: 'La qualité de l’air est dégradée : les personnes sensibles (asthmatiques, jeunes enfants, personnes âgées) peuvent ressentir une gêne.' },
  4: { name: 'Mauvais', color: '#FF5050', text: 'La qualité de l’air est mauvaise : les personnes sensibles doivent limiter les efforts, les autres peuvent ressentir une gêne.' },
  5: { name: 'Très mauvais', color: '#960032', text: 'La qualité de l’air est très mauvaise : évitez les efforts prolongés, surtout si vous êtes sensible.' },
  6: { name: 'Extrêmement mauvais', color: '#872181', text: 'La qualité de l’air est extrêmement mauvaise : limitez les activités à l’extérieur.' },
  7: { name: 'Événement', color: '#8c93a0', text: 'Un événement particulier (épisode de pollution, incendie…) affecte la qualité de l’air.' },
};

/** Ordre des sous-indices dans la réponse du serveur, après l'indice global. */
const POLLUTANTS = [
  { code: 'NO2', name: 'Dioxyde d’azote (NO2)', short: 'dioxyde d’azote' },
  { code: 'O3', name: 'Ozone (O3)', short: 'ozone' },
  { code: 'PM10', name: 'Particules PM10', short: 'particules PM10' },
  { code: 'PM2.5', name: 'Particules fines PM2.5', short: 'particules fines PM2.5' },
  { code: 'SO2', name: 'Dioxyde de soufre (SO2)', short: 'dioxyde de soufre' },
] as const;

const EPISODE_LEVELS: Record<number, string> = { 1: 'Information et recommandation', 2: 'Alerte', 3: 'Alerte sur persistance' };

/** Région de chaque association, et départements de chaque région (pour rattacher les épisodes). */
const REGIONS: Array<{ name: string; sources: string[]; departments: string[] }> = [
  { name: 'Auvergne-Rhône-Alpes', sources: ['Atmo Auvergne-Rhône-Alpes'], departments: ['01', '03', '07', '15', '26', '38', '42', '43', '63', '69', '73', '74'] },
  { name: 'Bourgogne-Franche-Comté', sources: ['ATMO Bourgogne-Franche-Comté'], departments: ['21', '25', '39', '58', '70', '71', '89', '90'] },
  { name: 'Bretagne', sources: ['Air Breizh'], departments: ['22', '29', '35', '56'] },
  { name: 'Centre-Val de Loire', sources: ['Lig’Air', "Lig'Air"], departments: ['18', '28', '36', '37', '41', '45'] },
  { name: 'Corse', sources: ['Qualitair Corse'], departments: ['2A', '2B'] },
  { name: 'Grand Est', sources: ['Atmo Grand Est'], departments: ['08', '10', '51', '52', '54', '55', '57', '67', '68', '88'] },
  { name: 'Hauts-de-France', sources: ['Atmo HDF'], departments: ['02', '59', '60', '62', '80'] },
  { name: 'Île-de-France', sources: ['Airparif'], departments: ['75', '77', '78', '91', '92', '93', '94', '95'] },
  { name: 'Normandie', sources: ['Atmo Normandie'], departments: ['14', '27', '50', '61', '76'] },
  { name: 'Nouvelle-Aquitaine', sources: ['Atmo Nouvelle-Aquitaine'], departments: ['16', '17', '19', '23', '24', '33', '40', '47', '64', '79', '86', '87'] },
  { name: 'Occitanie', sources: ['Atmo-Occitanie'], departments: ['09', '11', '12', '30', '31', '32', '34', '46', '48', '65', '66', '81', '82'] },
  { name: 'Pays de la Loire', sources: ['Air Pays de la Loire'], departments: ['44', '49', '53', '72', '85'] },
  { name: 'Provence-Alpes-Côte d’Azur', sources: ['AtmoSud'], departments: ['04', '05', '06', '13', '83', '84'] },
];

const regionOfSource = (source: string) => REGIONS.find((r) => r.sources.includes(source))?.name;

// --- Aides -----------------------------------------------------------------------------------

const dayKeyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayNameFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });

/** Jour de l'instant à Paris, « AAAA-MM-JJ ». */
const dayKey = (time: number): string => dayKeyFormat.format(time);
/** « mardi 10 novembre » d'après « 2026-11-10 ». */
const dayName = (key: string): string => dayNameFormat.format(new Date(`${key}T12:00:00Z`));

/** Position du jour de l'horloge parmi les jours publiés, -1 s'il n'est pas publié. */
function dayIndexAt(data: AirData, time: number): number {
  return data.days.indexOf(dayKey(time));
}

/** Indice (1 à 7) de la zone ce jour-là ; 0 si le jour n'est pas publié pour elle. */
function levelOf(data: AirData, zone: number, day: number, offset = 0): number {
  const code = data.zones.v[zone]?.charCodeAt(day * 6 + offset) ?? 45;
  return code >= 49 && code <= 55 ? code - 48 : 0;
}

/** Retire accents, ponctuation et casse : « Côtes-d'Armor » et « COTES-D'ARMOR » deviennent identiques. */
const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

const SMALL_WORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'en', 'et', 'sur', 'sous', 'd', 'l']);
/** « BASSIN GRENOBLOIS » → « Bassin Grenoblois » (les petits mots restent en minuscules). */
function titleCase(text: string): string {
  if (text !== text.toUpperCase()) return text;
  return text
    .toLowerCase()
    .replace(/[\p{L}\p{N}]+/gu, (word, offset: number) => (offset > 0 && SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)));
}

interface DepartmentFeature {
  properties: { code: string; nom: string };
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] };
}
const DEPARTMENTS = (departements as unknown as { features: DepartmentFeature[] }).features;

function inRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi! > lat !== yj! > lat && lon < ((xj! - xi!) * (lat - yi!)) / (yj! - yi!) + xi!) inside = !inside;
  }
  return inside;
}

/** Département qui contient le point (les départements de métropole ne se recouvrent pas). */
function departmentAt(lon: number, lat: number): DepartmentFeature | undefined {
  return DEPARTMENTS.find(({ geometry }) => {
    const polygons = (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates) as number[][][][];
    return polygons.some(([outer, ...holes]) => outer !== undefined && inRing(lon, lat, outer) && !holes.some((hole) => inRing(lon, lat, hole)));
  });
}

/** Clé : la table des zones, qui ne change que quand l'indice est rechargé (pas à chaque relevé des mesures). */
const departmentCache = new WeakMap<AirData['zones'], Map<number, DepartmentFeature | null>>();
function departmentOf(data: AirData, zone: number): DepartmentFeature | undefined {
  let cache = departmentCache.get(data.zones);
  if (!cache) departmentCache.set(data.zones, (cache = new Map()));
  let found = cache.get(zone);
  if (found === undefined) {
    found = departmentAt(data.zones.lon[zone]!, data.zones.lat[zone]!) ?? null;
    cache.set(zone, found);
  }
  return found ?? undefined;
}

/** L'épisode concerne-t-il ce département ? Par son nom (« CALVADOS »), ou par sa région (« ILE-DE-FRANCE »). */
function episodeCovers(episode: ApiEpisode, department: DepartmentFeature): boolean {
  const zone = normalize(episode.zone);
  if (zone === normalize(department.properties.nom)) return true;
  return REGIONS.some((r) => normalize(r.name) === zone && r.departments.includes(department.properties.code));
}

/** Nom lisible de la zone d'un épisode : celui du département ou de la région quand on les reconnaît. */
function episodeZoneName(episode: ApiEpisode): string {
  const zone = normalize(episode.zone);
  const region = REGIONS.find((r) => normalize(r.name) === zone);
  if (region) return region.name;
  const department = DEPARTMENTS.find((d) => normalize(d.properties.nom) === zone);
  return department ? department.properties.nom : titleCase(episode.zone);
}

/** « d’ozone », « de particules fines » : l'élision selon la première lettre. */
const ofText = (text: string): string => (/^[aeiouyéèh]/i.test(text) ? `d’${text}` : `de ${text}`);
const pollutantShort = (code: string): string => POLLUTANTS.find((p) => p.code === code)?.short ?? code;

/** Épisodes du jour, regroupés par polluant : « d’ozone en Île-de-France ». */
function episodePhrases(data: AirData, day: string): string[] {
  const byPollutant = new Map<string, string[]>();
  for (const episode of data.episodes.filter((e) => e.day === day)) {
    const zones = byPollutant.get(episode.pol) ?? [];
    const name = episodeZoneName(episode);
    if (!zones.includes(name)) zones.push(name);
    byPollutant.set(episode.pol, zones);
  }
  return [...byPollutant].map(([pol, zones]) => {
    const where = zones.length > 2 ? `${zones.slice(0, 2).join(', ')} et ${zones.length - 2} autre${zones.length > 3 ? 's' : ''} zone${zones.length > 3 ? 's' : ''}` : zones.join(' et ');
    return `épisode ${ofText(pollutantShort(pol))} en ${where}`;
  });
}

// --- Rendu -----------------------------------------------------------------------------------

const SOURCE_ID = 'air';
const FIELD_ID = 'air-champ';
const SELECTED_ID = 'air-choisi';
const INK = STATUS.ink;

/** Rayon des cercles (pixels) d'une commune selon le zoom : se recouvrent de loin, se resserrent de près. */
const RADIUS: Array<[number, number]> = [[4, 1.4], [5, 2.2], [6, 3.4], [7, 5.5], [8, 8], [9, 11], [10, 14], [12, 17], [15, 20]];
/** Une intercommunalité n'a qu'un point pour tout son territoire : un cercle plus large. */
const EPCI_FACTOR = 2.6;

const radiusExpression = (extra = 0): unknown[] => [
  'interpolate',
  ['linear'],
  ['zoom'],
  ...RADIUS.flatMap(([zoom, radius]) => [zoom, ['+', ['*', ['case', ['==', ['get', 'e'], 1], EPCI_FACTOR, 1], radius], extra]]),
];

const colorExpression = (day: number): unknown[] => [
  'match',
  ['get', `q${day}`],
  ...Object.entries(LEVELS).flatMap(([level, { color }]) => [Number(level), color]),
  'rgba(0,0,0,0)',
];

/** Opacité du champ : le fond sombre de la nuit porte une couleur plus pleine, le fond clair demande qu'elle ne le noie pas. */
const opacityAt = (night: number): number => 0.8 + 0.1 * night;
/** Contour des pastilles quand on s'approche : sombre le jour, clair la nuit (même rôle que le liseré des symboles). */
const strokeAt = (night: number): string => {
  const mix = (day: number, dark: number) => Math.round(day + (dark - day) * night);
  return `rgba(${mix(20, 255)},${mix(26, 255)},${mix(38, 255)},${(0.5 - 0.1 * night).toFixed(2)})`;
};

// --- Rendu des stations ----------------------------------------------------------------------

const STATIONS_SOURCE = 'air-stations';
const STATIONS_ID = 'air-stations-point';
const STATIONS_CONTOUR_ID = 'air-stations-contour';
const STATIONS_LABEL_ID = 'air-stations-valeur';
const STATION_SELECTED_ID = 'air-stations-choisi';
/** Couleur des mesures anciennes (plus de 3 h) dans la légende : grise, et le point est estompé sur la carte. */
const STALE_COLOR = '#8c93a0';

/** Rayon des points de station selon le zoom : plus nets et plus petits qu'une commune du champ, pour se lire par-dessus. */
const STATION_RADIUS: Array<[number, number]> = [[4, 2.6], [6, 3.6], [8, 5], [10, 6.5], [12, 8], [15, 10]];
const stationRadius = (extra = 0): unknown[] => ['interpolate', ['linear'], ['zoom'], ...STATION_RADIUS.flatMap(([zoom, radius]) => [zoom, radius + extra])];

const stationColor = (): unknown[] => ['match', ['get', 'l'], ...[1, 2, 3, 4, 5, 6].flatMap((level) => [level, LEVELS[level]!.color]), STALE_COLOR];

type Display = 'both' | 'index' | 'stations';
const displayOf = (settings: Readonly<Record<string, string>>): Display => (settings.affichage === 'index' || settings.affichage === 'stations' ? settings.affichage : 'both');
/** Polluant choisi : son indice dans `MEASURED`, ou `undefined` pour « le pire ». */
const pollutantOf = (settings: Readonly<Record<string, string>>): number | undefined => {
  const p = MEASURED.findIndex((m) => m.code === settings.polluant);
  return p >= 0 ? p : undefined;
};

interface StationsShown {
  mesures: Mesures;
  signature: string;
}

let shown: { data: AirData; geo: IndexData['geo']; day: number; night: number } | undefined;
let stationsShown: StationsShown | undefined;

function applyDay(map: MapLibreMap, day: number, night: number): void {
  if (!map.getLayer(FIELD_ID)) return;
  map.setPaintProperty(FIELD_ID, 'circle-color', colorExpression(day) as never);
  map.setPaintProperty(FIELD_ID, 'circle-opacity', opacityAt(night));
  map.setPaintProperty(FIELD_ID, 'circle-stroke-color', strokeAt(night));
  // Les plus mauvais indices par-dessus ; une zone sans indice ce jour-là (aucun niveau) est tout dessous.
  map.setLayoutProperty(FIELD_ID, 'circle-sort-key', ['coalesce', ['get', `q${day}`], 0] as never);
}

/** Un point par station qui a une mesure à l'instant `time` : niveau, ancienneté et chiffre affiché. */
function stationFeatures(mesures: Mesures, time: number, only: number | undefined) {
  const features: Array<{ type: 'Feature'; geometry: { type: 'Point'; coordinates: [number, number] }; properties: { c: string; l: number; s: number; t: string; k: number } }> = [];
  for (let i = 0; i < mesures.stations.code.length; i++) {
    const state = stationState(mesures, i, time, only);
    if (!state) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [mesures.stations.lon[i]!, mesures.stations.lat[i]!] },
      // `k` : le plus mauvais d'abord, pour dessiner les stations les plus polluées par-dessus.
      properties: { c: mesures.stations.code[i]!, l: state.stale ? 0 : state.main.level, s: state.stale ? 1 : 0, t: valueText(state.main.value), k: state.stale ? 0 : state.main.level },
    });
  }
  return features;
}

function updateStations(map: MapLibreMap, data: AirData | undefined, time: number, settings: Readonly<Record<string, string>>, night: number): void {
  const visible = displayOf(settings) !== 'index' && data?.mesures !== undefined;
  for (const id of [STATIONS_CONTOUR_ID, STATIONS_ID, STATIONS_LABEL_ID]) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  if (!visible || !data?.mesures) return;
  const only = pollutantOf(settings);
  const features = stationFeatures(data.mesures, time, only);
  // Seulement si quelque chose a changé : une heure de plus, un autre polluant, une mesure devenue ancienne.
  const signature = `${only ?? '-'}|${features.map((f) => `${f.properties.c}${f.properties.l}${f.properties.s}${f.properties.t}`).join(',')}`;
  if (!stationsShown || stationsShown.mesures !== data.mesures || stationsShown.signature !== signature) {
    (map.getSource(STATIONS_SOURCE) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features } as never);
    stationsShown = { mesures: data.mesures, signature };
  }
  // Le contour suit le fond : sombre le jour, clair la nuit (comme le liseré des communes du champ).
  if (map.getLayer(STATIONS_ID)) map.setPaintProperty(STATIONS_ID, 'circle-stroke-color', night > 0.5 ? '#f2f4f8' : '#ffffff');
}

// --- Chargement ------------------------------------------------------------------------------

/** L'indice ne change qu'une fois par jour : inutile de le recharger (1 Mo) à chaque relevé des mesures. */
const INDEX_TTL_MS = 25 * 60_000;
let indexCache: { at: number; index: IndexData } | undefined;

const EMPTY_INDEX: IndexData = {
  updatedAt: 0,
  days: [],
  sources: [],
  zones: { name: [], lon: [], lat: [], src: [], epci: [], v: [] },
  episodes: [],
  geo: { type: 'FeatureCollection', features: [] },
};

async function fetchJson<T>(url: string, what: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (response.status === 503) throw new Error(await response.text().then((t) => t || `le serveur récupère encore ${what}`));
  if (!response.ok) throw new Error(`le serveur de ${what} a répondu ${response.status}`);
  return (await response.json()) as T;
}

async function loadIndex(signal: AbortSignal): Promise<IndexData> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.index;
  const json = await fetchJson<ApiAir>('/api/air', 'la qualité de l’air', signal);
  const { zones, days } = json;
  const features: IndexData['geo']['features'] = [];
  for (let i = 0; i < zones.name.length; i++) {
    const properties: Record<string, number> = { i, e: zones.epci[i]! };
    for (let day = 0; day < days.length; day++) {
      const code = zones.v[i]!.charCodeAt(day * 6);
      if (code >= 49 && code <= 55) properties[`q${day}`] = code - 48;
    }
    features.push({ type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [zones.lon[i]!, zones.lat[i]!] }, properties });
  }
  const index: IndexData = { ...json, geo: { type: 'FeatureCollection', features } };
  indexCache = { at: Date.now(), index };
  return index;
}

async function loadAir(signal: AbortSignal): Promise<AirData> {
  // Les deux sources en parallèle ; l'une peut manquer (pas de compte Atmo Data sur le serveur, premier relevé en cours).
  const [index, mesures] = await Promise.allSettled([loadIndex(signal), fetchJson<ApiMesures>('/api/air/mesures', 'des mesures de l’air', signal)]);
  if (signal.aborted) throw new DOMException('annulé', 'AbortError');
  if (index.status === 'rejected' && mesures.status === 'rejected') throw index.reason instanceof Error ? index.reason : new Error('qualité de l’air indisponible');
  const reason = (r: PromiseRejectedResult) => (r.reason instanceof Error ? r.reason.message : 'indisponible');
  return {
    ...(index.status === 'fulfilled' ? index.value : EMPTY_INDEX),
    mesures: mesures.status === 'fulfilled' ? prepareMesures(mesures.value) : undefined,
    indexError: index.status === 'rejected' ? reason(index) : undefined,
    mesuresError: mesures.status === 'rejected' ? reason(mesures) : undefined,
  };
}

// --- Texte des mesures -----------------------------------------------------------------------

const IMPLANTATION = ['urbaine', 'périurbaine', 'rurale'];
const INFLUENCE = ['de fond', 'de trafic', 'industrielle'];

/** Fin d'une heure mesurée : « 16:00 » ; la mesure couvre l'heure qui précède. */
const hourEnd = (reading: Reading): string => formatTime(reading.end);

function stationSubtitle(m: Mesures, station: number): string {
  const org = titleCase(m.orgs[m.stations.org[station]!] ?? '');
  const commune = m.stations.commune[station]!;
  return `Station ${IMPLANTATION[m.stations.imp[station]!] ?? 'urbaine'} ${INFLUENCE[m.stations.infl[station]!] ?? 'de fond'} · ${commune}${org ? ` · ${org}` : ''}`;
}

/** Résumé des mesures : combien de stations, combien dégradées, la plus touchée. */
function mesuresSummary(data: AirData, time: number, only: number | undefined): string {
  const m = data.mesures;
  if (!m) return `mesures indisponibles (${data.mesuresError ?? 'pas de données'})`;
  if (slotAt(m, time) < 0) return `pas de mesures avant ${formatTime(slotEndMs(m, 0))} (24 h d’historique seulement)`;
  let total = 0;
  let stale = 0;
  let degraded = 0;
  let top: { state: StationState; station: number } | undefined;
  for (let i = 0; i < m.stations.code.length; i++) {
    const state = stationState(m, i, time, only);
    if (!state) continue;
    total++;
    if (state.stale) {
      stale++;
      continue;
    }
    if (state.main.level >= 3) degraded++;
    if (!top || state.main.level > top.state.main.level || (state.main.level === top.state.main.level && state.main.value / MEASURED[state.main.pollutant]!.bounds[0] > top.state.main.value / MEASURED[top.state.main.pollutant]!.bounds[0])) {
      top = { state, station: i };
    }
  }
  const what = only === undefined ? '' : ` de ${MEASURED[only]!.label}`;
  if (total === 0) return `aucune mesure${what}`;
  const parts = [`${total} station${total > 1 ? 's' : ''}${what}`];
  parts.push(degraded === 0 ? 'aucune en niveau dégradé ou pire' : `${degraded} en niveau dégradé ou pire`);
  if (top && degraded > 0) parts.push(`le plus haut : ${MEASURED[top.state.main.pollutant]!.label} ${valueText(top.state.main.value)} µg/m³ à ${titleCase(m.stations.name[top.station]!)}`);
  if (stale > 0) parts.push(`${stale} mesure${stale > 1 ? 's' : ''} ancienne${stale > 1 ? 's' : ''}`);
  return parts.join(', ');
}

/** Résumé de l'indice : la part de chaque niveau le jour de l'horloge, et les épisodes de pollution. */
function indexSummary(data: AirData, time: number): string {
  if (data.indexError) return `Air : indice indisponible (${data.indexError})`;
  const day = dayIndexAt(data, time);
  if (day < 0) {
    const first = data.days[0];
    return first && dayKey(time) < first
      ? 'Pas d’historique : l’indice n’est publié que pour aujourd’hui et les jours à venir'
      : 'Indice pas encore publié pour ce jour (il couvre aujourd’hui, demain et parfois après-demain)';
  }
  const counts = [0, 0, 0, 0, 0, 0, 0, 0];
  const worst = new Map<string, number>();
  let total = 0;
  for (let zone = 0; zone < data.zones.name.length; zone++) {
    const level = levelOf(data, zone, day);
    if (level === 0) continue;
    total++;
    counts[level]!++;
    if (level >= 3) worst.set(data.sources[data.zones.src[zone]!]!, (worst.get(data.sources[data.zones.src[zone]!]!) ?? 0) + 1);
  }
  if (total === 0) return `${dayName(data.days[day]!)} : pas d’indice publié`;
  const share = (levels: number[]) => levels.reduce((sum, level) => sum + counts[level]!, 0) / total;
  const parts: string[] = [];
  if (share([1]) >= 0.9) parts.push('bon presque partout');
  else if (share([2]) >= 0.9) parts.push('moyen presque partout');
  else if (share([1, 2]) >= 0.9) parts.push('bon à moyen presque partout');
  else parts.push(`${Math.round(share([1]) * 100)} % bon, ${Math.round(share([2]) * 100)} % moyen`);
  const degraded = counts[3]! + counts[4]! + counts[5]! + counts[6]! + counts[7]!;
  if (degraded > 0) {
    const [top] = [...worst].sort((a, b) => b[1] - a[1]);
    const where = top ? regionOfSource(top[0]) : undefined;
    const worse = counts[4]! + counts[5]! + counts[6]!;
    const label = worse > 0 ? 'mauvais ou pire' : 'dégradé';
    parts.push(`${label} dans ${degraded.toLocaleString('fr-FR')} zone${degraded > 1 ? 's' : ''}${where ? `, surtout en ${where}` : ''}`);
  }
  parts.push(...episodePhrases(data, data.days[day]!));
  return `Air : ${parts.join(', ')}`;
}

// --- Module ----------------------------------------------------------------------------------

export const air = defineModule<AirData>({
  id: 'air',
  name: 'Qualité de l’air',
  category: 'environnement',
  description: 'Indice ATMO de chaque commune (aujourd’hui et jours prévus), épisodes de pollution, et concentrations mesurées heure par heure aux stations officielles.',
  attribution: 'Atmo France / AASQA (indice) · LCSQA / Geod’air, AASQA (mesures)',
  // Les mesures changent à chaque heure (le serveur les relève toutes les 20 min) ; l'indice n'est rechargé que s'il a plus de 25 min.
  refreshIntervalMs: 10 * 60_000,
  // Change avec le jour de l'horloge (et la nuit) et à chaque heure de mesure : une fois par minute suffit.
  timeStepMs: 60_000,

  settings: [
    {
      id: 'affichage',
      label: 'Afficher',
      defaultValue: 'both',
      options: [
        { value: 'both', label: 'Indice et stations' },
        { value: 'index', label: 'Indice ATMO' },
        { value: 'stations', label: 'Mesures des stations' },
      ],
    },
    {
      id: 'polluant',
      label: 'Polluant des stations',
      defaultValue: 'worst',
      options: [{ value: 'worst', label: 'Le pire' }, ...MEASURED.filter((p) => p.code !== 'SO2').map((p) => ({ value: p.code, label: p.label }))],
      visibleWhen: (settings) => displayOf(settings) !== 'index',
    },
  ],

  load: ({ signal }) => loadAir(signal),

  legend(settings, data): LegendItem[] {
    const items: LegendItem[] = [1, 2, 3, 4, 5, 6].map((level) => ({ color: LEVELS[level]!.color, label: `${LEVELS[level]!.name}`, size: 'medium' as const }));
    if (displayOf(settings) !== 'index' && data?.mesures) items.push({ color: STALE_COLOR, label: 'Mesure de plus de 3 h (estompée)', size: 'small' as const });
    return items;
  },

  summary({ data, time, settings }) {
    if (!data) return null;
    const display = displayOf(settings);
    if (display === 'index') return indexSummary(data, time);
    const stations = mesuresSummary(data, time, pollutantOf(settings));
    // Sans indice (pas de compte Atmo Data sur le serveur), les mesures parlent seules.
    return display === 'stations' || data.indexError ? `Air : ${stations}` : `${indexSummary(data, time)} · mesures : ${stations}`;
  },

  native: {
    add(map) {
      shown = undefined;
      stationsShown = undefined;
      map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer(
        {
          id: FIELD_ID,
          type: 'circle',
          source: SOURCE_ID,
          layout: { 'circle-sort-key': 0 },
          paint: {
            'circle-radius': radiusExpression() as never,
            'circle-color': colorExpression(0) as never,
            'circle-opacity': opacityAt(0),
            // Flou de loin (un champ continu), net de près (des pastilles, cernées d'un fin contour).
            'circle-blur': ['interpolate', ['linear'], ['zoom'], 4, 1, 8, 0.85, 11, 0.45, 13, 0.2] as never,
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9.5, 0, 12, 0.8] as never,
            'circle-stroke-color': strokeAt(0),
            'circle-pitch-alignment': 'map',
            'circle-pitch-scale': 'map',
          },
        },
        firstSymbolLayerId(map),
      );
      // La zone choisie : liseré blanc cerné de sombre, sans teinte (la couleur dit la qualité de l'air).
      const ring = (id: string, color: string, width: number, extra: number) => ({
        id,
        type: 'circle' as const,
        source: SOURCE_ID,
        filter: ['==', ['get', 'i'], -1] as never,
        paint: {
          'circle-radius': radiusExpression(extra) as never,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': color,
          'circle-stroke-width': width,
          'circle-pitch-alignment': 'map' as const,
        },
      });
      map.addLayer(ring(`${SELECTED_ID}-contour`, INK, 5, 1), firstSymbolLayerId(map));
      map.addLayer(ring(SELECTED_ID, '#ffffff', 2.4, 1), firstSymbolLayerId(map));

      // Les stations, par-dessus le champ : un point plein, net, cerné de blanc (le champ est flou et sans contour), et son chiffre.
      map.addSource(STATIONS_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      const point = {
        type: 'circle' as const,
        source: STATIONS_SOURCE,
        layout: { 'circle-sort-key': ['get', 'k'] } as never,
      };
      map.addLayer({ ...point, id: STATIONS_CONTOUR_ID, paint: { 'circle-radius': stationRadius(2.2) as never, 'circle-color': INK, 'circle-opacity': 0.55, 'circle-pitch-alignment': 'viewport' } }, firstSymbolLayerId(map));
      map.addLayer(
        {
          ...point,
          id: STATIONS_ID,
          paint: {
            'circle-radius': stationRadius() as never,
            'circle-color': stationColor() as never,
            // Une mesure ancienne (plus de 3 h) : estompée.
            'circle-opacity': ['case', ['==', ['get', 's'], 1], 0.4, 1] as never,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.5,
            'circle-stroke-opacity': ['case', ['==', ['get', 's'], 1], 0.5, 1] as never,
            'circle-pitch-alignment': 'viewport',
          },
        },
        firstSymbolLayerId(map),
      );
      map.addLayer(
        {
          id: STATIONS_LABEL_ID,
          type: 'symbol',
          source: STATIONS_SOURCE,
          minzoom: 8.5,
          layout: {
            'text-field': ['get', 't'] as never,
            'text-font': ['Noto Sans Bold'],
            'text-size': 11,
            'text-anchor': 'top',
            'text-offset': [0, 0.9],
            'text-allow-overlap': false,
            'symbol-sort-key': ['-', 0, ['get', 'k']] as never,
          },
          paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(22,26,38,0.9)', 'text-halo-width': 1.6, 'text-opacity': ['case', ['==', ['get', 's'], 1], 0.55, 1] as never },
        } as never,
      );
      const stationRing = (id: string, color: string, width: number, extra: number) => ({
        id,
        type: 'circle' as const,
        source: STATIONS_SOURCE,
        filter: ['==', ['get', 'c'], ''] as never,
        paint: { 'circle-radius': stationRadius(extra) as never, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': color, 'circle-stroke-width': width, 'circle-pitch-alignment': 'viewport' as const },
      });
      map.addLayer(stationRing(`${STATION_SELECTED_ID}-contour`, INK, 5, 4));
      map.addLayer(stationRing(STATION_SELECTED_ID, '#ffffff', 2.4, 4));
    },
    update(map, { data, time, selection, night, settings }) {
      const display = displayOf(settings);
      if (data) {
        const day = dayIndexAt(data, time);
        const quantizedNight = Math.round(night * 8) / 8;
        if (!shown || shown.geo !== data.geo) (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(data.geo as never);
        if (!shown || shown.geo !== data.geo || shown.day !== day || shown.night !== quantizedNight) {
          applyDay(map, day, quantizedNight);
          shown = { data, geo: data.geo, day, night: quantizedNight };
        }
      }
      const field = display !== 'stations' ? 'visible' : 'none';
      for (const id of [FIELD_ID, SELECTED_ID, `${SELECTED_ID}-contour`]) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', field);
      updateStations(map, data, time, settings, night);
      const sel = selection as { i?: number; st?: string } | null;
      const index = sel?.i ?? -1;
      for (const id of [SELECTED_ID, `${SELECTED_ID}-contour`]) if (map.getLayer(id)) map.setFilter(id, ['==', ['get', 'i'], index] as never);
      for (const id of [STATION_SELECTED_ID, `${STATION_SELECTED_ID}-contour`]) if (map.getLayer(id)) map.setFilter(id, ['==', ['get', 'c'], sel?.st ?? ''] as never);
    },
    remove(map) {
      for (const id of [STATION_SELECTED_ID, `${STATION_SELECTED_ID}-contour`, STATIONS_LABEL_ID, STATIONS_ID, STATIONS_CONTOUR_ID, SELECTED_ID, `${SELECTED_ID}-contour`, FIELD_ID]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      for (const id of [STATIONS_SOURCE, SOURCE_ID]) if (map.getSource(id)) map.removeSource(id);
      shown = undefined;
      stationsShown = undefined;
    },
    pickable: {
      layerIds: [STATIONS_ID, FIELD_ID],
      toObject: (feature) => (feature.source === STATIONS_SOURCE ? { st: String(feature.properties?.c) } : { i: Number(feature.properties?.i) }),
    },
  },

  select(object) {
    const o = object as { i?: number; st?: string; p?: string };
    if (typeof o.st === 'string' && o.st !== '') return { st: o.st, ...(o.p ? { p: o.p } : {}) };
    return Number.isInteger(o.i) && o.i! >= 0 ? { i: o.i } : null;
  },

  focus(selection, { data }) {
    const sel = selection as { i?: number; st?: string } | null;
    if (sel?.st !== undefined) {
      const station = data?.mesures?.byCode.get(sel.st);
      return data?.mesures && station !== undefined ? { lon: data.mesures.stations.lon[station]!, lat: data.mesures.stations.lat[station]!, fixed: true } : null;
    }
    const i = sel?.i;
    return data && i !== undefined && data.zones.name[i] !== undefined ? { lon: data.zones.lon[i]!, lat: data.zones.lat[i]!, fixed: true } : null;
  },

  describe(selection, { data, time, settings }): InfoContent | null {
    const sel = selection as { i?: number; st?: string; p?: string };
    if (sel.st !== undefined) return data?.mesures ? describeStation(data.mesures, sel.st, sel.p, time, pollutantOf(settings)) : null;
    return describeZone(selection as { i: number }, data, time);
  },
});

// --- Fiches ----------------------------------------------------------------------------------

function describeStation(m: Mesures, code: string, chosen: string | undefined, time: number, only: number | undefined): InfoContent | null {
  const station = m.byCode.get(code);
  if (station === undefined) return null;
  const name = titleCase(m.stations.name[station]!);
  const subtitle = stationSubtitle(m, station);
  const state = stationState(m, station, time);
  if (!state) {
    return {
      kind: 'Qualité de l’air · station de mesure',
      title: name,
      subtitle,
      note: slotAt(m, time) < 0 ? 'Les mesures ne sont gardées que sur 24 heures : il n’y a rien à cette date.' : 'Pas de mesure valide de cette station dans les 24 dernières heures.',
    };
  }
  const main = state.main;
  // La courbe : le polluant cliqué dans le tableau, sinon celui du réglage (s'il est mesuré ici), sinon le plus mauvais.
  const wanted = MEASURED.findIndex((p) => p.code === chosen);
  const charted = [wanted, only ?? -1].find((p) => p >= 0 && readingAt(m, station, p, time) !== undefined) ?? main.pollutant;
  const reading = (p: number) => readingAt(m, station, p, time);
  const lastSlot = slotAt(m, time);
  const points: Array<[number, number | null]> = [];
  const values = m.series[station]?.[charted];
  for (let k = 0; k <= lastSlot; k++) points.push([slotEndMs(m, k), values?.[k] ?? null]);
  const known = points.map((p) => p[1]).filter((v): v is number => v !== null);
  const pollutant = MEASURED[charted]!;
  const age = time - main.end;

  const rows = MEASURED.map((p, k) => ({ p, k, r: reading(k) }))
    .filter((row) => row.r !== undefined)
    .sort((a, b) => b.r!.level - a.r!.level)
    .map(({ p, k, r }) => ({
      cells: [`${p.name} (${p.label})`, `${valueText(r!.value)} µg/m³${time - r!.end > STALE_MS ? ` · ${hourEnd(r!)}` : ''}`, `${LEVELS[r!.level]!.name} (${r!.level})`],
      tone: k === charted ? ('current' as const) : undefined,
      select: { st: code, p: p.code },
    }));

  return {
    kind: `Qualité de l’air · ${state.stale ? 'mesure ancienne' : LEVELS[main.level]!.name.toLowerCase()}`,
    title: name,
    subtitle,
    status: state.stale ? plainStatus(`Mesure ancienne : heure close à ${hourEnd(main)}, il y a plus de ${Math.floor(age / 3600_000)} h`) : measuredStatus(time, main.end),
    figures: [
      { value: LEVELS[main.level]!.name, label: `niveau (${MEASURED[main.pollutant]!.label})` },
      { value: valueText(main.value), unit: 'µg/m³', label: `${MEASURED[main.pollutant]!.label} · heure close à ${hourEnd(main)}` },
    ],
    chart:
      known.length > 1
        ? {
            title: `${pollutant.name} (${pollutant.label}), µg/m³ sur 24 h`,
            unit: 'µg/m³',
            points,
            integer: true,
            hourStep: 4,
            summary: `${pollutant.name} à ${name} sur 24 heures : de ${valueText(Math.min(...known))} à ${valueText(Math.max(...known))} µg/m³, ${valueText(known.at(-1)!)} à la dernière mesure.`,
          }
        : undefined,
    tables: [
      {
        title: `Dernières mesures · heure de Paris${rows.length > 1 ? ' · touchez une ligne pour sa courbe' : ''}`,
        columns: ['Polluant', 'Mesure', 'Niveau'],
        rows,
      },
    ],
    note:
      `${LEVELS[main.level]!.text} ` +
      'Chaque valeur est la moyenne horaire mesurée par l’analyseur de la station (donnée brute des associations de surveillance, vérifiée ou non). ' +
      'Le niveau applique à cette valeur horaire les seuils de l’indice ATMO 2021, qui portent en réalité sur le maximum horaire du jour (NO₂, O₃, SO₂) ou sa moyenne (PM10, PM2.5) : c’est une approximation, pas l’indice officiel de la commune. ' +
      `L’heure la plus récente a environ une heure et demie de retard. Les mesures de plus de ${STALE_MS / 3600_000} h sont estompées sur la carte.`,
    actions: [{ label: 'Données sur Geod’air', href: 'https://www.geodair.fr/donnees/consultation' }],
  };
}

function describeZone(selection: { i: number }, data: AirData | undefined, time: number): InfoContent | null {
  const zone = selection.i;
  if (!data || data.zones.name[zone] === undefined) return null;
  // Atmo HDF écrit ses communes en capitales : « GRAND-FORT-PHILIPPE » devient « Grand-Fort-Philippe ».
  const name = titleCase(data.zones.name[zone]!);
  const source = data.sources[data.zones.src[zone]!] ?? '';
  const region = regionOfSource(source);
  const subtitle = `${data.zones.epci[zone] ? 'Intercommunalité' : 'Commune'} · ${source}${region ? ` (${region})` : ''}`;
  const day = dayIndexAt(data, time);
  const level = day < 0 ? 0 : levelOf(data, zone, day);
  if (level === 0) {
    return {
      kind: 'Qualité de l’air',
      title: name,
      subtitle,
      note: 'Pas d’indice publié pour cette zone à cette date : l’indice ne couvre que le jour même et les jours à venir, il n’y a pas d’historique.',
    };
  }
  const dayText = dayName(data.days[day]!);
  const published = data.issuedAt ? ` · publié à ${formatTime(data.issuedAt * 1000)}` : '';
  const isToday = data.days[day] === dayKey(Date.now());
  const subs = POLLUTANTS.map((p, k) => ({ ...p, level: levelOf(data, zone, day, k + 1) }));
  const maxSub = Math.max(...subs.map((s) => s.level));
  const dominant = maxSub >= 2 ? subs.filter((s) => s.level === maxSub) : [];
  const dominantText = dominant.length === 0 ? 'Aucun' : dominant.length > 2 ? 'Plusieurs' : dominant.map((s) => s.short.replace(/^./, (c) => c.toUpperCase())).join(' et ');

  const department = departmentOf(data, zone);
  const episodes = department ? data.episodes.filter((e) => e.day === data.days[day] && episodeCovers(e, department)) : [];

  return {
    kind: `Qualité de l’air · ${LEVELS[level]!.name.toLowerCase()}`,
    title: name,
    subtitle,
    // L'indice est calculé par les associations (mesures et modèles) puis publié : ce n'est pas un relevé direct.
    status: isToday ? plainStatus(`Indice du jour${published}`) : scheduledStatus(`Prévision pour ${dayText}${published}`),
    figures: [
      { value: LEVELS[level]!.name, label: `indice ATMO (${level} sur 6)` },
      { value: dominantText, label: dominant.length > 1 ? 'polluants dominants' : 'polluant dominant' },
      ...(episodes.length > 0 ? [{ value: EPISODE_LEVELS[Math.max(...episodes.map((e) => e.level))]!.split(' ')[0]!, label: 'épisode de pollution' }] : []),
    ],
    tables: [
      {
        title: `Sous-indices par polluant · ${dayText}`,
        columns: ['Polluant', 'Niveau'],
        rows: subs.map((s) => ({
          cells: [s.name, s.level === 0 ? 'non évalué' : `${LEVELS[s.level]!.name} (${s.level})`],
          tone: dominant.includes(s) ? ('current' as const) : undefined,
        })),
      },
      ...(episodes.length > 0
        ? [
            {
              title: 'Épisodes de pollution',
              columns: ['Polluant', 'Zone', 'Niveau'],
              rows: episodes.map((e) => ({ cells: [pollutantShort(e.pol).replace(/^./, (c) => c.toUpperCase()), episodeZoneName(e), EPISODE_LEVELS[e.level] ?? ''], tone: e.level >= 2 ? ('alert' as const) : undefined })),
            },
          ]
        : []),
    ],
    note: `${LEVELS[level]!.text} L’indice global est le plus élevé des cinq sous-indices.`,
    actions: [{ label: 'Indice ATMO sur Atmo France', href: 'https://www.atmo-france.org/article/lindice-atmo' }],
  };
}
