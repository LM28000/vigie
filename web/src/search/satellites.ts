/** Satellites : par nom (« ISS », « Hubble », « Starlink »), numéro NORAD ou désignation internationale. */
import { dataOf, indexed, openObject, shownBonus } from './access';
import { matchScore, pad, rank, TopK } from './normalize';
import type { Provider, SearchResult } from './types';

const MODULE = 'satellites';
const MAX_RESULTS = 4;

interface Sat { id: number; name: string; intl: string; group: string }

const build = indexed<{ satellites: Sat[] }, Array<{ text: string; sat: Sat }>>((data) =>
  data.satellites.map((sat) => ({ text: pad(`${sat.name} ${sat.id} ${sat.intl} ${sat.name.startsWith('ISS') ? 'station spatiale internationale' : ''}`), sat })),
);

export const satellitesProvider: Provider = {
  warm({ manager }) {
    const data = dataOf<{ satellites: Sat[] }>(manager, MODULE);
    if (data) build(data);
  },

  search(query, ctx) {
    const data = dataOf<{ satellites: Sat[] }>(ctx.manager, MODULE);
    if (!data || query.text.length < 3) return [];
    const bonus = shownBonus(ctx.manager, MODULE);
    const top = new TopK<Sat>(MAX_RESULTS);
    for (const { text, sat } of build(data)) {
      const match = matchScore(text, query);
      if (match > 0) top.push(rank(text, query, match) + bonus - 10, sat);
    }
    return top.result().map(({ score, item: sat }): SearchResult => ({
      key: `satellite:${sat.id}`,
      kind: 'espace',
      title: sat.name,
      subtitle: `Satellite · NORAD ${sat.id}`,
      score,
      // La couche sait où est le satellite à l'instant affiché (`focus`) ; sinon la vue reste sur la France.
      run: () => openObject(ctx.manager, MODULE, { id: sat.id }, { fallback: { lon: 2.4, lat: 46.6 }, zoom: 3 }),
    }));
  },
};
