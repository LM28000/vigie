/**
 * Massifs de montagne : par nom (« Mont-Blanc », « Vanoise », « Haute-Bigorre »), « avalanche » ou « risque » pour tous ; et stations de
 * mesure de la neige par leur nom (« Écrins », « Bellecôte », « nivôse »), « neige » ne montrant que celles qui ont de la neige au sol.
 */
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
    const stations = new TopK<NeigeData['stations'][number]>(MAX_RESULTS);
    for (const st of data?.stations ?? []) {
      const text = pad(`station ${st.name} ${st.alt ?? ''} m ${st.cm > 0 ? 'neige enneigement' : ''} nivose`);
      const match = matchScore(text, query);
      if (match > 0) stations.push(rank(text, query, match) + bonus + Math.min(st.cm, 200) / 20, st);
    }
    const found = stations.result().map(({ score, item: st }): SearchResult => {
      const old = now - st.t * 1000 > 6 * 3600_000;
      return {
        key: `station-neige:${st.id}`,
        kind: 'massif',
        title: st.name,
        subtitle: `Station de neige${st.alt !== undefined ? ` · ${st.alt} m` : ''}`,
        live: st.cm > 0 ? `${st.cm} cm de neige${old ? ' (ancien)' : ''}` : 'pas de neige',
        at: st,
        score,
        run: () => openObject(ctx.manager, MODULE, { st: st.id }, { fallback: st, zoom: 11 }),
      };
    });
    const massifs = top.result().map(({ score, item: m }): SearchResult => {
      const bulletin = data?.byMassif.get(m.id)?.b;
      const risk = bulletin && now <= bulletin.validUntil * 1000 + 6 * 3600_000 ? bulletin.risk : 0;
      return {
        key: `massif:${m.id}`,
        kind: 'massif',
        title: m.name,
        subtitle: `Massif · ${m.mountain} · ${m.dep}`,
        live: risk > 0 ? `risque ${risk}/5 ${WORD[risk]}` : undefined,
        liveTone: risk >= 4 ? 'alert' : undefined,
        at: m,
        score,
        run: () => openObject(ctx.manager, MODULE, { id: m.id }, { fallback: m, zoom: 9 }),
      };
    });
    return [...massifs, ...found];
  },
};
