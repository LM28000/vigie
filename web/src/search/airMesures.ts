/**
 * Stations de mesure de la qualité de l'air, par leur nom ou leur commune (« Metz-Centre », « Paris 18e », « Grenoble »), avec
 * « station » pour ne chercher qu'elles. Les mesures viennent du module `air` (LCSQA / Geod'air) : tant qu'elles ne sont pas
 * chargées, il n'y a rien à proposer.
 */
import { clock } from '../core/clock';
import type { AirData } from '../modules/air';
import { POLLUTANTS, stationState, valueText, type Mesures } from '../modules/airMesures';
import { dataOf, openObject, shownBonus } from './access';
import { matchScore, pad, rank, TopK } from './normalize';
import type { Provider, SearchResult } from './types';

const MODULE = 'air';
const MAX_RESULTS = 4;
const LEVEL_WORD = ['', 'bon', 'moyen', 'dégradé', 'mauvais', 'très mauvais', 'extrêmement mauvais'];

/** Certaines associations écrivent les noms en capitales (« MARSEILLE 5 AVENUES ») : une casse lisible. */
const readable = (text: string): string =>
  text === text.toUpperCase() ? text.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_all, before: string, letter: string) => before + letter.toUpperCase()) : text;

const texts = new WeakMap<Mesures, string[]>();
function textsOf(m: Mesures): string[] {
  let found = texts.get(m);
  if (!found) {
    found = m.stations.name.map((name, i) => pad(`station ${name} ${m.stations.commune[i]}`));
    texts.set(m, found);
  }
  return found;
}

export const airMesuresProvider: Provider = {
  warm({ manager }) {
    const m = dataOf<AirData>(manager, MODULE)?.mesures;
    if (m) textsOf(m);
  },

  search(query, ctx) {
    const m = dataOf<AirData>(ctx.manager, MODULE)?.mesures;
    if (!m) return [];
    const bonus = shownBonus(ctx.manager, MODULE);
    const time = clock.now();
    const top = new TopK<number>(MAX_RESULTS);
    const all = textsOf(m);
    for (let i = 0; i < all.length; i++) {
      const match = matchScore(all[i]!, query);
      if (match > 0) top.push(rank(all[i]!, query, match) + bonus, i);
    }
    return top.result().map(({ score, item: i }): SearchResult => {
      const state = stationState(m, i, time);
      const main = state?.main;
      const lon = m.stations.lon[i]!;
      const lat = m.stations.lat[i]!;
      return {
        key: `station-air:${m.stations.code[i]}`,
        kind: 'zone',
        title: readable(m.stations.name[i]!),
        subtitle: `Station de mesure de l’air · ${m.stations.commune[i]}`,
        live: state && main ? `${POLLUTANTS[main.pollutant]!.label} ${valueText(main.value)} µg/m³ · ${state.stale ? 'mesure ancienne' : LEVEL_WORD[main.level]}` : undefined,
        liveTone: state && main && !state.stale && main.level >= 4 ? 'alert' : undefined,
        at: { lon, lat },
        score,
        run: () => openObject(ctx.manager, MODULE, { st: m.stations.code[i]! }, { fallback: { lon, lat }, zoom: 11 }),
      };
    });
  },
};
