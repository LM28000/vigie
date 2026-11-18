/**
 * Zones surveillées : l'état de la veille (zones, alertes, relevés périodiques) et ses effets (avis dans l'application, titre de
 * l'onglet, son facultatif, `Notification` quand le contexte est sûr). La logique pure (dédoublonnage, adresse, séismes) est dans
 * `veilleLogic.ts`, testée ; l'interface est `ui/Veille.tsx`.
 *
 * # Où vit quoi
 *
 * - **Zones, alertes, vus, préférences** : dans le navigateur (`localStorage`, chaque accès dans un `try/catch` : l'application
 *   marche sans, en mémoire seulement). Le serveur ne garde rien d'une personne.
 * - **Évaluation** : le serveur (`POST /api/veille`, `server/src/synthese/veille.rs`) renvoie, pour chaque zone, ce qui s'y passe
 *   *maintenant*, d'après les réponses déjà en mémoire (aucune requête externe, PRIM IDFM comprise). Les séismes sont évalués ici,
 *   d'après la couche des séismes ou l'EMSC (5 minutes de cache, comme la synthèse).
 * - **Relevé** : toutes les minutes tant qu'il y a une zone (même onglet masqué : les navigateurs ralentissent alors les minuteries
 *   à une par minute, ce qui suffit), et tout de suite quand les zones changent.
 *
 * # Notifications : HTTP sur le réseau local, HTTPS sur Internet
 *
 * Sur le réseau de la maison le site peut être servi en HTTP : l'API `Notification` n'y existe pas (contexte non sécurisé). Les
 * alertes sont toujours **dans l'application** (avis discret, liste, pastille du bouton, compteur dans le titre de l'onglet, son
 * désactivé par défaut). `Notification` n'est utilisée que si `window.isSecureContext` (le site en HTTPS) : une case à cocher
 * du panneau demande alors la permission (jamais au chargement), et la notification n'est émise que si l'onglet est masqué.
 * Limites : l'onglet doit rester ouvert (pas de Web Push, donc rien quand le navigateur est fermé), et certains navigateurs
 * mobiles refusent le constructeur `Notification` (les alertes restent alors dans l'application).
 */
import { useSyncExternalStore } from 'react';
import { circleRing, distanceToRingM, inRing, ringBounds, simplifyRing, type Bounds, type Position } from './geo';
import type { ModuleManager } from './moduleManager';
import { aroundMeRef } from './positionLogic';
import { fetchQuakes } from './syntheseData';
import { departmentAt, departmentByCode } from './syntheseModel';
import {
  DEFAULT_TYPES,
  EVENT_TYPES,
  MAX_RING,
  MAX_ZONES,
  SERVER_TYPES,
  alertKey,
  applyPoll,
  decodeRef,
  decodeZonesParam,
  defaultName,
  encodeRef,
  encodeZonesParam,
  mergeZones,
  quakeEvents,
  titleWithCount,
  trimAlerts,
  unreadCount,
  zoneIdOf,
  type EventType,
  type ParsedZone,
  type SeenMap,
  type VeilleAlert,
  type VeilleEvent,
  type VeilleZone,
  type ZoneRef,
} from './veilleLogic';

export type { EventType, VeilleAlert, VeilleEvent, VeilleZone } from './veilleLogic';

const POLL_MS = 60_000;
const STORAGE = { zones: 'carte-vivante:veille:zones', alerts: 'carte-vivante:veille:alerts', seen: 'carte-vivante:veille:seen', prefs: 'carte-vivante:veille:prefs' } as const;
const TOAST_MS = 9_000;
const MAX_TOASTS = 3;

// --- Stockage du navigateur (jamais indispensable) -----------------------------------------------------------------------------

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // stockage refusé ou plein : la veille continue en mémoire
  }
}

const isRing = (value: unknown): value is Array<[number, number]> =>
  Array.isArray(value) && value.length >= 3 && value.length <= 400 && value.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)));

/** Une zone lue dans le stockage : on ne se fie à rien (une version plus ancienne ou un stockage abîmé ne doit pas casser l'application). */
function sanitizeZone(input: unknown): VeilleZone | null {
  if (!input || typeof input !== 'object') return null;
  const zone = input as Partial<VeilleZone>;
  const ref = typeof zone.ref === 'object' && zone.ref ? decodeRef(encodeRef(zone.ref as ZoneRef)) : null;
  if (!ref || !isRing(zone.ring) || typeof zone.name !== 'string') return null;
  const departments = Array.isArray(zone.departments) ? zone.departments.filter((d): d is string => typeof d === 'string' && /^[0-9A-Za-z]{2,3}$/.test(d)) : [];
  const types = Array.isArray(zone.types) ? zone.types.filter((t): t is EventType => (EVENT_TYPES as readonly string[]).includes(t)) : [...DEFAULT_TYPES];
  return { id: zoneIdOf(ref), name: zone.name.slice(0, 60), ref, ring: zone.ring, departments, types };
}

function sanitizeAlerts(input: unknown): VeilleAlert[] {
  if (!Array.isArray(input)) return [];
  return input.filter(
    (a): a is VeilleAlert =>
      !!a && typeof a === 'object' && typeof a.key === 'string' && typeof a.zoneId === 'string' && typeof a.at === 'number' && !!a.event && typeof a.event.id === 'string' && typeof a.event.title === 'string',
  );
}

// --- Zones : du dessin, d'un département ou d'une commune à un contour --------------------------------------------------------

/** Les départements que touche un contour : ses sommets, son centre et une grille de points dedans (assez fine pour une commune comme pour une région). */
export function departmentsOfRing(ring: readonly Position[]): string[] {
  const codes = new Set<string>();
  const [west, south, east, north] = ringBounds(ring);
  const probe = (lon: number, lat: number) => {
    const code = departmentAt(lon, lat)?.code;
    if (code) codes.add(code);
  };
  for (const [lon, lat] of ring) probe(lon, lat);
  probe((west + east) / 2, (south + north) / 2);
  const step = Math.max(0.02, Math.max(east - west, north - south) / 50);
  for (let lon = west + step / 2; lon < east; lon += step) {
    for (let lat = south + step / 2; lat < north; lat += step) {
      if (inRing(lon, lat, ring)) probe(lon, lat);
    }
  }
  return [...codes].sort();
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;
const lightRing = (ring: readonly Position[]): Array<[number, number]> => simplifyRing(ring, MAX_RING).map(([lon, lat]) => [round5(lon), round5(lat)]);

function buildZone(ref: ZoneRef, name: string, ring: readonly Position[], extraDepartments: string[] = [], types: EventType[] = [...DEFAULT_TYPES]): VeilleZone {
  const light = lightRing(ring);
  return { id: zoneIdOf(ref), name: name.slice(0, 60), ref, ring: light, departments: [...new Set([...extraDepartments, ...departmentsOfRing(light)])].sort(), types };
}

export function zoneFromCircle(center: Position, radius: number, name?: string, types?: EventType[]): VeilleZone {
  const ref: ZoneRef = { kind: 'circle', lon: round5(center[0]), lat: round5(center[1]), radius: Math.round(radius) };
  return buildZone(ref, name ?? defaultName(ref), circleRing(center, radius, 64), [], types);
}

/**
 * « Surveiller autour de moi » : un cercle de `radiusKm` km autour de la position **arrondie à environ 1 km** (`aroundMeRef`).
 * C'est la seule forme de la position qui quitte l'appareil : la zone est envoyée au serveur comme toute zone (en anneau), et
 * s'écrit dans l'adresse de partage ; la position exacte, elle, n'est jamais gardée.
 */
export function zoneAroundMe(lon: number, lat: number, radiusKm: number): VeilleZone {
  const ref = aroundMeRef(lon, lat, radiusKm);
  return zoneFromCircle([ref.lon, ref.lat], ref.radius, `Autour de moi (${radiusKm} km)`);
}

export function zoneFromPolygon(points: readonly Position[], name?: string, types?: EventType[]): VeilleZone {
  const ref: ZoneRef = { kind: 'polygon', points: points.map(([lon, lat]) => [round5(lon), round5(lat)]) };
  return buildZone(ref, name ?? defaultName(ref), points, [], types);
}

type GeoRing = number[][];

/** Le plus grand contour extérieur d'un Polygon ou MultiPolygon GeoJSON (les îles et les trous sont ignorés). */
export function mainRing(geometry: { type: string; coordinates: unknown }): Position[] | null {
  const polygons = (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : []) as GeoRing[][];
  let best: Position[] | null = null;
  let bestSize = -1;
  for (const polygon of polygons) {
    const outer = polygon[0];
    if (!outer || outer.length < 4) continue;
    const ring = outer.map((p) => [p[0]!, p[1]!] as Position);
    const [w, s, e, n] = ringBounds(ring);
    const size = (e - w) * (n - s);
    if (size > bestSize) {
      best = ring;
      bestSize = size;
    }
  }
  return best;
}

export function zoneFromDepartment(code: string, types?: EventType[]): VeilleZone | null {
  const department = departmentByCode(code);
  if (!department) return null;
  const ring = mainRing({ type: 'MultiPolygon', coordinates: department.polygons });
  if (!ring) return null;
  const ref: ZoneRef = { kind: 'department', code };
  const light = lightRing(ring);
  // La zone est le département : la vigilance vaut pour lui seul (le contour allégé pourrait déborder sur un voisin).
  return { id: zoneIdOf(ref), name: `${department.name} (${code})`, ref, ring: light, departments: [code], types: types ?? [...DEFAULT_TYPES] };
}

const COMMUNES = 'https://geo.api.gouv.fr/communes';

export interface CommuneHit {
  code: string;
  name: string;
  department: string;
  population?: number;
}

/** Cherche des communes par nom ou par code postal (geo.api.gouv.fr : ouvert, sans clé, appelé seulement à la création d'une zone). */
export async function searchCommunes(query: string, signal: AbortSignal): Promise<CommuneHit[]> {
  const text = query.trim();
  if (text.length < 2) return [];
  const params = new URLSearchParams({ fields: 'nom,code,codeDepartement,population', boost: 'population', limit: '6' });
  params.set(/^\d{5}$/.test(text) ? 'codePostal' : 'nom', text);
  const response = await fetch(`${COMMUNES}?${params}`, { signal });
  if (!response.ok) throw new Error(`geo.api.gouv.fr a répondu ${response.status}`);
  const rows = (await response.json()) as Array<{ nom: string; code: string; codeDepartement?: string; population?: number }>;
  return rows.map((row) => ({ code: row.code, name: row.nom, department: row.codeDepartement ?? row.code.slice(0, 2), population: row.population }));
}

/** Le contour d'une commune, allégé. */
export async function zoneFromCommune(code: string, signal?: AbortSignal, types?: EventType[]): Promise<VeilleZone> {
  const response = await fetch(`${COMMUNES}/${encodeURIComponent(code)}?fields=nom,code,codeDepartement,contour&format=json&geometry=contour`, { signal });
  if (!response.ok) throw new Error(`geo.api.gouv.fr a répondu ${response.status}`);
  const commune = (await response.json()) as { nom: string; code: string; codeDepartement?: string; contour?: { type: string; coordinates: unknown } };
  const ring = commune.contour ? mainRing(commune.contour) : null;
  if (!ring) throw new Error('contour de la commune indisponible');
  const ref: ZoneRef = { kind: 'commune', code };
  return buildZone(ref, commune.nom, ring, commune.codeDepartement ? [commune.codeDepartement] : [], types);
}

// --- L'état ---------------------------------------------------------------------------------------------------------------------

export interface Toast {
  key: string;
  severity: 1 | 2 | 3 | 4;
  title: string;
  zoneName: string;
  /** Absent pour un avis qui résume plusieurs alertes. */
  alert?: VeilleAlert;
}

export interface VeillePrefs {
  /** Un petit signal sonore à chaque nouvelle alerte : désactivé par défaut. */
  sound: boolean;
  /** `Notification` du navigateur : possible seulement en contexte sûr (HTTPS), et seulement si la personne l'a demandée. */
  notify: boolean;
}

export interface VeilleState {
  zones: VeilleZone[];
  alerts: VeilleAlert[];
  /** Ce qui se passe maintenant dans chaque zone, d'après le dernier relevé. */
  active: Record<string, VeilleEvent[]>;
  open: boolean;
  /** Les alertes arrivées depuis la dernière ouverture du panneau (il les marque « nouveau » tant qu'il est ouvert). */
  newKeys: string[];
  /** Un relevé est en cours. */
  checking: boolean;
  /** Le dernier relevé a échoué (le serveur ne répond pas) : la veille est interrompue, pas calme. */
  error: string | null;
  /** Dernier relevé réussi (ms). */
  checkedAt: number | null;
  /** Types dont la source n'a pas répondu au dernier relevé. */
  unavailable: string[];
  prefs: VeillePrefs;
  toasts: Toast[];
}

const NOTIFICATIONS_POSSIBLE = (): boolean => typeof window !== 'undefined' && window.isSecureContext && typeof Notification !== 'undefined';

class VeilleStore {
  private state: VeilleState;
  private seen: SeenMap;
  private listeners = new Set<() => void>();
  private manager: ModuleManager | undefined;
  private abort: AbortController | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastPollAt = 0;
  private toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private baseTitle = typeof document === 'undefined' ? '' : document.title;
  private audio: AudioContext | undefined;

  constructor() {
    const stored = load<unknown[]>(STORAGE.zones, []);
    const zones = (Array.isArray(stored) ? stored : []).map(sanitizeZone).filter((z): z is VeilleZone => !!z);
    const prefs = load<Partial<VeillePrefs>>(STORAGE.prefs, {});
    this.seen = load<SeenMap>(STORAGE.seen, {});
    if (!this.seen || typeof this.seen !== 'object' || Array.isArray(this.seen)) this.seen = {};
    this.state = {
      zones: mergeZones([], zones),
      alerts: trimAlerts(sanitizeAlerts(load<unknown>(STORAGE.alerts, [])), Date.now()),
      active: {},
      open: false,
      newKeys: [],
      checking: false,
      error: null,
      checkedAt: null,
      unavailable: [],
      prefs: { sound: prefs.sound === true, notify: prefs.notify === true && NOTIFICATIONS_POSSIBLE() },
      toasts: [],
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): VeilleState => this.state;

  private set(patch: Partial<VeilleState>): void {
    this.state = { ...this.state, ...patch };
    this.updateTitle();
    for (const listener of this.listeners) listener();
  }

  private updateTitle(): void {
    if (typeof document === 'undefined') return;
    document.title = titleWithCount(this.baseTitle, unreadCount(this.state.alerts));
  }

  // --- Vie ---

  /** Branche la veille sur le gestionnaire (pour lire les séismes de la couche) et lance les relevés. Renvoie l'arrêt. */
  attach(manager: ModuleManager): () => void {
    this.manager = manager;
    const onVisible = () => {
      if (document.hidden) return;
      // Revenu sur l'onglet avec le panneau ouvert : ce qu'il montre est vu.
      if (this.state.open) this.markAllRead();
      if (Date.now() - this.lastPollAt > POLL_MS) void this.poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    // Un premier relevé tout de suite, mais après le premier affichage de la carte.
    const first = setTimeout(() => void this.poll(), 1500);
    this.updateTitle();
    return () => {
      clearTimeout(first);
      clearInterval(this.timer);
      document.removeEventListener('visibilitychange', onVisible);
      this.abort?.abort();
      this.manager = undefined;
    };
  }

  // --- Zones ---

  private persistZones(): void {
    save(STORAGE.zones, this.state.zones);
  }

  /** Ajoute une zone (ou met à jour ses types et son nom si elle existe déjà). Renvoie `false` au-delà de la limite. */
  addZone(zone: VeilleZone): boolean {
    const existing = this.state.zones.find((z) => z.id === zone.id);
    if (!existing && this.state.zones.length >= MAX_ZONES) return false;
    const zones = existing ? this.state.zones.map((z) => (z.id === zone.id ? { ...zone } : z)) : [...this.state.zones, zone];
    this.set({ zones });
    this.persistZones();
    void this.poll();
    return true;
  }

  removeZone(id: string): void {
    const prefix = `${id}|`;
    this.seen = Object.fromEntries(Object.entries(this.seen).filter(([key]) => !key.startsWith(prefix)));
    const { [id]: _gone, ...active } = this.state.active;
    this.set({ zones: this.state.zones.filter((z) => z.id !== id), alerts: this.state.alerts.filter((a) => a.zoneId !== id), active });
    save(STORAGE.seen, this.seen);
    save(STORAGE.alerts, this.state.alerts);
    this.persistZones();
  }

  setTypes(id: string, types: EventType[]): void {
    this.set({ zones: this.state.zones.map((z) => (z.id === id ? { ...z, types } : z)) });
    this.persistZones();
    void this.poll();
  }

  rename(id: string, name: string): void {
    const clean = name.trim().slice(0, 60);
    if (!clean) return;
    this.set({ zones: this.state.zones.map((z) => (z.id === id ? { ...z, name: clean } : z)), alerts: this.state.alerts.map((a) => (a.zoneId === id ? { ...a, zoneName: clean } : a)) });
    this.persistZones();
    save(STORAGE.alerts, this.state.alerts);
  }

  /** Les zones de l'adresse : celles qu'on n'a pas déjà sont ajoutées (une commune demande son contour au réseau). */
  async importZones(parsed: readonly ParsedZone[]): Promise<void> {
    const incoming: VeilleZone[] = [];
    for (const item of parsed) {
      try {
        const { ref, types, name } = item;
        if (ref.kind === 'circle') incoming.push({ ...zoneFromCircle([ref.lon, ref.lat], ref.radius, name, types) });
        else if (ref.kind === 'polygon') incoming.push(zoneFromPolygon(ref.points, name, types));
        else if (ref.kind === 'department') {
          const zone = zoneFromDepartment(ref.code, types);
          if (zone) incoming.push(zone);
        } else incoming.push({ ...(await zoneFromCommune(ref.code, undefined, types)), name });
      } catch {
        // une commune injoignable ou un contour abîmé : cette zone-là est ignorée
      }
    }
    const zones = mergeZones(this.state.zones, incoming);
    if (zones.length === this.state.zones.length) return;
    this.set({ zones });
    this.persistZones();
    void this.poll();
  }

  /** Pour l'adresse : `veille=…`, ou `null` sans zone. */
  urlValue(): string | null {
    return this.state.zones.length > 0 ? encodeZonesParam(this.state.zones) : null;
  }

  // --- Alertes, préférences, avis ---

  setOpen(open: boolean): void {
    if (open === this.state.open) return;
    // Ouvrir le panneau, c'est voir les alertes : elles sont lues (la pastille et le titre retombent), mais le panneau
    // garde de quoi marquer « nouveau » celles qui ne l'étaient pas, le temps qu'il reste ouvert.
    if (open) {
      this.set({ open, newKeys: this.state.alerts.filter((a) => !a.read).map((a) => a.key) });
      this.markAllRead();
    } else this.set({ open, newKeys: [] });
  }

  toggle(): void {
    this.setOpen(!this.state.open);
  }

  markAllRead(): void {
    if (unreadCount(this.state.alerts) === 0) return;
    this.set({ alerts: this.state.alerts.map((a) => (a.read ? a : { ...a, read: true })) });
    save(STORAGE.alerts, this.state.alerts);
  }

  clearAlerts(): void {
    this.set({ alerts: [] });
    save(STORAGE.alerts, []);
  }

  setSound(sound: boolean): void {
    this.set({ prefs: { ...this.state.prefs, sound } });
    save(STORAGE.prefs, this.state.prefs);
    if (sound) this.beep(); // un essai : la personne entend ce qu'elle active (et le navigateur autorise le son après ce geste)
  }

  /**
   * Propose la permission de `Notification` : sans effet hors contexte sûr (HTTP). À appeler depuis un geste (la case à cocher) :
   * jamais de demande au chargement. Dit pourquoi quand ça n'a pas pu être activé (`'refusee'` : permission refusée, qu'on ne
   * peut rouvrir que dans les réglages du navigateur).
   */
  async setNotify(notify: boolean): Promise<'ok' | 'indisponible' | 'refusee'> {
    if (notify && !NOTIFICATIONS_POSSIBLE()) return 'indisponible';
    const wanted = notify;
    if (notify && Notification.permission === 'default') {
      try {
        if ((await Notification.requestPermission()) !== 'granted') notify = false;
      } catch {
        notify = false;
      }
    } else if (notify && Notification.permission !== 'granted') notify = false;
    this.set({ prefs: { ...this.state.prefs, notify } });
    save(STORAGE.prefs, this.state.prefs);
    return wanted && !notify ? 'refusee' : 'ok';
  }

  notificationsAvailable(): boolean {
    return NOTIFICATIONS_POSSIBLE();
  }

  dismissToast(key: string): void {
    clearTimeout(this.toastTimers.get(key));
    this.toastTimers.delete(key);
    if (this.state.toasts.some((t) => t.key === key)) this.set({ toasts: this.state.toasts.filter((t) => t.key !== key) });
  }

  private pushToast(toast: Toast): void {
    const toasts = [...this.state.toasts.filter((t) => t.key !== toast.key), toast].slice(-MAX_TOASTS);
    for (const gone of this.state.toasts.filter((t) => !toasts.includes(t) && t.key !== toast.key)) clearTimeout(this.toastTimers.get(gone.key));
    this.set({ toasts });
    clearTimeout(this.toastTimers.get(toast.key));
    this.toastTimers.set(toast.key, setTimeout(() => this.dismissToast(toast.key), TOAST_MS));
  }

  private beep(): void {
    try {
      const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return;
      this.audio ??= new Context();
      const audio = this.audio;
      void audio.resume();
      // Deux notes douces (si puis mi), 0,35 s en tout : un signal, pas une sirène.
      [[988, 0], [740, 0.16]].forEach(([frequency, delay]) => {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency!;
        const start = audio.currentTime + delay!;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.19);
        oscillator.connect(gain).connect(audio.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.2);
      });
    } catch {
      // pas de son : tant pis
    }
  }

  private announce(fresh: VeilleAlert[]): void {
    if (fresh.length === 0) return;
    const worst = Math.max(...fresh.map((a) => a.event.severity)) as 1 | 2 | 3 | 4;
    // Le panneau ouvert montre déjà les alertes : pas d'avis par-dessus (l'onglet visible les lit tout de suite).
    if (!this.state.open) {
      if (fresh.length <= MAX_TOASTS) {
        for (const alert of fresh) this.pushToast({ key: alert.key, severity: alert.event.severity, title: alert.event.title, zoneName: alert.zoneName, alert });
      } else {
        this.pushToast({ key: `lot:${Date.now()}`, severity: worst, title: `${fresh.length} nouvelles alertes`, zoneName: [...new Set(fresh.map((a) => a.zoneName))].join(', ') });
      }
    }
    if (this.state.prefs.sound) this.beep();
    if (this.state.prefs.notify && NOTIFICATIONS_POSSIBLE() && Notification.permission === 'granted' && document.hidden) {
      for (const alert of fresh.slice(0, MAX_TOASTS)) {
        try {
          new Notification(alert.event.title, { body: `${alert.zoneName} · ${alert.event.detail}`.slice(0, 200), tag: alert.key });
        } catch {
          // certains navigateurs mobiles refusent le constructeur : les alertes restent dans l'application
        }
      }
    }
  }

  // --- Relevé ---

  /** Un relevé : ce que le serveur dit de chaque zone, les séismes, puis le dédoublonnage et les avis. Sans zone : rien. */
  async poll(): Promise<void> {
    const zones = this.state.zones;
    if (zones.length === 0) {
      if (this.state.error || Object.keys(this.state.active).length > 0) this.set({ error: null, active: {}, unavailable: [] });
      return;
    }
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.lastPollAt = Date.now();
    this.set({ checking: true });

    const results = new Map<string, VeilleEvent[]>();
    let unavailable: string[] = [];
    let error: string | null = null;

    const forServer = zones
      .map((zone) => ({ id: zone.id, ring: zone.ring, departments: zone.departments, types: zone.types.filter((t) => SERVER_TYPES.includes(t)) }))
      .filter((zone) => zone.types.length > 0);
    if (forServer.length > 0) {
      try {
        const response = await fetch('/api/veille', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ zones: forServer }),
          signal: abort.signal,
        });
        if (!response.ok) throw new Error((await response.text()).trim() || `le serveur a répondu ${response.status}`);
        const body = (await response.json()) as { unavailable?: string[]; zones: Array<{ id: string; events: VeilleEvent[] }> };
        unavailable = body.unavailable ?? [];
        for (const zone of body.zones) results.set(zone.id, zone.events.map(withPlace));
      } catch (e) {
        if (abort.signal.aborted) return;
        error = e instanceof Error ? e.message : 'erreur inconnue';
      }
    }

    // Les séismes : seulement pour les zones qui les veulent.
    const wantsQuakes = zones.filter((zone) => zone.types.includes('seisme'));
    if (wantsQuakes.length > 0 && this.manager) {
      try {
        const quakes = await fetchQuakes(this.manager, abort.signal);
        if (quakes) {
          const now = Date.now();
          for (const zone of wantsQuakes) {
            const events = quakeEvents(quakes, (lon, lat) => distanceToRingM([lon, lat], zone.ring), now);
            results.set(zone.id, [...(results.get(zone.id) ?? []), ...events]);
          }
        } else unavailable = [...unavailable, 'seisme'];
      } catch {
        if (abort.signal.aborted) return;
        unavailable = [...unavailable, 'seisme'];
      }
    }
    if (abort.signal.aborted) return;
    if (error && results.size === 0) {
      this.set({ checking: false, error });
      return;
    }

    // Une zone qu'on n'a pas pu évaluer (serveur muet, EMSC muet) ne reçoit ni « calme » ni nouvelles alertes : on ne touche pas à ses traces.
    const evaluated = zones.filter((zone) => results.has(zone.id));
    const now = Date.now();
    const poll = applyPoll(
      this.seen,
      evaluated.map((zone) => ({ zoneId: zone.id, events: results.get(zone.id) ?? [] })),
      now,
    );
    this.seen = poll.seen;
    save(STORAGE.seen, this.seen);

    const names = new Map(zones.map((zone) => [zone.id, zone.name]));
    // Sur un onglet visible dont le panneau est ouvert, une alerte est lue dès qu'elle arrive.
    const readAtOnce = this.state.open && !document.hidden;
    const fresh: VeilleAlert[] = poll.fresh.map(({ zoneId, event }) => ({
      key: alertKey(zoneId, event.id),
      zoneId,
      zoneName: names.get(zoneId) ?? zoneId,
      event,
      at: now,
      read: readAtOnce,
    }));
    const known = new Set(fresh.map((a) => a.key));
    const alerts = trimAlerts([...fresh, ...this.state.alerts.filter((a) => !known.has(a.key) && names.has(a.zoneId))], now);
    const active: Record<string, VeilleEvent[]> = { ...this.state.active };
    for (const zone of evaluated) active[zone.id] = results.get(zone.id) ?? [];
    const newKeys = this.state.open ? [...this.state.newKeys, ...fresh.map((a) => a.key)] : this.state.newKeys;
    this.set({ alerts, active, newKeys, checking: false, error, checkedAt: now, unavailable: [...new Set(unavailable)] });
    save(STORAGE.alerts, this.state.alerts);
    this.announce(fresh);
  }
}

/** Une vigilance vaut pour un département : on la place au milieu de celui-ci et on nomme le département. */
function withPlace(event: VeilleEvent): VeilleEvent {
  if (!event.department) return event;
  const department = departmentByCode(event.department);
  if (!department) return event;
  const [west, south, east, north] = department.bounds as Bounds;
  return { ...event, lon: (west + east) / 2, lat: (south + north) / 2, detail: `${department.name} (${department.code})` };
}

export const veille = new VeilleStore();

export function useVeille(): VeilleState {
  return useSyncExternalStore(veille.subscribe, veille.getSnapshot);
}

/** Pour `shareState.ts` : `veille=` dans l'adresse. */
export const veilleUrl = {
  read: (): string | null => veille.urlValue(),
  write: (value: string): void => {
    const parsed = decodeZonesParam(value);
    if (parsed.length > 0) void veille.importZones(parsed);
  },
};
