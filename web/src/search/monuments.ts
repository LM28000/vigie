/** Monuments historiques : par nom, commune ou type (« cathédrale Chartres », « château Chambord », « pont Avignon »). */
import type { Monument, MonumentsData } from '../modules/monuments';
import { dataOf, indexed, openObject, shownBonus } from './access';
import { matchScore, pad, rank, TextIndex, TopK } from './normalize';
import type { Provider, SearchResult } from './types';

const MODULE = 'monuments';
const MAX_RESULTS = 5;

const build = indexed<MonumentsData, { index: TextIndex; list: Monument[] }>((data) => ({
  index: new TextIndex(data.list.map((m) => pad(`${m.name} ${m.commune} ${m.denomination}`))),
  list: data.list,
}));

export const monumentsProvider: Provider = {
  warm({ manager }) {
    const data = dataOf<MonumentsData>(manager, MODULE);
    if (data) build(data);
  },

  search(query, ctx) {
    const data = dataOf<MonumentsData>(ctx.manager, MODULE);
    // Trois lettres : sinon presque toute la liste correspond.
    if (!data || query.text.length < 3) return [];
    const bonus = shownBonus(ctx.manager, MODULE);
    const { index, list } = build(data);
    const top = new TopK<Monument>(MAX_RESULTS);
    for (const i of index.candidates(query)) {
      const text = index.texts[i]!;
      const match = matchScore(text, query);
      const m = list[i]!;
      // Un monument classé est plus souvent celui qu'on cherche qu'un inscrit homonyme.
      if (match > 0) top.push(rank(text, query, match) + bonus + (m.prot === 1 || m.prot === 3 ? 4 : 0) - 10, m);
    }
    return top.result().map(({ score, item: m }): SearchResult => ({
      key: `monument:${m.ref}`,
      kind: 'monument',
      title: m.name || m.denomination || 'Monument',
      subtitle: [m.denomination && m.denomination !== m.name ? m.denomination : undefined, m.commune].filter(Boolean).join(' · '),
      live: m.prot === 1 || m.prot === 3 ? 'classé' : 'inscrit',
      at: m,
      score,
      run: () => openObject(ctx.manager, MODULE, { ref: m.ref }, { fallback: m, zoom: 16 }),
    }));
  },
};
