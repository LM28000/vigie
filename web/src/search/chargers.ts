/**
 * Bornes de recharge : par nom, opérateur ou adresse.
 *
 * 53 000 stations : leurs textes sont repliés une fois par chargement et cherchés d'un
 * bloc (voir `TextIndex`), ce qui tient la recherche à quelques millisecondes.
 */
import type { ChargersData, Station } from '../modules/chargers';
import { dataOf, indexed, openObject, shownBonus } from './access';
import { matchScore, pad, parseQuery, rank, TextIndex, TopK } from './normalize';
import type { Provider, SearchResult } from './types';

const MODULE = 'bornes';
const MAX_RESULTS = 5;
/** Mots qui disent « borne » sans la nommer : « borne ionity » se cherche comme « ionity ». */
const GENERIC = new Set(['borne', 'bornes', 'recharge', 'electrique', 'electriques']);

const build = indexed<ChargersData, { index: TextIndex; stations: Station[] }>((data) => ({
  index: new TextIndex(data.stations.map((s) => pad(`${s.name} ${s.operator} ${s.address}`))),
  stations: data.stations,
}));

export const chargersProvider: Provider = {
  warm({ manager }) {
    const data = dataOf<ChargersData>(manager, MODULE);
    if (data) build(data);
  },

  search(query, ctx) {
    const data = dataOf<ChargersData>(ctx.manager, MODULE);
    if (!data) return [];
    const words = query.tokens.map((t) => t.word).filter((word) => !GENERIC.has(word));
    // Ces mots seuls désignent les 53 000 stations : rien à proposer.
    if (words.length === 0) return [];
    if (words.length < query.tokens.length) return this.search(parseQuery(words.join(' ')), ctx);
    // Deux lettres suffisent à en trouver des milliers : on attend la troisième.
    if (query.text.length < 3) return [];
    const bonus = shownBonus(ctx.manager, MODULE);
    const { index, stations } = build(data);
    const top = new TopK<Station>(MAX_RESULTS);
    for (const i of index.candidates(query)) {
      const text = index.texts[i]!;
      const match = matchScore(text, query);
      if (match > 0) top.push(rank(text, query, match) + bonus, stations[i]!);
    }
    // Une même station figure parfois deux fois dans les données ouvertes : on ne l'affiche qu'une fois.
    const seen = new Set<string>();
    return top
      .result()
      .filter(({ item }) => {
        const identity = `${item.name}|${item.address}|${item.operator}`;
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      })
      .map(({ score, item: station }): SearchResult => ({
        key: `borne:${station.id}`,
        kind: 'borne',
        title: station.name || 'Station de recharge',
        subtitle: [station.operator, station.address].filter(Boolean).join(' · ') || undefined,
        live: station.kw > 0 ? `${Math.round(station.kw)} kW` : undefined,
        score,
        run: () => openObject(ctx.manager, MODULE, { id: station.id }, { fallback: station, zoom: 16 }),
      }));
  },
};
