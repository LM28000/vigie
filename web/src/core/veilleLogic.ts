/**
 * Veille : la logique pure des zones surveillées, sans dépendance (ni React, ni carte, ni autre fichier du site) pour être testée
 * telle quelle (`node --test web/scripts/veille.test.mjs`). Le magasin qui s'en sert, interroge le serveur et notifie est
 * `veille.ts` ; l'interface est `ui/Veille.tsx`.
 *
 * # Dédoublonnage
 *
 * Le serveur renvoie, à chaque relevé, **tout ce qui se passe maintenant** dans chaque zone (`POST /api/veille`). Le client ne
 * signale qu'une fois un événement : il garde, par couple zone et identifiant d'événement, l'instant où il l'a vu pour la
 * dernière fois. Un événement est **nouveau** s'il n'a jamais été vu, ou s'il avait disparu depuis au moins `REARM_MS` (6 h) :
 * un orage qui revient le soir, un train supprimé le lendemain sont de nouvelles alertes, un feu qui brûle toute la journée n'en
 * est qu'une. Un événement dont la gravité change a un autre identifiant côté serveur (`vig:33:3:3` puis `vig:33:3:4`) : le
 * passage de l'orange au rouge est donc signalé.
 */

/** Les types d'événements (ceux du serveur, plus le séisme, évalué par le site). */
export const EVENT_TYPES = ['vigilance', 'crue', 'montee', 'incendie', 'seisme', 'brouillage', 'avion', 'train', 'avalanche', 'evenement'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const TYPE_LABELS: Record<EventType, string> = {
  vigilance: 'Vigilance orange ou rouge',
  crue: 'Vigilance crues',
  montee: 'Rivière en forte montée',
  incendie: 'Incendie',
  seisme: 'Séisme ressenti',
  brouillage: 'Brouillage GPS',
  avion: 'Avion militaire',
  train: 'Train très en retard ou supprimé',
  avalanche: 'Risque d’avalanche fort (4 ou 5)',
  evenement: 'Événement public (dans les 6 h)',
};

/** Ce qu'on surveille par défaut : tout, sauf les avions militaires (il y en a presque toujours un en vol) et les événements publics (des dizaines par jour). */
export const DEFAULT_TYPES: EventType[] = EVENT_TYPES.filter((type) => type !== 'avion' && type !== 'evenement');

/** Gravité de 1 à 4 (à noter, notable, important, critique), la même que la synthèse. */
export type Severity = 1 | 2 | 3 | 4;

/** Un événement tel que le serveur le sert (`veille.rs`, `Event`), ou tel que le site le calcule (séismes). */
export interface VeilleEvent {
  id: string;
  type: EventType;
  severity: Severity;
  title: string;
  detail: string;
  lon?: number;
  lat?: number;
  /** Une vigilance vaut pour un département : le site place l'événement au milieu. */
  department?: string;
  /** Instant de l'observation (secondes UTC), quand la source en donne un. */
  time?: number;
  module: string;
  selection: unknown;
  zoom: number;
}

/** Une alerte : un événement signalé pour une zone. */
export interface VeilleAlert {
  /** `${zoneId}|${event.id}` */
  key: string;
  zoneId: string;
  zoneName: string;
  event: VeilleEvent;
  /** Premier signalement (ms). */
  at: number;
  /** Vue par l'utilisateur ? */
  read: boolean;
}

/** Un événement disparu depuis au moins ce temps est à nouveau signalé s'il revient. */
export const REARM_MS = 6 * 3_600_000;
/** Les traces de dédoublonnage plus vieilles que cela sont oubliées (elles ne servent plus : `REARM_MS` est passé). */
export const FORGET_MS = 48 * 3_600_000;
/** Alertes gardées : les plus récentes, pas plus vieilles que cela. */
export const MAX_ALERTS = 60;
export const ALERT_KEEP_MS = 7 * 86_400_000;

/** Quand chaque événement a été vu pour la dernière fois (ms), par `zoneId|eventId`. */
export type SeenMap = Record<string, number>;

export const alertKey = (zoneId: string, eventId: string) => `${zoneId}|${eventId}`;

/**
 * Applique un relevé : renvoie les événements **nouveaux** et la carte des vus à jour. Pur : ne modifie pas `seen`.
 * `zoneEvents` est ce que le serveur dit de chaque zone *maintenant* ; une zone absente (supprimée, hors requête) garde ses traces.
 */
export function applyPoll(seen: SeenMap, zoneEvents: ReadonlyArray<{ zoneId: string; events: readonly VeilleEvent[] }>, now: number): { seen: SeenMap; fresh: Array<{ zoneId: string; event: VeilleEvent }> } {
  const next: SeenMap = {};
  for (const [key, at] of Object.entries(seen)) if (now - at < FORGET_MS) next[key] = at;
  const fresh: Array<{ zoneId: string; event: VeilleEvent }> = [];
  for (const { zoneId, events } of zoneEvents) {
    for (const event of events) {
      const key = alertKey(zoneId, event.id);
      const last = seen[key];
      if (last === undefined || now - last >= REARM_MS) fresh.push({ zoneId, event });
      next[key] = now;
    }
  }
  return { seen: next, fresh };
}

/** Les alertes à garder : les plus récentes d'abord, bornées en nombre et en âge. */
export function trimAlerts(alerts: readonly VeilleAlert[], now: number): VeilleAlert[] {
  return [...alerts]
    .filter((alert) => now - alert.at < ALERT_KEEP_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ALERTS);
}

export const unreadCount = (alerts: readonly VeilleAlert[]): number => alerts.filter((alert) => !alert.read).length;

/** Le titre de l'onglet avec le compteur : « (3) Vigie ». */
export function titleWithCount(base: string, count: number): string {
  return count > 0 ? `(${count > 99 ? '99+' : count}) ${base}` : base;
}

// --- Zones ----------------------------------------------------------------------------------------------------------------

export type ZoneRef =
  | { kind: 'circle'; lon: number; lat: number; radius: number }
  | { kind: 'polygon'; points: Array<[number, number]> }
  | { kind: 'department'; code: string }
  | { kind: 'commune'; code: string };

/** Une zone surveillée, telle qu'elle est gardée dans le navigateur. */
export interface VeilleZone {
  id: string;
  name: string;
  ref: ZoneRef;
  /** Contour (anneau ouvert) envoyé au serveur ; allégé à `MAX_RING` sommets. */
  ring: Array<[number, number]>;
  /** Départements touchés (la vigilance est par département). */
  departments: string[];
  types: EventType[];
}

export const MAX_RING = 300;
export const MAX_ZONES = 12;

const fixed = (n: number) => String(Math.round(n * 1e5) / 1e5);

/** `c:lon,lat,rayon` · `p:lon,lat;lon,lat…` · `d:33` · `m:33063` (le même alphabet que `zone=` de l'analyse de zone, plus département et commune). */
export function encodeRef(ref: ZoneRef): string {
  if (ref.kind === 'circle') return `c:${fixed(ref.lon)},${fixed(ref.lat)},${Math.round(ref.radius)}`;
  if (ref.kind === 'polygon') return `p:${ref.points.map((p) => `${fixed(p[0])},${fixed(p[1])}`).join(';')}`;
  return `${ref.kind === 'department' ? 'd' : 'm'}:${ref.code}`;
}

export function decodeRef(text: string): ZoneRef | null {
  const kind = text.slice(0, 2);
  const body = text.slice(2);
  const numbers = (part: string) => part.split(',').map(Number);
  if (kind === 'c:') {
    const [lon, lat, radius] = numbers(body);
    if ([lon, lat, radius].some((n) => n === undefined || !Number.isFinite(n)) || radius! <= 0 || Math.abs(lat!) > 90 || Math.abs(lon!) > 180) return null;
    return { kind: 'circle', lon: lon!, lat: lat!, radius: radius! };
  }
  if (kind === 'p:') {
    const points = body.split(';').map((pair) => numbers(pair));
    if (points.length < 3 || points.length > 400) return null;
    if (points.some((p) => p.length !== 2 || p.some((n) => !Number.isFinite(n)) || Math.abs(p[1]!) > 90 || Math.abs(p[0]!) > 180)) return null;
    return { kind: 'polygon', points: points as Array<[number, number]> };
  }
  if ((kind === 'd:' || kind === 'm:') && /^[0-9A-Za-z]{2,5}$/.test(body)) return { kind: kind === 'd:' ? 'department' : 'commune', code: body };
  return null;
}

/** Identifiant stable d'une zone : l'empreinte de sa définition (FNV-1a), pour que le même lien donne la même zone partout. */
export function zoneIdOf(ref: ZoneRef): string {
  const text = encodeRef(ref);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `z${hash.toString(36)}`;
}

/** Les mots interdits dans une valeur d'adresse séparée par `~` et `!` : on les encode en plus de `encodeURIComponent`. */
const safe = (text: string) => encodeURIComponent(text).replace(/[!~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Les zones pour l'adresse : `veille=ref!types!nom~ref!types!nom`. Types vides : ceux par défaut. */
export function encodeZonesParam(zones: ReadonlyArray<Pick<VeilleZone, 'ref' | 'types' | 'name'>>): string {
  return zones
    .map((zone) => {
      const isDefault = zone.types.length === DEFAULT_TYPES.length && DEFAULT_TYPES.every((type) => zone.types.includes(type));
      return `${encodeRef(zone.ref)}!${isDefault ? '' : zone.types.join(',')}!${safe(zone.name)}`;
    })
    .join('~');
}

export interface ParsedZone {
  ref: ZoneRef;
  types: EventType[];
  name: string;
}

export function decodeZonesParam(text: string): ParsedZone[] {
  const out: ParsedZone[] = [];
  for (const part of text.split('~').slice(0, MAX_ZONES)) {
    const [refText, typesText = '', nameText = ''] = part.split('!');
    const ref = decodeRef(refText ?? '');
    if (!ref) continue;
    const wanted = typesText.split(',').filter((t): t is EventType => (EVENT_TYPES as readonly string[]).includes(t));
    let name = '';
    try {
      name = decodeURIComponent(nameText);
    } catch {
      name = '';
    }
    out.push({ ref, types: wanted.length > 0 ? wanted : [...DEFAULT_TYPES], name: name.slice(0, 60) || defaultName(ref) });
  }
  return out;
}

export function defaultName(ref: ZoneRef): string {
  if (ref.kind === 'circle') return `Cercle de ${ref.radius >= 1000 ? `${(ref.radius / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km` : `${Math.round(ref.radius)} m`}`;
  if (ref.kind === 'polygon') return `Zone à ${ref.points.length} sommets`;
  return ref.kind === 'department' ? `Département ${ref.code}` : `Commune ${ref.code}`;
}

/** Fusionne des zones lues dans l'adresse avec celles que l'on a déjà : celles qui ont déjà la même définition ne sont pas doublées. */
export function mergeZones<T extends { id: string }>(existing: readonly T[], incoming: readonly T[]): T[] {
  const ids = new Set(existing.map((zone) => zone.id));
  const merged = [...existing];
  for (const zone of incoming) {
    if (ids.has(zone.id) || merged.length >= MAX_ZONES) continue;
    ids.add(zone.id);
    merged.push(zone);
  }
  return merged;
}

/** Les types qu'on envoie au serveur (le séisme est évalué ici). */
export const SERVER_TYPES: EventType[] = EVENT_TYPES.filter((type) => type !== 'seisme');

// --- Séismes (évalués par le site : l'EMSC est lu par le navigateur, pas par le serveur) ----------------------------------------------

/** Un séisme tel que la couche des séismes le garde. */
export interface Quake {
  id: string;
  lon: number;
  lat: number;
  depthKm: number;
  mag: number;
  /** ms */
  time: number;
  region: string;
}

/** À partir de la magnitude 3 un séisme peut être ressenti ; en dessous, jamais d'alerte. */
export const QUAKE_FELT_MAG = 3;
export const QUAKE_WINDOW_MS = 24 * 3_600_000;

/** Rayon (km) autour de l'épicentre où le séisme est ressenti : 15 km par unité de magnitude au-dessus de 2 (M 3 : 15 km, M 4 : 30 km, M 5 : 45 km). */
export const feltRadiusKm = (mag: number): number => Math.max(0, 15 * (mag - 2));

const SMALL_WORDS = new Set(['of', 'the', 'and', 'off', 'near']);
/** « NEAR SOUTH COAST OF FRANCE » → « Near South Coast of France » */
export function titleCase(text: string): string {
  return text
    .toLowerCase()
    .split(' ')
    .map((word, i) => (i > 0 && SMALL_WORDS.has(word) ? word : word.replace(/(^|-)\p{L}/gu, (m) => m.toUpperCase())))
    .join(' ');
}

/**
 * Les séismes récents ressentis dans une zone : magnitude 3 ou plus, des dernières 24 h, et assez près pour être sentis
 * (dans la zone, ou à moins de `feltRadiusKm` de son contour). `distanceToZoneM` donne la distance de l'épicentre à la zone.
 */
export function quakeEvents(quakes: readonly Quake[], distanceToZoneM: (lon: number, lat: number) => number, now: number): VeilleEvent[] {
  const events: VeilleEvent[] = [];
  for (const quake of quakes) {
    if (quake.mag < QUAKE_FELT_MAG || now - quake.time > QUAKE_WINDOW_MS || quake.time > now + 60_000) continue;
    const distanceKm = distanceToZoneM(quake.lon, quake.lat) / 1000;
    if (distanceKm > feltRadiusKm(quake.mag)) continue;
    const mag = quake.mag.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    events.push({
      id: `seisme:${quake.id}`,
      type: 'seisme',
      severity: quake.mag >= 4.5 ? 3 : quake.mag >= 3.5 ? 2 : 1,
      title: `Séisme de magnitude ${mag}`,
      detail: `${titleCase(quake.region)} · ${distanceKm < 0.05 ? 'dans la zone' : `à ${Math.round(distanceKm)} km de la zone`} · ${Math.round(quake.depthKm)} km de profondeur`,
      lon: quake.lon,
      lat: quake.lat,
      time: Math.round(quake.time / 1000),
      module: 'seismes',
      selection: { id: quake.id },
      zoom: 7,
    });
  }
  return events;
}
