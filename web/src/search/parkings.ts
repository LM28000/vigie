/** Parkings et parcs relais : par nom ou par ville (« parking Gare Rennes », « parc relais Nantes »). */
import type { ParkingsData, Parking } from '../modules/parkings';
import { dataOf, indexed, openObject, shownBonus } from './access';
import { matchScore, pad, rank, TopK } from './normalize';
import type { Provider, SearchResult } from './types';

const MODULE = 'parkings';
const MAX_RESULTS = 5;

const build = indexed<ParkingsData, Array<{ text: string; parking: Parking }>>((data) =>
  data.parkings.map((parking) => ({ text: pad(`${parking.kind === 'relais' ? 'parc relais p+r' : 'parking'} ${parking.name} ${parking.area}`), parking })),
);

export const parkingsProvider: Provider = {
  warm({ manager }) {
    const data = dataOf<ParkingsData>(manager, MODULE);
    if (data) build(data);
  },

  search(query, ctx) {
    const data = dataOf<ParkingsData>(ctx.manager, MODULE);
    if (!data) return [];
    const bonus = shownBonus(ctx.manager, MODULE);
    const top = new TopK<Parking>(MAX_RESULTS);
    for (const { text, parking } of build(data)) {
      const match = matchScore(text, query);
      // Ouvert avant fermé : on cherche rarement un parking fermé.
      if (match > 0) top.push(rank(text, query, match) + bonus + (parking.status === 'ferme' ? 0 : 3), parking);
    }
    return top.result().map(({ score, item: p }): SearchResult => ({
      key: `parking:${p.id}`,
      kind: 'parking',
      title: p.name,
      subtitle: `${p.kind === 'relais' ? 'Parc relais' : 'Parking'} · ${p.area}`,
      live: p.status === 'ferme' ? 'fermé' : p.status === 'abonnes' ? 'abonnés' : p.status === 'complet' ? 'complet' : `${p.free} place${p.free > 1 ? 's' : ''}`,
      score,
      run: () => openObject(ctx.manager, MODULE, { id: p.id }, { fallback: p, zoom: 16 }),
    }));
  },
};
