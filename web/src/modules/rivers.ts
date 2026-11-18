/**
 * Module « Rivières en direct » : la hauteur et le débit des stations hydrométriques de métropole (Hub'Eau,
 * banque Hydro, Service central Vigicrues), avec ce qui compte pour qui regarde la carte : est-ce que ça monte ?
 *
 * Un point par station, coloré par la **tendance de la hauteur sur 3 heures** : monte vite, monte, stable, baisse
 * (échelle divergente, violet pour la montée, gris neutre, sarcelle pour la baisse) et doublé d'un symbole (une ou deux
 * flèches vers le haut, un trait, une flèche vers le bas), car la couleur ne porte jamais seule l'information. Une
 * station sans mesure depuis plus de 3 heures (ou sans assez de recul pour une tendance) est un anneau vide, grisé.
 *
 * Pourquoi la tendance, et pas le niveau : la hauteur d'une station est lue sur son échelle propre, dont le zéro n'a
 * rien de commun avec celui de la station voisine : 1,20 m dit « haut » ici et « bas » là. Sa variation, elle, se
 * compare. On ne montre pas de position par rapport à l'historique de la station : Hub'Eau ne donne pas de seuil ou de
 * normale par station sans une requête par station, et on n'invente pas de « normale ».
 *
 * Les seuils sont fixes pour toute la France : moins de 5 cm d'écart en 3 h, c'est stable (le bruit de mesure et les
 * vaguelettes) ; 30 cm ou plus en 3 h, c'est une montée vite (l'eau gagne 10 cm par heure). Ils sont arbitraires et
 * l'interface le dit ; un petit torrent et un grand fleuve ne bougent pas aux mêmes cadences.
 *
 * Le lien avec la vigilance crues : le serveur rattache chaque station au tronçon Vigicrues voisin (à 1,5 km au plus)
 * quand il est en vigilance jaune, orange ou rouge. Ces stations sont dessinées en dernier, dans un anneau de la
 * couleur de vigilance, et la fiche le dit.
 *
 * Les stations soumises à la marée (marégraphes, estuaires de la Gironde, de la Seine aval, de la Loire aval, de l'Adour…, repérées
 * par le serveur : `rivers::is_tidal`) sont gardées mais présentées à part : un point gris neutre avec une vague, sans couleur de
 * montée ni de décrue, sans étiquette de variation, sans anneau de vigilance, et la fiche le dit. Leur hauteur monte et descend de
 * un à trois mètres deux fois par jour : ce n'est pas une crue.
 *
 * La couche est en direct seulement : le serveur ne garde pas d'historique des stations (l'enregistrement du projet
 * est fait pour des objets qui bougent). La fiche trace tout de même les 48 dernières heures de la station.
 */
import { RIVIERE, STATUS, hexToRgb } from '../design/tokens';
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { isLiveTime, measuredStatus, plainStatus } from '../core/infoStatus';
import { defineModule, type InfoContent } from '../core/module';
import { ModuleManager } from '../core/moduleManager';
import { declutter, halfZoomBreaks, zoomBand } from '../map/declutter';
import { OVER_MAP } from '../map/parameters';
import { formatRelative, formatTime } from '../ui/format';
import { ink, type IconSheet, KEY, packIcons, selectionRing, zoomRamp } from './symbols';
import { STATUS_COLORS } from './statusColors';

interface ApiStation {
  id: string;
  name: string;
  river?: string;
  lon: number;
  lat: number;
  /** Dernière hauteur (mm) et son heure (secondes UTC). */
  h: number;
  t: number;
  /** Variation sur 3 h (mm). */
  d?: number;
  /** Dernier débit (l/s) et son heure. */
  q?: number;
  qt?: number;
  /** Vigilance Vigicrues du tronçon voisin : 2 jaune, 3 orange, 4 rouge. */
  vig?: number;
  vigName?: string;
  /** Station soumise à la marée (marégraphe, estuaire) : le serveur ne lui donne ni tendance ni vigilance. */
  tidal?: boolean;
}

/** Tendance : `none` = sans mesure récente ou sans recul suffisant ; `tidal` = soumise à la marée (pas de tendance de crue). */
type Trend = 'fast-up' | 'up' | 'steady' | 'down' | 'none' | 'tidal';

interface Station extends ApiStation {
  /** Ordre de dessin : la vigilance en dernier, et dedans les montées les plus vives. */
  rank: number;
}

interface RiversData {
  updatedAt: number;
  stations: Station[];
  byId: Map<string, Station>;
}

/** Variation sur 3 h (mm) en dessous de laquelle la hauteur est « stable ». */
const STEADY_MM = 50;
/** Variation sur 3 h (mm) à partir de laquelle la hauteur « monte vite ». */
const FAST_MM = 300;
/** Une mesure plus vieille que cela n'est plus « récente ». */
const STALE_MS = 3 * 3600_000;
const SERIES_TTL_MS = 10 * 60_000;

const TREND_LABEL: Record<Trend, string> = {
  'fast-up': 'monte vite',
  up: 'monte',
  steady: 'stable',
  down: 'baisse',
  none: 'tendance inconnue',
  tidal: 'soumise à la marée',
};

const TREND_INDEX: Record<Exclude<Trend, 'none' | 'tidal'>, number> = { 'fast-up': 0, up: 1, steady: 2, down: 3 };
const trendColor = (trend: Exclude<Trend, 'none' | 'tidal'>, theme: 'jour' | 'nuit') => RIVIERE[theme][TREND_INDEX[trend]]!;

function trendOf(s: ApiStation, now: number): Trend {
  // Une station soumise à la marée n'a pas de tendance de crue : sa hauteur suit les marées (jusqu'à 3 m en 3 h).
  if (s.tidal) return 'tidal';
  if (now - s.t * 1000 > STALE_MS || s.d === undefined) return 'none';
  if (s.d >= FAST_MM) return 'fast-up';
  if (s.d >= STEADY_MM) return 'up';
  if (s.d <= -STEADY_MM) return 'down';
  return 'steady';
}

// --- Symboles ---

const W = 40;
const H = 40;
const PALE = '#f3f7fb';
const key = (trend: Trend) => `riviere:${trend}`;

const sheets: Partial<Record<'jour' | 'nuit', IconSheet>> = {};

/** Une pastille ronde, avec son signe : flèches, trait, ou anneau vide. Dessinées au premier usage (il faut un canvas). */
function sheet(theme: 'jour' | 'nuit'): IconSheet {
  sheets[theme] ??= packIcons(
    (['fast-up', 'up', 'steady', 'down', 'none', 'tidal'] as const).map((trend) => ({
      key: key(trend),
      width: W,
      height: H,
      draw(c: CanvasRenderingContext2D) {
        const cx = 20;
        const cy = 20;
        const r = 12;
        const circle = (k: CanvasRenderingContext2D) => {
          k.beginPath();
          k.arc(cx, cy, r, 0, Math.PI * 2);
        };
        if (trend === 'none') {
          // Un anneau vide : rien à lire ici pour l'instant.
          ink(c, circle, PALE, { key: 2, halo: 2 });
          c.save();
          c.setLineDash([3, 3]);
          c.strokeStyle = RIVIERE[theme][2]!;
          c.lineWidth = 2;
          c.beginPath();
          c.arc(cx, cy, r - 4, 0, Math.PI * 2);
          c.stroke();
          c.restore();
          return;
        }
        if (trend === 'tidal') {
          // Neutre (le gris des « stables », sans couleur de montée ni de décrue) : une vague, signe de la marée, pas une flèche.
          ink(c, circle, RIVIERE[theme][2]!, { key: 2.2, halo: 2 });
          c.save();
          c.strokeStyle = '#ffffff';
          c.lineWidth = 2.4;
          c.lineCap = 'round';
          c.beginPath();
          for (const dy of [-3.4, 3.4]) {
            c.moveTo(cx - 7, cy + dy);
            c.bezierCurveTo(cx - 4.5, cy + dy - 3.4, cx - 2.5, cy + dy - 3.4, cx, cy + dy);
            c.bezierCurveTo(cx + 2.5, cy + dy + 3.4, cx + 4.5, cy + dy + 3.4, cx + 7, cy + dy);
          }
          c.stroke();
          c.restore();
          return;
        }
        ink(c, circle, trendColor(trend, theme), { key: 2.2, halo: 2 });
        c.save();
        c.strokeStyle = '#ffffff';
        c.lineWidth = 2.6;
        c.lineCap = 'round';
        c.lineJoin = 'round';
        const chevron = (y: number, dir: -1 | 1) => {
          c.beginPath();
          // dir -1 : pointe en haut (le sommet est au-dessus des deux extrémités).
          c.moveTo(cx - 5.5, y - dir * 3);
          c.lineTo(cx, y + dir * 3);
          c.lineTo(cx + 5.5, y - dir * 3);
          c.stroke();
        };
        if (trend === 'fast-up') {
          chevron(cy - 3.6, -1);
          chevron(cy + 3.4, -1);
        } else if (trend === 'up') {
          chevron(cy, -1);
        } else if (trend === 'down') {
          chevron(cy, 1);
        } else {
          c.beginPath();
          c.moveTo(cx - 6, cy);
          c.lineTo(cx + 6, cy);
          c.stroke();
        }
        c.restore();
      },
    })),
  );
  return sheets[theme]!;
}

// --- Formats ---

const metersFormat = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const flowFormat = new Intl.NumberFormat('fr-FR', { maximumSignificantDigits: 3 });
const cmFormat = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0, signDisplay: 'exceptZero' });
const meters = (mm: number) => `${metersFormat.format(mm / 1000)} m`;
const centimeters = (mm: number) => `${cmFormat.format(Math.round(mm / 10))} cm`;

/** Débit en litres par seconde → « 12,4 m³/s » ou « 850 L/s » sous 1 m³/s. */
function flow(lps: number): { value: string; unit: string } {
  return lps >= 1000 ? { value: flowFormat.format(lps / 1000), unit: 'm³/s' } : { value: flowFormat.format(lps), unit: 'L/s' };
}

// --- Courbes de 48 h, chargées à l'ouverture de la fiche ---

interface SeriesEntry {
  state: 'loading' | 'ready' | 'failed';
  at: number;
  /** `[instant en ms, hauteur en m]`. */
  points?: Array<readonly [number, number]>;
}

const series = new Map<string, SeriesEntry>();

/** La fiche se recalcule avec l'horloge ; à l'arrêt, rien ne la réveille quand la courbe arrive : on la ressélectionne. */
function wakeCard(id: string): void {
  const manager = ModuleManager.current;
  const selection = manager?.getSelection();
  if (manager && selection?.moduleId === 'rivieres' && (selection.value as { id: string }).id === id) manager.setSelection('rivieres', { id });
}

/** Demande la courbe de la station si elle n'est pas là (ou périmée) ; la fiche est recalculée toutes les 500 ms et la verra arriver. */
function ensureSeries(id: string): SeriesEntry {
  const known = series.get(id);
  if (known && (known.state === 'loading' || Date.now() - known.at < SERIES_TTL_MS)) return known;
  const entry: SeriesEntry = { state: 'loading', at: Date.now(), points: known?.points };
  series.set(id, entry);
  void (async () => {
    try {
      const response = await fetch(`/api/rivieres/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(String(response.status));
      const json = (await response.json()) as { points: Array<[number, number]> };
      series.set(id, { state: 'ready', at: Date.now(), points: json.points.map(([t, mm]) => [t * 1000, mm / 1000] as const) });
      wakeCard(id);
    } catch {
      // Un échec se retente à la prochaine ouverture de la fiche, pas avant 10 minutes sinon.
      series.set(id, { state: 'failed', at: Date.now(), points: known?.points });
      wakeCard(id);
    }
  })();
  return entry;
}

/** Pas des repères de l'axe vertical, selon l'amplitude de la courbe (mètres). */
function niceGrain(range: number): number {
  const target = range / 3;
  return [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5].find((g) => g >= target) ?? 5;
}

// --- Chargement ---

async function loadRivers(signal: AbortSignal): Promise<RiversData> {
  const response = await fetch('/api/rivieres', { signal });
  if (response.status === 503) throw new Error('le serveur récupère encore les rivières');
  if (!response.ok) throw new Error(`le serveur des rivières a répondu ${response.status}`);
  const json = (await response.json()) as { updatedAt: number; stations: ApiStation[] };
  const stations: Station[] = json.stations.map((s) => ({ ...s, rank: 0 }));
  const now = Date.now();
  for (const s of stations) {
    const trend = trendOf(s, now);
    // Du fond vers le dessus : sans tendance, stable, baisse, montée, montée vive ; la vigilance au-dessus de tout.
    s.rank = (s.vig ? 10 + s.vig : 0) + { none: 0, tidal: 0, steady: 1, down: 2, up: 3, 'fast-up': 4 }[trend];
  }
  stations.sort((a, b) => a.rank - b.rank);
  return { updatedAt: json.updatedAt * 1000, stations, byId: new Map(stations.map((s) => [s.id, s])) };
}

interface Shown {
  station: Station;
  trend: Trend;
}

/** Encombrement à l'écran (pixels) d'une étiquette de variation et d'une étiquette de nom. */
const CHANGE_BOX_PX = { width: 100, height: 30 };
const NAME_BOX_PX = { width: 190, height: 28 };

let labelCache: { shown: Shown[]; band: number; changes: Shown[]; names: Shown[] } | undefined;
/**
 * Étiquettes sans chevauchement, par case de la taille d'une étiquette : pour les variations, la plus forte (en valeur
 * absolue) l'emporte ; pour les noms, la station en vigilance puis la plus mouvante.
 */
function labelled(shown: Shown[], zoom: number): { changes: Shown[]; names: Shown[] } {
  const band = zoomBand(zoom);
  if (labelCache?.shown !== shown || labelCache.band !== band) {
    const moving = shown.filter((s) => s.trend === 'fast-up' || s.trend === 'up' || s.trend === 'down');
    const at = { lon: (s: Shown) => s.station.lon, lat: (s: Shown) => s.station.lat };
    labelCache = {
      shown,
      band,
      changes: zoom >= 9 ? declutter(moving, zoom, { ...at, rank: (s) => -Math.abs(s.station.d ?? 0), box: CHANGE_BOX_PX }) : [],
      names: zoom >= 10.5 ? declutter(shown, zoom, { ...at, rank: (s) => -s.station.rank - Math.abs(s.station.d ?? 0) / 1e6, box: NAME_BOX_PX }) : [],
    };
  }
  return labelCache;
}

let shownCache: { data: RiversData; step: number; shown: Shown[] } | undefined;
function shownAt(data: RiversData, step: number): Shown[] {
  if (shownCache?.data !== data || shownCache.step !== step) {
    const now = Date.now();
    shownCache = { data, step, shown: data.stations.map((station) => ({ station, trend: trendOf(station, now) })) };
  }
  return shownCache.shown;
}

const VIGILANCE_NAME: Record<number, string> = { 2: 'jaune', 3: 'orange', 4: 'rouge' };
const VIGILANCE_COLOR: Record<number, string> = { 2: STATUS_COLORS.jaune, 3: STATUS_COLORS.orange, 4: STATUS_COLORS.rouge };

export const rivers = defineModule<RiversData>({
  id: 'rivieres',
  name: 'Rivières en direct',
  category: 'environnement',
  description: 'Hauteur et débit des stations hydrométriques : la rivière monte-t-elle ? Tendance sur 3 h, courbe de 48 h, vigilance crues.',
  attribution: 'Hub’Eau Hydrométrie (OFB, BRGM) · Service central Vigicrues (Licence Ouverte)',
  refreshIntervalMs: 10 * 60_000,
  // Le serveur relève toutes les 15 minutes : un redessin toutes les 5 minutes suffit, et recalcule les stations devenues muettes.
  timeStepMs: 300_000,
  followsTerrain: true,
  // Les étiquettes sont désencombrées par demi-niveau de zoom (`declutter`).
  zoomBreaks: [6, ...halfZoomBreaks(9)],

  legend() {
    const jour = sheet('jour');
    return [
      { color: RIVIERE.jour[0]!, label: 'Monte vite (30 cm ou plus en 3 h)', icon: jour.dataUrl(key('fast-up')) },
      { color: RIVIERE.jour[1]!, label: 'Monte (5 cm ou plus en 3 h)', icon: jour.dataUrl(key('up')) },
      { color: RIVIERE.jour[2]!, label: 'Stable (moins de 5 cm en 3 h)', icon: jour.dataUrl(key('steady')) },
      { color: RIVIERE.jour[3]!, label: 'Baisse (5 cm ou plus en 3 h)', icon: jour.dataUrl(key('down')) },
      { color: RIVIERE.jour[2]!, label: 'Sans mesure récente ou sans tendance', icon: jour.dataUrl(key('none')) },
      { color: RIVIERE.jour[2]!, label: 'Soumis à la marée (estuaire, marégraphe) : ni tendance ni vigilance', icon: jour.dataUrl(key('tidal')) },
      { color: STATUS_COLORS.orange, label: 'Anneau de couleur : tronçon voisin en vigilance crues', size: 'large' as const },
    ];
  },

  load: ({ signal }) => loadRivers(signal),

  summary({ data }) {
    if (!data) return null;
    const shown = shownAt(data, Math.floor(Date.now() / 300_000));
    const count = (t: Trend) => shown.filter((s) => s.trend === t).length;
    const rising = count('up') + count('fast-up');
    const alerts = data.stations.filter((s) => s.vig).length;
    const tidal = count('tidal');
    return `${data.stations.length} stations · ${rising} montent, ${count('down')} baissent${alerts ? ` · ${alerts} sur un tronçon en vigilance` : ''}${tidal ? ` · ${tidal} soumises à la marée` : ''}`;
  },

  deckLayers({ data, selection, terrain, view, night }) {
    if (!data) return [];
    const step = Math.floor(Date.now() / 300_000);
    const shown = shownAt(data, step);
    const theme = night >= 0.5 ? 'nuit' : 'jour';
    const icons = sheet(theme);
    const size = zoomRamp(view.zoom, 4.5, 10, 10, 28);
    const onGround = (s: Shown): [number, number, number] => [s.station.lon, s.station.lat, terrain.elevation(s.station.lon, s.station.lat)];
    const chosenId = selection ? (selection as { id: string }).id : undefined;
    const chosen = shown.filter((s) => s.station.id === chosenId);
    const alerts = shown.filter((s) => s.station.vig);
    const labels = labelled(shown, view.zoom);
    const parameters = OVER_MAP;
    const alpha = (s: Shown) => (s.trend === 'none' ? 170 : 255);
    const ring = {
      data: alerts,
      getPosition: onGround,
      getRadius: size * 0.78,
      radiusUnits: 'pixels' as const,
      filled: false,
      stroked: true,
      lineWidthUnits: 'pixels' as const,
      billboard: true,
      parameters,
      updateTriggers: { getPosition: terrain.version, getRadius: size },
    };
    return [
      // L'anneau de vigilance passe sous le symbole, avec son liseré sombre : lisible sur le fond clair comme sur la nuit.
      alerts.length > 0 &&
        new ScatterplotLayer<Shown>({ ...ring, id: 'rivieres/vigilance-contour', getLineColor: hexToRgb(STATUS.ink), getLineWidth: 6.5 }),
      alerts.length > 0 &&
        new ScatterplotLayer<Shown>({
          ...ring,
          id: 'rivieres/vigilance',
          getLineColor: (s) => hexToRgb(VIGILANCE_COLOR[s.station.vig ?? 2]!),
          getLineWidth: 3.5,
          updateTriggers: { getPosition: terrain.version, getRadius: size, getLineColor: step },
        }),
      new IconLayer<Shown>({
        id: 'rivieres/stations',
        data: shown,
        iconAtlas: icons.atlas,
        iconMapping: icons.mapping,
        getIcon: (s) => key(s.trend),
        getPosition: onGround,
        getColor: (s) => [255, 255, 255, alpha(s)],
        sizeUnits: 'pixels',
        getSize: size,
        billboard: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 140],
        updateTriggers: { getIcon: [step, theme], getColor: step, getPosition: terrain.version, getSize: size },
        parameters,
      }),
      labels.changes.length > 0 &&
        new TextLayer<Shown>({
          id: 'rivieres/variations',
          data: labels.changes,
          getPosition: onGround,
          getText: (s) => `${centimeters(s.station.d ?? 0)} / 3 h`,
          characterSet: 'auto',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 700,
          getSize: 11,
          getColor: KEY,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'top',
          getPixelOffset: [0, size * 0.55],
          background: true,
          getBackgroundColor: [255, 255, 255, 238],
          getBorderColor: [20, 26, 38, 150],
          getBorderWidth: 1,
          backgroundBorderRadius: 8,
          backgroundPadding: [6, 2],
          billboard: true,
          pickable: true,
          updateTriggers: { getText: step, getPosition: terrain.version, getPixelOffset: size },
          parameters,
        }),
      labels.names.length > 0 &&
        new TextLayer<Shown>({
          id: 'rivieres/noms',
          data: labels.names,
          getPosition: onGround,
          getText: (s) => s.station.name,
          characterSet: 'auto',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 600,
          getSize: 11.5,
          getColor: KEY,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'bottom',
          getPixelOffset: [0, -size * 0.55 - 2],
          background: true,
          getBackgroundColor: [255, 255, 255, 225],
          backgroundBorderRadius: 6,
          backgroundPadding: [5, 1],
          billboard: true,
          pickable: true,
          updateTriggers: { getPosition: terrain.version, getPixelOffset: size },
          parameters,
        }),
      chosen.length > 0 && selectionRing('rivieres/choisi', chosen, onGround, size * 0.62, parameters),
    ];
  },

  select(object) {
    return { id: (object as Shown).station.id };
  },

  focus(selection, { data }) {
    const s = data?.byId.get((selection as { id: string }).id);
    return s ? { lon: s.lon, lat: s.lat, fixed: true } : null;
  },

  describe(selection, { data, time }) {
    const id = (selection as { id: string }).id;
    const s = data?.byId.get(id);
    if (!s) return null;
    const trend = trendOf(s, Date.now());
    const measuredAt = s.t * 1000;
    const live = isLiveTime(time);

    let status: InfoContent['status'];
    if (Date.now() - measuredAt > STALE_MS) status = plainStatus(`Sans mesure récente · dernière ${formatRelative(measuredAt)}`);
    else if (live) status = measuredStatus(time, measuredAt);
    else status = plainStatus(`En direct seulement · mesure de ${formatTime(measuredAt)}`);

    const q = s.q !== undefined ? flow(s.q) : undefined;
    const trendFigure =
      trend === 'tidal'
        ? { value: 'Marée', label: 'hauteur soumise à la marée : pas de tendance' }
        : s.d !== undefined && trend !== 'none'
        ? { value: centimeters(s.d), label: `sur 3 h · ${TREND_LABEL[trend]}` }
        : { value: '—', label: 'tendance indisponible' };
    const figures = [
      trendFigure,
      { value: metersFormat.format(s.h / 1000), unit: 'm', label: 'hauteur' },
      q ? { value: q.value, unit: q.unit, label: 'débit' } : { value: '—', label: 'débit non mesuré' },
    ];

    const entry = ensureSeries(id);
    let chart: InfoContent['chart'];
    if (entry.points && entry.points.length > 1) {
      const values = entry.points.map((p) => p[1]);
      const lo = Math.min(...values);
      const hi = Math.max(...values);
      chart = {
        title: 'Hauteur (m) sur 48 h',
        unit: 'm',
        points: entry.points,
        now: time,
        grain: niceGrain(hi - lo),
        summary: `Hauteur de l’eau à ${s.name} sur 48 heures : de ${metersFormat.format(lo)} m à ${metersFormat.format(hi)} m, ${metersFormat.format(s.h / 1000)} m à la dernière mesure.`,
      };
    }

    const fields: Array<[string, string]> = [];
    if (s.river) fields.push(['Cours d’eau', s.river]);
    fields.push(['Dernière hauteur', `${formatTime(measuredAt)} · ${meters(s.h)}`]);
    if (s.q !== undefined && s.qt !== undefined) fields.push(['Dernier débit', `${formatTime(s.qt * 1000)} · ${q!.value} ${q!.unit}`]);
    if (s.vig) fields.push(['Vigilance crues', `${VIGILANCE_NAME[s.vig]![0]!.toUpperCase()}${VIGILANCE_NAME[s.vig]!.slice(1)} · tronçon « ${s.vigName ?? ''} » à proximité`]);
    if (entry.state === 'loading' && !chart) fields.push(['Courbe de 48 h', 'chargement…']);
    if (entry.state === 'failed' && !chart) fields.push(['Courbe de 48 h', 'indisponible pour l’instant']);

    return {
      kind: s.vig ? `Station hydrométrique · vigilance crues ${VIGILANCE_NAME[s.vig]}` : trend === 'tidal' ? 'Station hydrométrique · soumise à la marée' : 'Station hydrométrique',
      title: s.name,
      subtitle: s.river,
      status,
      figures,
      chart,
      fields,
      note:
        (trend === 'tidal'
          ? 'Cette station est soumise à la marée (marégraphe ou estuaire) : sa hauteur monte et descend deux fois par jour, de un à trois mètres en quelques heures, sans que ce soit une crue. Vigie ne calcule donc pour elle ni tendance de montée, ni alerte, ni vigilance de crue ; la courbe de 48 h montre le rythme des marées. '
          : '') +
        (s.vig
          ? `Le tronçon Vigicrues voisin « ${s.vigName ?? ''} » est en vigilance ${VIGILANCE_NAME[s.vig]} : la station est proche de ce tronçon, sans être forcément l’un de ses points de mesure. `
          : '') +
        'La hauteur est lue sur l’échelle propre de la station : elle ne se compare pas d’une station à l’autre, c’est sa variation qui compte. ' +
        'Tendance : écart entre la dernière hauteur et celle d’il y a 3 h (stable sous 5 cm, monte vite à partir de 30 cm), mêmes seuils pour toute la France. ' +
        'Mesures brutes en temps réel, non validées, relevées toutes les 5 à 60 minutes selon la station.',
      actions: [
        { label: 'Fiche sur Hydroportail', href: `https://www.hydro.eaufrance.fr/stationhydro/${encodeURIComponent(id)}/fiche` },
        ...(s.vig ? [{ label: 'Vigilance sur Vigicrues', href: 'https://www.vigicrues.gouv.fr/' }] : []),
      ],
    };
  },
});
