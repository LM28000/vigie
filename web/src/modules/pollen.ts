/**
 * Module « Pollens » : l'indice pollen de chaque commune de métropole (aujourd'hui, demain et après-demain),
 * global et pour six taxons : aulne, bouleau, olivier, graminées, armoise, ambroisie.
 *
 * Source : Atmo Data (Atmo France), flux « Indice pollen » : l'indice officiel de la Fédération Atmo France,
 * prévu chaque jour par les associations agréées de surveillance de la qualité de l'air (AASQA). Le serveur le
 * relève une fois par jour (server/src/pollen.rs). Il n'y a pas d'historique : avant le premier jour publié,
 * la carte est vide et le dit. Le flux n'a pas de géométrie : le serveur place chaque commune à son centre.
 *
 * Hors saison (de l'automne à la fin de l'hiver pour la plupart des taxons), le flux publie « très faible »
 * partout avec des concentrations nulles. Le serveur garde cette différence (caractère « o ») : la carte dit
 * « aucun pollen » (gris, discret) plutôt que de peindre toute la France d'un « très faible » turquoise.
 *
 * Forme : une couche MapLibre native, comme la qualité de l'air, mais dans une autre forme pour ne jamais se
 * confondre avec elle quand les deux sont affichées : l'indice ATMO est un champ flou de disques pleins ; les
 * pollens sont des anneaux nets, à peine remplis. Les plus hauts niveaux sont dessinés par-dessus.
 *
 * Couleurs : la palette officielle de l'indice pollen d'Atmo France (légende du service de cartes de l'association),
 * qui est celle de l'indice ATMO. Elle n'est jamais seule : légende, fiche et résumé donnent le libellé du niveau,
 * et la forme (anneaux, pas disques flous) distingue les deux couches.
 */
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { STATUS } from '../design/tokens';
import { plainStatus, scheduledStatus } from '../core/infoStatus';
import { defineModule, type InfoContent, type LegendItem } from '../core/module';
import { firstSymbolLayerId } from '../map/baseMap';
import { formatTime } from '../ui/format';
import departements from '../data/departements.json';
import { LEVELS, NONE, NONE_COLOR, NONE_NAME, TAXA, cellOf, levelName, type PollenData } from './pollenLogic';

// --- Aides -----------------------------------------------------------------------------------

const dayKeyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayNameFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });

const dayKey = (time: number): string => dayKeyFormat.format(time);
const dayName = (key: string): string => dayNameFormat.format(new Date(`${key}T12:00:00Z`));

/** Position du jour de l'horloge parmi les jours publiés, -1 s'il n'est pas publié. */
const dayIndexAt = (data: PollenData, time: number): number => data.days.indexOf(dayKey(time));

const DEPARTMENT_NAMES = new Map(
  (departements as unknown as { features: Array<{ properties: { code: string; nom: string } }> }).features.map((f) => [f.properties.code, f.properties.nom]),
);
const departmentOf = (code: string): string | undefined => DEPARTMENT_NAMES.get(code.slice(0, 2));

const SMALL_WORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'en', 'et', 'sur', 'sous', 'd', 'l']);
/** « GRAND-FORT-PHILIPPE » devient « Grand-Fort-Philippe » ; un nom déjà en casse mixte reste tel quel. */
function titleCase(text: string): string {
  if (text !== text.toUpperCase()) return text;
  return text
    .toLowerCase()
    .replace(/[\p{L}\p{N}]+/gu, (word, offset: number) => (offset > 0 && SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)));
}

/** Décalage choisi par le réglage « Pollen » : 0 pour « le pire » (l'indice global), 1 à 6 pour un taxon. */
const offsetOf = (settings: Readonly<Record<string, string>>): number => {
  const k = TAXA.findIndex((t) => t.id === settings.taxon);
  return k >= 0 ? k + 1 : 0;
};

// --- Rendu -----------------------------------------------------------------------------------

const SOURCE_ID = 'pollen';
const FIELD_ID = 'pollen-communes';
const SELECTED_ID = 'pollen-choisi';
const INK = STATUS.ink;

/** Rayon des anneaux (pixels) selon le zoom : plus petits que les disques de l'air, pour ne pas les recouvrir. */
const RADIUS: Array<[number, number]> = [[4, 1.2], [5, 1.8], [6, 2.6], [7, 4], [8, 6], [9, 8], [10, 10], [12, 13], [15, 16]];
const radiusExpression = (extra = 0): unknown[] => ['interpolate', ['linear'], ['zoom'], ...RADIUS.flatMap(([zoom, radius]) => [zoom, radius + extra])];

const colorExpression = (): unknown[] => [
  'match',
  ['get', 'q'],
  ...[1, 2, 3, 4, 5, 6].flatMap((level) => [level, LEVELS[level]!.color]),
  NONE,
  NONE_COLOR,
  'rgba(0,0,0,0)',
];

/** « Aucun pollen » est très discret (un repère de couverture) ; un niveau est net. */
const fillOpacity: unknown[] = ['case', ['==', ['get', 'q'], NONE], 0.1, 0.32];
const strokeOpacity: unknown[] = ['case', ['==', ['get', 'q'], NONE], 0.3, 0.95];

interface GeoJson {
  type: 'FeatureCollection';
  features: Array<{ type: 'Feature'; id: number; geometry: { type: 'Point'; coordinates: [number, number] }; properties: { i: number; q: number } }>;
}

/** Les communes évaluées ce jour-là pour ce décalage. Reconstruit quand le jour ou le taxon change (rare). */
function buildGeo(data: PollenData, day: number, offset: number): GeoJson {
  const features: GeoJson['features'] = [];
  if (day >= 0) {
    for (let i = 0; i < data.zones.name.length; i++) {
      const q = cellOf(data, i, day, offset);
      if (q > 0) features.push({ type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [data.zones.lon[i]!, data.zones.lat[i]!] }, properties: { i, q } });
    }
  }
  return { type: 'FeatureCollection', features };
}

let shown: { data: PollenData; day: number; offset: number } | undefined;

function update(map: MapLibreMap, data: PollenData | undefined, time: number, settings: Readonly<Record<string, string>>, selection: unknown): void {
  if (!map.getLayer(FIELD_ID)) return;
  if (data) {
    const day = dayIndexAt(data, time);
    const offset = offsetOf(settings);
    if (!shown || shown.data !== data || shown.day !== day || shown.offset !== offset) {
      (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(buildGeo(data, day, offset) as never);
      shown = { data, day, offset };
    }
  }
  const index = (selection as { i?: number } | null)?.i ?? -1;
  for (const id of [SELECTED_ID, `${SELECTED_ID}-contour`]) if (map.getLayer(id)) map.setFilter(id, ['==', ['get', 'i'], index] as never);
}

// --- Chargement ------------------------------------------------------------------------------

async function loadPollen(signal: AbortSignal): Promise<PollenData> {
  const response = await fetch('/api/pollen', { signal });
  if (response.status === 503) throw new Error(await response.text().then((t) => t || 'le serveur récupère encore l’indice pollen'));
  if (!response.ok) throw new Error(`le serveur de l’indice pollen a répondu ${response.status}`);
  return (await response.json()) as PollenData;
}

// --- Résumé ----------------------------------------------------------------------------------

function summaryText(data: PollenData, time: number, offset: number): string {
  const day = dayIndexAt(data, time);
  if (day < 0) {
    const first = data.days[0];
    return first && dayKey(time) < first
      ? 'Pas d’historique : l’indice pollen n’est publié que pour aujourd’hui et les deux jours à venir'
      : 'Indice pollen pas encore publié pour ce jour (il couvre aujourd’hui et les deux jours suivants)';
  }
  const counts = new Array<number>(10).fill(0);
  const byDepartment = new Map<string, number>();
  const byTaxon = new Array<number>(TAXA.length).fill(0);
  let total = 0;
  for (let zone = 0; zone < data.zones.name.length; zone++) {
    const level = cellOf(data, zone, day, offset);
    if (level === 0) continue;
    total++;
    counts[level]!++;
    if (level >= 4) {
      const department = data.zones.code[zone]!.slice(0, 2);
      byDepartment.set(department, (byDepartment.get(department) ?? 0) + 1);
      if (offset === 0) for (let k = 0; k < TAXA.length; k++) if (cellOf(data, zone, day, k + 1) === level) byTaxon[k]!++;
    }
  }
  const label = offset === 0 ? 'Pollens' : `Pollen ${TAXA[offset - 1]!.name.toLowerCase()}`;
  if (total === 0) return `${label} : pas d’indice publié pour ${dayName(data.days[day]!)}`;
  if (counts[NONE]! / total >= 0.98) return `${label} : hors saison, aucun pollen annoncé`;
  const high = counts[4]! + counts[5]! + counts[6]!;
  const parts: string[] = [];
  if (high > 0) {
    const [top] = [...byDepartment].sort((a, b) => b[1] - a[1]);
    const where = top ? DEPARTMENT_NAMES.get(top[0]) : undefined;
    const taxon = offset === 0 ? TAXA[byTaxon.indexOf(Math.max(...byTaxon))] : undefined;
    parts.push(`niveau élevé ou pire dans ${high.toLocaleString('fr-FR')} commune${high > 1 ? 's' : ''}${where ? `, surtout en ${where}` : ''}${taxon ? ` (${taxon.name.toLowerCase()})` : ''}`);
  } else {
    const moderate = counts[3]!;
    parts.push(moderate > 0 ? `niveau modéré dans ${moderate.toLocaleString('fr-FR')} commune${moderate > 1 ? 's' : ''}, élevé nulle part` : 'faible à très faible partout');
  }
  const none = Math.round((counts[NONE]! / total) * 100);
  if (none >= 50) parts.push(`${none} % des communes sans pollen`);
  return `${label} : ${parts.join(', ')}`;
}

// --- Module ----------------------------------------------------------------------------------

export const pollen = defineModule<PollenData>({
  id: 'pollen',
  name: 'Pollens',
  category: 'environnement',
  description: 'Indice pollen de chaque commune (aujourd’hui et les deux jours suivants) : global, aulne, bouleau, olivier, graminées, armoise, ambroisie.',
  attribution: 'Atmo France / AASQA (indice pollen)',
  // Publié une fois par jour : le serveur le relève quand le flux change ; ici, un rechargement par heure suffit.
  refreshIntervalMs: 60 * 60_000,
  // Change avec le jour de l'horloge : une fois par minute suffit.
  timeStepMs: 60_000,

  settings: [
    {
      id: 'taxon',
      label: 'Pollen',
      defaultValue: 'worst',
      options: [{ value: 'worst', label: 'Le pire (indice global)' }, ...TAXA.map((t) => ({ value: t.id, label: t.name }))],
    },
  ],

  load: ({ signal }) => loadPollen(signal),

  legend(_settings, data): LegendItem[] {
    const items: LegendItem[] = [1, 2, 3, 4, 5, 6].map((level) => ({ color: LEVELS[level]!.color, label: LEVELS[level]!.name, size: 'medium' as const }));
    // « Aucun pollen » n'est dans la légende que s'il y a de quoi le voir (hors saison, ou taxons absents de la région).
    if (!data || data.zones.v.some((v) => v.includes('o'))) items.push({ color: NONE_COLOR, label: `${NONE_NAME} (hors saison)`, size: 'small' as const });
    return items;
  },

  summary({ data, time, settings }) {
    return data ? summaryText(data, time, offsetOf(settings)) : null;
  },

  native: {
    add(map) {
      shown = undefined;
      map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer(
        {
          id: FIELD_ID,
          type: 'circle',
          source: SOURCE_ID,
          layout: { 'circle-sort-key': ['get', 'q'] as never },
          paint: {
            'circle-radius': radiusExpression() as never,
            'circle-color': colorExpression() as never,
            'circle-opacity': fillOpacity as never,
            'circle-blur': 0,
            'circle-stroke-color': colorExpression() as never,
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 4, 0.6, 8, 1, 11, 1.8] as never,
            'circle-stroke-opacity': strokeOpacity as never,
            'circle-pitch-alignment': 'map',
            'circle-pitch-scale': 'map',
          },
        },
        firstSymbolLayerId(map),
      );
      // La commune choisie : liseré blanc cerné de sombre, sans teinte.
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
    },
    update(map, { data, time, selection, settings }) {
      update(map, data, time, settings, selection);
    },
    remove(map) {
      for (const id of [SELECTED_ID, `${SELECTED_ID}-contour`, FIELD_ID]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      shown = undefined;
    },
    pickable: {
      layerIds: [FIELD_ID],
      toObject: (feature) => ({ i: Number(feature.properties?.i) }),
    },
  },

  select(object) {
    const o = object as { i?: number };
    return Number.isInteger(o.i) && o.i! >= 0 ? { i: o.i } : null;
  },

  focus(selection, { data }) {
    const i = (selection as { i?: number } | null)?.i;
    return data && i !== undefined && data.zones.name[i] !== undefined ? { lon: data.zones.lon[i]!, lat: data.zones.lat[i]!, fixed: true } : null;
  },

  describe(selection, { data, time }): InfoContent | null {
    return describeZone(selection as { i: number }, data, time);
  },
});

// --- Fiche -----------------------------------------------------------------------------------

function describeZone(selection: { i: number }, data: PollenData | undefined, time: number): InfoContent | null {
  const zone = selection.i;
  if (!data || data.zones.name[zone] === undefined) return null;
  const name = titleCase(data.zones.name[zone]!);
  const code = data.zones.code[zone]!;
  const department = departmentOf(code);
  const source = data.sources[data.zones.src[zone]!] ?? '';
  const subtitle = `Commune${department ? ` · ${department} (${code.slice(0, 2)})` : ''}${source ? ` · ${source}` : ''}`;
  const day = dayIndexAt(data, time);
  const level = day < 0 ? 0 : cellOf(data, zone, day);
  if (level === 0) {
    return {
      kind: 'Pollens',
      title: name,
      subtitle,
      note: 'Pas d’indice pollen publié pour cette commune à cette date : l’indice ne couvre que le jour même et les deux jours suivants, il n’y a pas d’historique.',
    };
  }
  const dayText = dayName(data.days[day]!);
  const published = data.issuedAt ? ` · publié à ${formatTime(data.issuedAt * 1000)}` : '';
  const isToday = data.days[day] === dayKey(Date.now());
  const subs = TAXA.map((t, k) => ({ ...t, level: cellOf(data, zone, day, k + 1) }));
  const maxSub = Math.max(...subs.map((s) => (s.level === NONE ? 0 : s.level)));
  const dominant = maxSub >= 2 ? subs.filter((s) => s.level === maxSub) : [];
  const dominantText = level === NONE ? 'Aucun' : dominant.length === 0 ? 'Aucun marqué' : dominant.length > 2 ? 'Plusieurs' : dominant.map((s) => s.name).join(' et ');

  const week = data.days.map((d, k) => ({ d, level: cellOf(data, zone, k) }));
  return {
    kind: `Pollens · ${levelName(level).toLowerCase()}`,
    title: name,
    subtitle,
    // L'indice est une prévision des associations (mesures et modèles), pas un relevé direct.
    status: isToday ? plainStatus(`Indice du jour${published}`) : scheduledStatus(`Prévision pour ${dayText}${published}`),
    figures: [
      { value: levelName(level), label: level === NONE ? 'indice pollen (hors saison)' : `indice pollen (${level} sur 6)` },
      { value: dominantText, label: dominant.length > 1 ? 'pollens dominants' : 'pollen dominant' },
    ],
    tables: [
      {
        title: `Niveau par pollen · ${dayText}`,
        columns: ['Pollen', 'Niveau'],
        rows: subs.map((s) => ({
          cells: [s.name, s.level === 0 ? 'non évalué' : s.level === NONE ? NONE_NAME : `${LEVELS[s.level]!.name} (${s.level})`],
          tone: dominant.includes(s) ? ('current' as const) : undefined,
        })),
      },
      ...(week.length > 1
        ? [
            {
              title: 'Indice global sur les jours publiés',
              columns: ['Jour', 'Niveau'],
              rows: week.map(({ d, level: l }) => ({ cells: [dayName(d), l === 0 ? 'non évalué' : l === NONE ? NONE_NAME : `${LEVELS[l]!.name} (${l})`], tone: d === data.days[day] ? ('current' as const) : undefined })),
            },
          ]
        : []),
    ],
    note:
      (level === NONE
        ? 'Aucun pollen n’est annoncé : l’indice vaut « très faible » avec une concentration nulle pour chaque taxon (hors saison de ces plantes). '
        : `${LEVELS[level]!.text} `) +
      'L’indice global est le plus élevé des indices des six taxons suivis ; les seuils reposent sur les travaux de l’EAACI. Le noisetier et le cyprès ne sont pas encore suivis.',
    actions: [{ label: 'Indice pollen sur Atmo France', href: 'https://www.atmo-france.org/article/indice-pollen' }],
  };
}
