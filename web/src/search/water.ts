/**
 * Eau : stations hydrométriques (« Loire », « Orléans »), marégraphes et ports (« Saint-Malo », « marée Brest »)
 * et tronçons de cours d'eau surveillés par Vigicrues (« Loire amont »).
 *
 * Les listes viennent des couches Rivières, Marées et Vigilance crues, une fois chargées.
 */
import { dataOf, indexed, openObject, shownBonus } from './access';
import { matchScore, pad, rank, TopK } from './normalize';
import type { Provider, SearchResult } from './types';

const MAX_RESULTS = 4;

interface RiverStation { id: string; name: string; river?: string; lon: number; lat: number; vig?: number }
interface Gauge { id: number; name: string; lon: number; lat: number; tidal: boolean }
interface FloodData { geojson: { features: Array<{ properties: { id: string }; geometry: { coordinates: unknown } }> }; byId: Map<string, { name: string; level: number }> }
interface FloodEntry { text: string; id: string; name: string; level: number; geometry: { coordinates: unknown } }

const VIGILANCE = ['', '', 'jaune', 'orange', 'rouge'];

const riversIndex = indexed<{ stations: RiverStation[] }, Array<{ text: string; station: RiverStation }>>((data) =>
  data.stations.map((station) => ({ text: pad(`${station.name} ${station.river ?? ''} station hydrometrique riviere cours d eau`), station })),
);
const tidesIndex = indexed<{ gauges: Gauge[] }, Array<{ text: string; gauge: Gauge }>>((data) =>
  data.gauges.map((gauge) => ({ text: pad(`${gauge.name} maree marees maregraphe port niveau de la mer`), gauge })),
);
const floodsIndex = indexed<FloodData, FloodEntry[]>((data) => {
  const out: FloodEntry[] = [];
  for (const feature of data.geojson.features) {
    const info = data.byId.get(String(feature.properties.id));
    if (info) out.push({ text: pad(`${info.name} vigicrues troncon crue cours d eau`), id: String(feature.properties.id), ...info, geometry: feature.geometry });
  }
  return out;
});

/** Milieu d'un tracé GeoJSON (ligne ou multi-ligne) : où centrer la carte sur un tronçon. */
function middleOf(geometry: { coordinates: unknown }): { lon: number; lat: number } | null {
  let part: unknown = geometry.coordinates;
  // Descend jusqu'à une liste de positions [lon, lat].
  while (Array.isArray(part) && Array.isArray(part[0]) && Array.isArray((part[0] as unknown[])[0])) part = (part as unknown[])[Math.floor((part as unknown[]).length / 2)];
  if (!Array.isArray(part) || part.length === 0) return null;
  const point = part[Math.floor(part.length / 2)] as number[];
  return typeof point?.[0] === 'number' && typeof point[1] === 'number' ? { lon: point[0], lat: point[1] } : null;
}

export const waterProvider: Provider = {
  warm({ manager }) {
    const rivers = dataOf<{ stations: RiverStation[] }>(manager, 'rivieres');
    if (rivers) riversIndex(rivers);
    const tides = dataOf<{ gauges: Gauge[] }>(manager, 'marees');
    if (tides) tidesIndex(tides);
    const floods = dataOf<FloodData>(manager, 'vigicrues');
    if (floods) floodsIndex(floods);
  },

  search(query, ctx) {
    if (query.text.length < 3) return [];
    const { manager } = ctx;
    const out: SearchResult[] = [];

    const rivers = dataOf<{ stations: RiverStation[] }>(manager, 'rivieres');
    if (rivers) {
      const bonus = shownBonus(manager, 'rivieres');
      const top = new TopK<RiverStation>(MAX_RESULTS);
      for (const { text, station } of riversIndex(rivers)) {
        const match = matchScore(text, query);
        if (match > 0) top.push(rank(text, query, match) + bonus - 20, station);
      }
      for (const { score, item: s } of top.result()) {
        out.push({
          key: `eau:riviere:${s.id}`,
          kind: 'eau',
          title: s.name,
          subtitle: ['Station de mesure des rivières', s.river].filter(Boolean).join(' · '),
          live: s.vig && s.vig >= 2 ? `vigilance ${VIGILANCE[s.vig]}` : undefined,
          liveTone: s.vig && s.vig >= 3 ? 'alert' : undefined,
          score,
          run: () => openObject(manager, 'rivieres', { id: s.id }, { fallback: s, zoom: 12 }),
        });
      }
    }

    const tides = dataOf<{ gauges: Gauge[] }>(manager, 'marees');
    if (tides) {
      const bonus = shownBonus(manager, 'marees');
      const top = new TopK<Gauge>(MAX_RESULTS);
      for (const { text, gauge } of tidesIndex(tides)) {
        const match = matchScore(text, query);
        if (match > 0) top.push(rank(text, query, match) + bonus - 20, gauge);
      }
      for (const { score, item: g } of top.result()) {
        out.push({
          key: `eau:maree:${g.id}`,
          kind: 'eau',
          title: g.name,
          subtitle: g.tidal ? 'Marée · marégraphe' : 'Niveau d’eau · marégraphe',
          score,
          run: () => openObject(manager, 'marees', { id: g.id }, { fallback: g, zoom: 11 }),
        });
      }
    }

    const floods = dataOf<FloodData>(manager, 'vigicrues');
    if (floods) {
      const bonus = shownBonus(manager, 'vigicrues');
      const top = new TopK<FloodEntry>(MAX_RESULTS);
      for (const entry of floodsIndex(floods)) {
        const match = matchScore(entry.text, query);
        if (match > 0) top.push(rank(entry.text, query, match) + bonus - 25 + entry.level, entry);
      }
      for (const { score, item } of top.result()) {
        const at = middleOf(item.geometry) ?? { lon: 2.4, lat: 46.6 };
        out.push({
          key: `eau:crue:${item.id}`,
          kind: 'eau',
          title: item.name,
          subtitle: 'Tronçon Vigicrues',
          live: item.level >= 2 ? `vigilance ${VIGILANCE[item.level]}` : 'vert',
          liveTone: item.level >= 3 ? 'alert' : undefined,
          score,
          run: () => openObject(manager, 'vigicrues', { id: item.id }, { fallback: at, zoom: 9 }),
        });
      }
    }
    return out;
  },
};
