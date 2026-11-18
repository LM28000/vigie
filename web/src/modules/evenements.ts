/**
 * Module « Événements » : les événements publics des 30 prochains jours (concerts, spectacles, expositions, fêtes, marchés,
 * sport, visites), rassemblés par le serveur (server/src/events.rs) depuis DATAtourisme (Licence Ouverte 2.0), « Que faire à
 * Paris » (ODbL) et OpenAgenda (Licence Ouverte 1.0), dédoublonnés.
 *
 * Deux informations, deux canaux : la **catégorie** est dite par le pictogramme ET par la teinte (huit teintes en ordre fixe,
 * palette Okabe-Ito sûre pour le daltonisme : la teinte ne porte jamais seule l'information) ; **ce qui a lieu maintenant** est dit
 * par l'opacité (plein : en cours à l'instant de la frise ; estompé : plus tard ou déjà passé dans la période choisie).
 *
 * Le filtre de temps est relié à la frise : « à l'instant » (ce qui a lieu à l'instant affiché), « ce jour-là » (le jour de la
 * frise), « ce week-end » (le prochain samedi et dimanche, ou celui en cours) et « 7 jours » (à partir du jour de la frise).
 * Les événements de longue durée (expositions permanentes, activités à l'année : plus de 45 jours d'affilée) sont cachés par défaut.
 *
 * À l'échelle de la France, des disques gradués par le nombre d'événements (un clic en liste les principaux) ; dès le zoom 9,
 * des points colorés ; dès le zoom 12, les pictogrammes ; dès le zoom 14,5, les titres.
 */
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { requestInfoRefresh } from '../core/infoRefresh';
import { plainStatus } from '../core/infoStatus';
import { defineModule, type InfoContent, type InfoTable, type LegendItem } from '../core/module';
import { declutter, halfZoomBreaks, zoomBand } from '../map/declutter';
import { OVER_MAP } from '../map/parameters';
import { formatTime, parisMidnight, parisParts } from '../ui/format';
import { HALO_CSS, KEY, KEY_CSS, packIcons, selectionRing, type IconSheet, zoomRamp } from './symbols';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Un événement tel que le serveur le décrit (tableau de 9 cases, voir `events.rs`). */
export interface EventItem {
  id: number;
  lon: number;
  lat: number;
  /** Catégorie, de 0 à 7 (voir `CATEGORIES`). */
  cat: number;
  /** Source : 0 Que faire à Paris, 1 DATAtourisme, 2 OpenAgenda. */
  src: number;
  /** Drapeaux : 1 longue durée, 2 gratuit, 4 payant. */
  flags: number;
  title: string;
  commune: string;
  /** Moments où il a lieu : début, fin, début, fin… en millisecondes depuis 1970. */
  spans: number[];
}

export interface EventSource {
  name: string;
  licence: string;
  url: string;
}

export interface EventsData {
  list: EventItem[];
  byId: Map<number, EventItem>;
  sources: EventSource[];
  updatedAt: number;
}

type Row = [number, number, number, number, number, number, string, string, number[]];

const isLong = (e: EventItem) => (e.flags & 1) !== 0;
const isFree = (e: EventItem) => (e.flags & 2) !== 0;

/** Catégories : nom, nom court (réglage), teinte (Okabe-Ito, ordre fixe), mots que les gens tapent. */
export const CATEGORIES = [
  { label: 'Musique (concerts, opéra, chorales)', short: 'Musique', color: '#0072b2', words: 'concert concerts musique jazz rock opera chorale' },
  { label: 'Spectacle (théâtre, danse, cirque, cinéma)', short: 'Spectacle', color: '#cc79a7', words: 'spectacle spectacles theatre danse cirque humour cinema' },
  { label: 'Exposition (musées, galeries, vernissages)', short: 'Exposition', color: '#e69f00', words: 'exposition expositions expo vernissage musee galerie' },
  { label: 'Fête et festival (carnavals, feux d’artifice, bals)', short: 'Fête et festival', color: '#d55e00', words: 'fete fetes festival festivals carnaval bal' },
  { label: 'Marché et brocante (foires, vide-greniers, Noël)', short: 'Marché et brocante', color: '#009e73', words: 'marche marches brocante vide grenier foire noel' },
  { label: 'Sport (matchs, courses, randonnées)', short: 'Sport', color: '#56b4e9', words: 'sport match course trail randonnee tournoi' },
  { label: 'Patrimoine et visite (visites guidées, balades)', short: 'Patrimoine et visite', color: '#f0e442', words: 'visite visites patrimoine balade promenade' },
  { label: 'Rencontre et autre (salons, conférences, ateliers)', short: 'Rencontre et autre', color: '#8a8f9c', words: 'salon conference atelier rencontre' },
] as const;

const PERIODS = [
  { value: 'jour', label: 'Ce jour-là (jour de la frise)' },
  { value: 'instant', label: 'À l’instant affiché' },
  { value: 'weekend', label: 'Ce week-end' },
  { value: '7j', label: '7 jours' },
] as const;

// --- Pictogrammes ---

const CELL = 64;
const BADGE = 25;
const iconKey = (cat: number) => `e:${cat}`;

/** Le pictogramme est clair sur une teinte sombre, sombre sur une teinte claire. */
function inkOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.5 ? KEY_CSS : '#ffffff';
}

/** Trace le pictogramme d'une catégorie, centré en (0, 0), dans un carré d'environ 26 × 26. */
function drawGlyph(c: CanvasRenderingContext2D, cat: number): void {
  c.beginPath();
  switch (cat) {
    case 0: // musique : une croche
      c.ellipse(-5, 9, 6, 4.5, -0.4, 0, Math.PI * 2);
      c.moveTo(0.6, 8);
      c.lineTo(0.6, -11);
      c.quadraticCurveTo(5, -8, 10, -3);
      break;
    case 1: // spectacle : une étoile à cinq branches
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 13 : 5.4;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        if (i === 0) c.moveTo(r * Math.cos(a), r * Math.sin(a));
        else c.lineTo(r * Math.cos(a), r * Math.sin(a));
      }
      c.closePath();
      break;
    case 2: // exposition : un cadre, une montagne et un soleil
      c.rect(-12, -10, 24, 20);
      c.moveTo(-12, 7);
      c.lineTo(-4, -1);
      c.lineTo(2, 5);
      c.lineTo(6, 1);
      c.lineTo(12, 7);
      c.moveTo(7.5, -4.5);
      c.arc(6, -4.5, 1.5, 0, Math.PI * 2);
      break;
    case 3: // fête : un éclat de huit rayons
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        c.moveTo(4 * Math.cos(a), 4 * Math.sin(a));
        c.lineTo(13 * Math.cos(a), 13 * Math.sin(a));
      }
      c.moveTo(2.2, 0);
      c.arc(0, 0, 2.2, 0, Math.PI * 2);
      break;
    case 4: // marché : un étal sous un auvent rayé
      c.moveTo(-13, -3);
      c.lineTo(-9, -11);
      c.lineTo(9, -11);
      c.lineTo(13, -3);
      c.closePath();
      c.moveTo(-13, -3);
      c.arc(-8.7, -3, 4.3, Math.PI, 0, true);
      c.arc(0, -3, 4.3, Math.PI, 0, true);
      c.arc(8.7, -3, 4.3, Math.PI, 0, true);
      c.moveTo(-10, 2);
      c.lineTo(-10, 12);
      c.moveTo(10, 2);
      c.lineTo(10, 12);
      c.moveTo(-10, 6);
      c.lineTo(10, 6);
      break;
    case 5: // sport : un ballon
      c.arc(0, 0, 12, 0, Math.PI * 2);
      c.moveTo(0, -12);
      c.lineTo(0, 12);
      c.moveTo(-12, 0);
      c.lineTo(12, 0);
      c.moveTo(-8.5, -8.5);
      c.quadraticCurveTo(-3, 0, -8.5, 8.5);
      c.moveTo(8.5, -8.5);
      c.quadraticCurveTo(3, 0, 8.5, 8.5);
      break;
    case 6: // patrimoine : une arche entre deux piles
      c.moveTo(-12, 12);
      c.lineTo(-12, -2);
      c.arc(0, -2, 12, Math.PI, 0);
      c.lineTo(12, 12);
      c.moveTo(-6, 12);
      c.lineTo(-6, 0);
      c.arc(0, 0, 6, Math.PI, 0);
      c.lineTo(6, 12);
      break;
    default: // rencontre et autre : une bulle de dialogue
      c.moveTo(-9, -10);
      c.lineTo(9, -10);
      c.quadraticCurveTo(13, -10, 13, -6);
      c.lineTo(13, 3);
      c.quadraticCurveTo(13, 7, 9, 7);
      c.lineTo(-1, 7);
      c.lineTo(-7, 13);
      c.lineTo(-7, 7);
      c.lineTo(-9, 7);
      c.quadraticCurveTo(-13, 7, -13, 3);
      c.lineTo(-13, -6);
      c.quadraticCurveTo(-13, -10, -9, -10);
      c.closePath();
  }
}

/** Un badge rond de la teinte de la catégorie, avec son pictogramme. */
function drawBadge(c: CanvasRenderingContext2D, cat: number): void {
  c.translate(CELL / 2, CELL / 2);
  c.lineJoin = 'round';
  c.lineCap = 'round';
  const shape = () => {
    c.beginPath();
    c.arc(0, 0, BADGE, 0, Math.PI * 2);
  };
  shape();
  c.strokeStyle = HALO_CSS;
  c.lineWidth = 4 + 2 * 2.6;
  c.stroke();
  shape();
  c.fillStyle = CATEGORIES[cat]!.color;
  c.fill();
  shape();
  c.strokeStyle = KEY_CSS;
  c.lineWidth = 3;
  c.stroke();
  c.scale(0.8, 0.8);
  drawGlyph(c, cat);
  c.strokeStyle = inkOn(CATEGORIES[cat]!.color);
  c.fillStyle = c.strokeStyle;
  c.lineWidth = 3.4;
  c.stroke();
  // Pleins : la tête de la croche, le cœur de l'éclat.
  if (cat === 0) {
    c.beginPath();
    c.ellipse(-5, 9, 6, 4.5, -0.4, 0, Math.PI * 2);
    c.fill();
  }
}

let sheet: IconSheet | undefined;
function icons(): IconSheet {
  sheet ??= packIcons(CATEGORIES.map((_, cat) => ({ key: iconKey(cat), width: CELL, height: CELL, draw: (c: CanvasRenderingContext2D) => drawBadge(c, cat) })));
  return sheet;
}

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// --- Chargement ---

function parseEvents(json: { updatedAt: number; sources: EventSource[]; events: Row[] }): EventsData {
  const list: EventItem[] = json.events.map(([id, lon, lat, cat, src, flags, title, commune, minutes]) => ({
    id, lon, lat, cat, src, flags, title, commune, spans: minutes.map((m) => m * 60_000),
  }));
  return { list, byId: new Map(list.map((e) => [e.id, e])), sources: json.sources, updatedAt: json.updatedAt * 1000 };
}

let shared: { at: number; promise: Promise<EventsData>; data?: EventsData } | undefined;

/** Une seule lecture partagée entre la couche et la recherche, gardée une minute. */
export function loadEvents(signal?: AbortSignal): Promise<EventsData> {
  if (shared && Date.now() - shared.at < 60_000) return shared.promise;
  const promise = (async () => {
    const response = await fetch('/api/evenements', { signal });
    if (response.status === 503) throw new Error('le serveur rassemble encore les événements (première collecte)');
    if (!response.ok) throw new Error(`le serveur des événements a répondu ${response.status}`);
    const data = parseEvents((await response.json()) as Parameters<typeof parseEvents>[0]);
    if (shared) shared.data = data;
    return data;
  })();
  const entry: NonNullable<typeof shared> = { at: Date.now(), promise };
  shared = entry;
  promise.catch(() => {
    if (shared === entry) shared = undefined;
  });
  return promise;
}

/** Les événements déjà lus (par la couche ou par la recherche), sinon `undefined`. */
export const peekEvents = (): EventsData | undefined => shared?.data;

// --- Détail d'un événement (lieu, tarif, description, lien), lu à la demande ---

interface Detail {
  place: string;
  address: string;
  price: number;
  priceText: string;
  description: string;
  url: string;
  source: string;
  licence: string;
  sourceUrl: string;
}

const details = new Map<number, Detail | 'attente' | 'erreur'>();

function detailOf(id: number): Detail | 'attente' | 'erreur' {
  const known = details.get(id);
  if (known) return known;
  details.set(id, 'attente');
  fetch(`/api/evenements/fiche?id=${id}`)
    .then((r) => (r.ok ? (r.json() as Promise<Detail>) : Promise.reject(new Error(String(r.status)))))
    .then((d) => details.set(id, d))
    .catch(() => details.set(id, 'erreur'))
    // La fiche ouverte attend ce détail : elle se redessine même si l'horloge est en pause.
    .finally(requestInfoRefresh);
  return 'attente';
}

// --- Temps ---

/** La période affichée, en millisecondes : `[début, fin[`. */
export function periodWindow(period: string, time: number): [number, number] {
  const midnight = parisMidnight(time);
  switch (period) {
    case 'instant':
      return [time, time + 1];
    case 'weekend': {
      const p = parisParts(time);
      const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0 dimanche, 6 samedi
      const toSaturday = weekday === 6 ? 0 : weekday === 0 ? -1 : 6 - weekday;
      return [parisMidnight(time, toSaturday), parisMidnight(time, toSaturday + 2)];
    }
    case '7j':
      return [midnight, parisMidnight(time, 7)];
    default:
      return [midnight, parisMidnight(time, 1)];
  }
}

/** A-t-il lieu dans `[from, to[` ? */
const overlaps = (e: EventItem, from: number, to: number): boolean => {
  for (let i = 0; i < e.spans.length; i += 2) if (e.spans[i]! < to && e.spans[i + 1]! > from) return true;
  return false;
};

/** Est-il en cours à l'instant `t` ? */
const isOn = (e: EventItem, t: number): boolean => overlaps(e, t, t + 1);

/** Prochain moment (début, fin) à partir de `t`, ou le moment en cours. */
function nextSpan(e: EventItem, t: number): [number, number] | undefined {
  for (let i = 0; i < e.spans.length; i += 2) if (e.spans[i + 1]! > t) return [e.spans[i]!, e.spans[i + 1]!];
  return undefined;
}

// --- Filtres ---

/** Les événements qui correspondent aux réglages et à la période de l'instant `time`. */
export function activeEvents(data: EventsData, settings: Readonly<Record<string, string>>, time: number): EventItem[] {
  const [from, to] = periodWindow(settings.periode ?? 'jour', time);
  const category = settings.categorie ?? 'tous';
  const freeOnly = settings.tarif === 'gratuit';
  const withLong = settings.longues === 'oui';
  return data.list.filter(
    (e) => (withLong || !isLong(e)) && (category === 'tous' || Number(category) === e.cat) && (!freeOnly || isFree(e)) && overlaps(e, from, to),
  );
}

/** Mémoire du dernier filtrage : il ne change qu'avec les données, les réglages et la minute (ou le jour) affichés. */
let filterCache: { data: EventsData; key: string; list: EventItem[] } | undefined;
function filtered(data: EventsData, settings: Readonly<Record<string, string>>, time: number): EventItem[] {
  const period = settings.periode ?? 'jour';
  const bucket = period === 'instant' ? Math.floor(time / 60_000) : periodWindow(period, time)[0];
  const key = `${period}|${settings.categorie}|${settings.tarif}|${settings.longues}|${bucket}`;
  if (filterCache?.data !== data || filterCache.key !== key) filterCache = { data, key, list: activeEvents(data, settings, time) };
  return filterCache.list;
}

// --- Regroupement et désencombrement ---

/** Sous ce zoom : des disques gradués par le nombre d'événements ; ensuite des points ; puis les pictogrammes ; puis les titres. */
const DOT_ZOOM = 9;
const ICON_ZOOM = 12;
const NAME_ZOOM = 14.5;
const ALL_ICONS_ZOOM = 16.5;
const LABEL_BOX = { width: 230, height: 26 };
const CLUSTER_CELL = 46;
const CLUSTER_LIST = 24;

export interface Cluster {
  lon: number;
  lat: number;
  count: number;
  /** Les premiers événements de la case, pour la fiche. */
  ids: number[];
}

const COS_LAT = Math.cos((46.5 * Math.PI) / 180);
let clusterCache: { list: EventItem[]; band: number; clusters: Cluster[]; singles: EventItem[] } | undefined;

/** Une case de ~46 px : le nombre d'événements et leur centre ; une case à un seul événement reste un point. */
function clustered(list: EventItem[], zoom: number): { clusters: Cluster[]; singles: EventItem[] } {
  const band = zoomBand(zoom);
  if (clusterCache?.list !== list || clusterCache.band !== band) {
    const metersPerPixel = (156_543.03 * COS_LAT) / 2 ** band;
    const cell = CLUSTER_CELL * metersPerPixel;
    const cells = new Map<string, { sumLon: number; sumLat: number; items: EventItem[] }>();
    for (const e of list) {
      const key = `${Math.floor((e.lon * 111_320 * COS_LAT) / cell)}:${Math.floor((e.lat * 110_540) / cell)}`;
      const c = cells.get(key) ?? cells.set(key, { sumLon: 0, sumLat: 0, items: [] }).get(key)!;
      c.sumLon += e.lon;
      c.sumLat += e.lat;
      c.items.push(e);
    }
    const clusters: Cluster[] = [];
    const singles: EventItem[] = [];
    for (const c of cells.values()) {
      if (c.items.length === 1) singles.push(c.items[0]!);
      else {
        // Les prochains à commencer d'abord.
        const ordered = [...c.items].sort((a, b) => a.spans[0]! - b.spans[0]!);
        clusters.push({ lon: c.sumLon / c.items.length, lat: c.sumLat / c.items.length, count: c.items.length, ids: ordered.slice(0, CLUSTER_LIST).map((e) => e.id) });
      }
    }
    clusterCache = { list, band, clusters, singles };
  }
  return clusterCache;
}

const rankOf = (e: EventItem) => (e.id % 9973) / 9973;

let dotCache: { list: EventItem[]; band: number; items: EventItem[] } | undefined;
function spacedDots(list: EventItem[], zoom: number): EventItem[] {
  const band = zoomBand(zoom);
  if (dotCache?.list !== list || dotCache.band !== band) {
    dotCache = { list, band, items: declutter(list, zoom, { lon: (e) => e.lon, lat: (e) => e.lat, rank: rankOf, box: { width: 12, height: 12 } }) };
  }
  return dotCache.items;
}

let iconCache: { list: EventItem[]; band: number; items: EventItem[] } | undefined;
function spacedIcons(list: EventItem[], zoom: number): EventItem[] {
  const band = zoomBand(zoom);
  if (iconCache?.list !== list || iconCache.band !== band) {
    iconCache = { list, band, items: declutter(list, zoom, { lon: (e) => e.lon, lat: (e) => e.lat, rank: rankOf, box: { width: 25, height: 25 } }) };
  }
  return iconCache.items;
}

let labelCache: { list: EventItem[]; band: number; items: EventItem[] } | undefined;
function labelled(list: EventItem[], zoom: number): EventItem[] {
  const band = zoomBand(zoom);
  if (labelCache?.list !== list || labelCache.band !== band) {
    labelCache = { list, band, items: declutter(list, zoom, { lon: (e) => e.lon, lat: (e) => e.lat, rank: rankOf, box: LABEL_BOX }) };
  }
  return labelCache.items;
}

// --- Fiche ---

const dayFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short' });

/** Un événement sans horaire a lieu de minuit à minuit (jours entiers). */
const isAllDay = (start: number, end: number): boolean => parisMidnight(start) === start && end - start >= DAY - HOUR;

/** « sam. 21 nov. · 20:30–22:30 », ou « sam. 21 nov. · toute la journée ». */
function spanText(start: number, end: number): string {
  const day = dayFormat.format(start);
  if (isAllDay(start, end)) {
    const last = end - 1;
    return parisMidnight(last) === start ? `${day} · toute la journée` : `${day} au ${dayFormat.format(last)}`;
  }
  if (end - start > 45 * DAY) return `Du ${dayFormat.format(start)} au ${dayFormat.format(end - 1)}`;
  if (parisMidnight(end - 1) !== parisMidnight(start)) return `${day} ${formatTime(start)} au ${dayFormat.format(end - 1)} ${formatTime(end)}`;
  return `${day} · ${formatTime(start)}–${formatTime(end)}`;
}

function whenFigure(e: EventItem, time: number): { value: string; label: string } {
  const span = nextSpan(e, time);
  if (!span) return { value: '–', label: 'terminé' };
  const [start, end] = span;
  const allDay = isAllDay(start, end);
  if (start <= time) return { value: allDay ? 'Aujourd’hui' : `jusqu’à ${formatTime(end)}`, label: 'en cours' };
  const sameDay = parisMidnight(start) === parisMidnight(time);
  return allDay ? { value: sameDay ? 'Aujourd’hui' : dayFormat.format(start), label: 'toute la journée' } : { value: formatTime(start), label: sameDay ? 'début aujourd’hui' : dayFormat.format(start) };
}

const FRENCH_UPDATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

function describeCluster(c: Cluster, data: EventsData, time: number): InfoContent {
  const rows = c.ids.flatMap((id) => {
    const e = data.byId.get(id);
    if (!e) return [];
    const span = nextSpan(e, time);
    return [{ cells: [e.title, span ? (span[0] <= time ? 'en cours' : formatTime(span[0])) : ''], select: { id } }];
  });
  const table: InfoTable = { title: `Les premiers sur ${c.count.toLocaleString('fr-FR')}`, columns: ['Événement', 'Début'], rows, empty: 'Aucun événement' };
  return {
    kind: 'Événements · regroupement',
    title: `${c.count.toLocaleString('fr-FR')} événements dans ce secteur`,
    status: plainStatus(`Liste du ${FRENCH_UPDATE.format(data.updatedAt)}`),
    figures: [{ value: c.count.toLocaleString('fr-FR'), label: 'événements' }],
    tables: [table],
    note: 'Zoomez pour les voir un à un.',
  };
}

export const evenements = defineModule<EventsData>({
  id: 'evenements',
  name: 'Événements',
  category: 'territoire',
  description: 'Les événements publics du jour et des jours qui viennent : concerts, spectacles, expositions, fêtes, marchés, sport, visites. Le filtre suit la frise.',
  attribution: 'DATAtourisme (Licence Ouverte 2.0), Ville de Paris « Que faire à Paris » (ODbL), OpenAgenda (Licence Ouverte 1.0)',
  // La liste change au plus quelques fois par jour : on la relit toutes les 30 minutes.
  refreshIntervalMs: 30 * 60_000,
  // Redessinée à chaque minute simulée : « à l'instant » change avec la frise.
  timeStepMs: 60_000,
  zoomBreaks: [...new Set([6, 7, 8, DOT_ZOOM, 10, 11, ...halfZoomBreaks(ICON_ZOOM, 17)])].sort((a, b) => a - b),
  followsTerrain: true,

  settings: [
    { id: 'periode', label: 'Période', options: PERIODS.map((p) => ({ value: p.value, label: p.label })), defaultValue: 'jour' },
    {
      id: 'categorie',
      label: 'Catégorie',
      options: [{ value: 'tous', label: 'Toutes' }, ...CATEGORIES.map((c, i) => ({ value: String(i), label: c.short }))],
      defaultValue: 'tous',
    },
    {
      id: 'tarif',
      label: 'Tarif',
      options: [
        { value: 'tous', label: 'Tous' },
        { value: 'gratuit', label: 'Gratuits seulement' },
      ],
      defaultValue: 'tous',
    },
    {
      id: 'longues',
      label: 'Longues durées',
      options: [
        { value: 'non', label: 'Cachées' },
        { value: 'oui', label: 'Montrées (expositions permanentes, activités à l’année)' },
      ],
      defaultValue: 'non',
    },
  ],

  legend(): LegendItem[] {
    const s = icons();
    return [
      { color: KEY_CSS, label: 'Plein : en cours à l’instant affiché ; estompé : plus tard ou déjà passé dans la période' },
      ...CATEGORIES.map((c, i) => ({ color: c.color, label: c.label, icon: s.dataUrl(iconKey(i)) })),
    ];
  },

  load: ({ signal }) => loadEvents(signal),

  summary({ data, settings, time, view }) {
    if (!data) return null;
    const list = filtered(data, settings, time);
    const period = PERIODS.find((p) => p.value === (settings.periode ?? 'jour'))?.label.toLowerCase() ?? '';
    const hint = view.zoom < ICON_ZOOM ? ' · zoomer pour voir les pictogrammes' : '';
    return `${list.length.toLocaleString('fr-FR')} événement${list.length > 1 ? 's' : ''} · ${period}${hint}`;
  },

  deckLayers({ data, settings, selection, view, terrain, time }) {
    if (!data) return [];
    const list = filtered(data, settings, time);
    const onGround = (p: { lon: number; lat: number }): [number, number, number] => [p.lon, p.lat, terrain.elevation(p.lon, p.lat)];
    const pick = selection as { id?: number; ids?: number[]; lon?: number; lat?: number } | null;
    const chosen = pick?.id !== undefined ? data.byId.get(pick.id) : undefined;
    const chosenCluster = pick?.ids ? ({ lon: pick.lon ?? 0, lat: pick.lat ?? 0 } as { lon: number; lat: number }) : undefined;
    const iconSize = zoomRamp(view.zoom, ICON_ZOOM, 15, 20, 31);
    const alpha = (e: EventItem) => (isOn(e, time) ? 255 : 165);
    const color = (e: EventItem): [number, number, number, number] => [...rgb(CATEGORIES[e.cat]!.color), alpha(e)];
    const layers: unknown[] = [];

    if (view.zoom < DOT_ZOOM) {
      // De loin : des disques gradués par le nombre d'événements de la case, et des points pour les cases isolées.
      const { clusters, singles } = clustered(list, view.zoom);
      const radius = (c: Cluster) => Math.min(26, 9 + 4.2 * Math.log2(c.count));
      layers.push(
        new ScatterplotLayer<EventItem>({
          id: 'evenements/isoles-halo',
          data: singles,
          getPosition: onGround,
          getRadius: 4.4,
          radiusUnits: 'pixels',
          getFillColor: [255, 255, 255, 235],
          billboard: true,
          updateTriggers: { getPosition: terrain.version },
          parameters: OVER_MAP,
        }),
        new ScatterplotLayer<EventItem>({
          id: 'evenements/isoles',
          data: singles,
          getPosition: onGround,
          getRadius: 3,
          radiusUnits: 'pixels',
          getFillColor: color,
          stroked: true,
          getLineColor: KEY,
          getLineWidth: 0.8,
          lineWidthUnits: 'pixels',
          billboard: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 170],
          updateTriggers: { getPosition: terrain.version, getFillColor: Math.floor(time / 60_000) },
          parameters: OVER_MAP,
        }),
        new ScatterplotLayer<Cluster>({
          id: 'evenements/regroupements-halo',
          data: clusters,
          getPosition: onGround,
          getRadius: (c) => radius(c) + 2.6,
          radiusUnits: 'pixels',
          getFillColor: [255, 255, 255, 235],
          billboard: true,
          updateTriggers: { getPosition: terrain.version },
          parameters: OVER_MAP,
        }),
        new ScatterplotLayer<Cluster>({
          id: 'evenements/regroupements',
          data: clusters,
          getPosition: onGround,
          getRadius: radius,
          radiusUnits: 'pixels',
          getFillColor: [20, 26, 38, 232],
          stroked: true,
          getLineColor: KEY,
          getLineWidth: 1.2,
          lineWidthUnits: 'pixels',
          billboard: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 120],
          updateTriggers: { getPosition: terrain.version },
          parameters: OVER_MAP,
        }),
        new TextLayer<Cluster>({
          id: 'evenements/regroupements-nombres',
          data: clusters,
          getPosition: onGround,
          getText: (c) => (c.count >= 10_000 ? `${Math.round(c.count / 1000)} k` : c.count.toLocaleString('fr-FR')),
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 700,
          characterSet: 'auto',
          getSize: 12,
          getColor: [255, 255, 255, 255],
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          billboard: true,
          updateTriggers: { getPosition: terrain.version },
          parameters: OVER_MAP,
        }),
      );
    } else if (view.zoom < ICON_ZOOM) {
      const dots = spacedDots(list, view.zoom);
      const r = zoomRamp(view.zoom, DOT_ZOOM, ICON_ZOOM, 3.6, 5.6);
      layers.push(
        new ScatterplotLayer<EventItem>({
          id: 'evenements/points-halo',
          data: dots,
          getPosition: onGround,
          getRadius: r + 1.5,
          radiusUnits: 'pixels',
          getFillColor: [255, 255, 255, 235],
          billboard: true,
          updateTriggers: { getPosition: terrain.version, getRadius: Math.round(view.zoom * 4) },
          parameters: OVER_MAP,
        }),
        new ScatterplotLayer<EventItem>({
          id: 'evenements/points',
          data: dots,
          getPosition: onGround,
          getRadius: r,
          radiusUnits: 'pixels',
          getFillColor: color,
          stroked: true,
          getLineColor: KEY,
          getLineWidth: 0.9,
          lineWidthUnits: 'pixels',
          billboard: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 170],
          updateTriggers: { getPosition: terrain.version, getRadius: Math.round(view.zoom * 4), getFillColor: Math.floor(time / 60_000) },
          parameters: OVER_MAP,
        }),
      );
    } else {
      const s = icons();
      const shown = view.zoom < ALL_ICONS_ZOOM ? spacedIcons(list, view.zoom) : list;
      const size = iconSize;
      layers.push(
        new IconLayer<EventItem>({
          id: 'evenements/pictogrammes',
          data: shown,
          iconAtlas: s.atlas,
          iconMapping: s.mapping,
          getIcon: (e) => iconKey(e.cat),
          getPosition: onGround,
          sizeUnits: 'pixels',
          getSize: size * 1.3,
          getColor: (e) => [255, 255, 255, alpha(e)],
          billboard: true,
          pickable: true,
          updateTriggers: { getPosition: terrain.version, getSize: Math.round(view.zoom * 4), getColor: Math.floor(time / 60_000) },
          parameters: OVER_MAP,
        }),
      );
      if (view.zoom >= NAME_ZOOM) {
        layers.push(
          new TextLayer<EventItem>({
            id: 'evenements/titres',
            data: labelled(list, view.zoom),
            getPosition: onGround,
            getText: (e) => (e.title.length > 40 ? `${e.title.slice(0, 39)}…` : e.title),
            fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
            fontWeight: 600,
            characterSet: 'auto',
            getSize: 12,
            getColor: [20, 26, 38, 255],
            outlineWidth: 3.5,
            outlineColor: [255, 255, 255, 240],
            fontSettings: { sdf: true, radius: 8 },
            getTextAnchor: 'start',
            getAlignmentBaseline: 'center',
            getPixelOffset: [size * 0.5 + 5, 0],
            maxWidth: 150,
            billboard: true,
            pickable: true,
            updateTriggers: { getPosition: terrain.version, getPixelOffset: Math.round(view.zoom * 4) },
            parameters: OVER_MAP,
          }),
        );
      }
    }
    if (chosen) layers.push(...selectionRing('evenements/choisi', [chosen], onGround, view.zoom >= ICON_ZOOM ? iconSize * 0.72 : 11, OVER_MAP));
    else if (chosenCluster) layers.push(...selectionRing('evenements/choisi', [chosenCluster], onGround, 30, OVER_MAP));
    return layers as never;
  },

  select(object) {
    const o = object as Partial<EventItem> & Partial<Cluster>;
    if (o.ids) return { ids: o.ids, lon: o.lon, lat: o.lat, count: o.count };
    // Le détail se lit dès le clic : il est souvent déjà là au premier dessin de la fiche.
    if (o.id !== undefined) detailOf(o.id);
    return { id: o.id };
  },

  focus(selection, { data }) {
    const pick = selection as { id?: number; lon?: number; lat?: number } | null;
    if (pick?.id !== undefined) {
      const e = data?.byId.get(pick.id);
      return e ? { lon: e.lon, lat: e.lat, fixed: true } : null;
    }
    return pick?.lon !== undefined && pick.lat !== undefined ? { lon: pick.lon, lat: pick.lat, fixed: true } : null;
  },

  describe(selection, { data, time }): InfoContent | null {
    const pick = selection as { id?: number; ids?: number[]; lon?: number; lat?: number; count?: number } | null;
    if (!data || !pick) return null;
    if (pick.ids) return describeCluster({ lon: pick.lon ?? 0, lat: pick.lat ?? 0, count: pick.count ?? pick.ids.length, ids: pick.ids }, data, time);
    const e = pick.id !== undefined ? data.byId.get(pick.id) : undefined;
    if (!e) return null;
    const detail = detailOf(e.id);
    const d = typeof detail === 'object' ? detail : undefined;
    const category = CATEGORIES[e.cat]!;
    const upcoming: string[] = [];
    for (let i = 0; i < e.spans.length && upcoming.length < 6; i += 2) if (e.spans[i + 1]! > time) upcoming.push(spanText(e.spans[i]!, e.spans[i + 1]!));
    const fields: Array<[string, string]> = [['Quand', upcoming.length > 0 ? upcoming.join('\n') : 'Terminé']];
    if (isLong(e)) fields.push(['Durée', 'Longue durée (plus de 45 jours d’affilée)']);
    const where = [d?.place, d?.address || e.commune].filter(Boolean).join(' · ');
    if (where) fields.push(['Lieu', where]);
    const price = d ? [d.price === 1 ? 'Gratuit' : d.price === 3 ? 'Gratuit sous conditions' : d.price === 2 ? 'Payant' : '', d.priceText].filter(Boolean).join(' · ') : isFree(e) ? 'Gratuit' : (e.flags & 4) !== 0 ? 'Payant' : '';
    if (price) fields.push(['Tarif', price]);
    fields.push(['Catégorie', category.short]);
    if (d) fields.push(['Source', d.source], ['Licence', d.licence]);
    const when = whenFigure(e, time);
    return {
      kind: `Événement · ${category.short.toLowerCase()}`,
      title: e.title,
      subtitle: d?.place || e.commune || undefined,
      status: plainStatus(`Liste du ${FRENCH_UPDATE.format(data.updatedAt)}`),
      figures: [{ value: when.value, label: when.label }, ...(price && price.length < 14 ? [{ value: price.split(' · ')[0]!, label: 'tarif' }] : [])],
      fields,
      note: detail === 'attente' ? 'Chargement du détail…' : detail === 'erreur' ? 'Le détail de cet événement n’a pas pu être lu.' : d?.description || undefined,
      link: d?.url ? { href: d.url, label: 'Page de l’événement' } : undefined,
    };
  },
});
