/** Massifs de montagne : par nom (« Mont-Blanc », « Vanoise », « Haute-Bigorre »), « avalanche » ou « risque » pour tous. */
import massifsGeo from '../data/massifs_bra.json';
import type { NeigeData } from '../modules/neige';
import { dataOf, openObject, shownBonus } from './access';
import { matchScore, pad, rank, TopK } from './normalize';
import type { Provider, SearchResult } from './types';

const MODULE = 'neige';
const MAX_RESULTS = 5;
const WORD: Record<number, string> = { 1: 'faible', 2: 'limité', 3: 'marqué', 4: 'fort', 5: 'très fort' };

interface Entry {
  id: number;
  name: string;
  mountain: string;
  dep: string;
  lon: number;
  lat: number;
  text: string;
}

const ENTRIES: Entry[] = (massifsGeo as unknown as { features: Array<{ properties: Omit<Entry, 'text' | 'id'> & { code: number } }> }).features.map(({ properties: p }) => ({
  id: p.code,
  name: p.name,
  mountain: p.mountain,
  dep: p.dep,
  lon: p.lon,
  lat: p.lat,
  text: pad(`massif ${p.name} ${p.mountain} ${p.dep} avalanche risque neige bulletin bra bera`),
}));

export const neigeProvider: Provider = {
  search(query, ctx) {
    const data = dataOf<NeigeData>(ctx.manager, MODULE);
    const bonus = shownBonus(ctx.manager, MODULE);
    const now = Date.now();
    const top = new TopK<Entry>(MAX_RESULTS);
    for (const entry of ENTRIES) {
      const match = matchScore(entry.text, query);
      if (match > 0) top.push(rank(entry.text, query, match) + bonus, entry);
    }
    return top.result().map(({ score, item: m }): SearchResult => {
      const bulletin = data?.byMassif.get(m.id)?.b;
      const risk = bulletin && now <= bulletin.validUntil * 1000 + 6 * 3600_000 ? bulletin.risk : 0;
      return {
        key: `massif:${m.id}`,
        kind: 'massif',
        title: m.name,
        subtitle: `Massif · ${m.mountain} · ${m.dep}`,
        live: risk > 0 ? `risque ${risk}/5 ${WORD[risk]}` : undefined,
        liveTone: risk >= 4 ? 'alert' : undefined,
        score,
        run: () => openObject(ctx.manager, MODULE, { id: m.id }, { fallback: m, zoom: 9 }),
      };
    });
  },
};
