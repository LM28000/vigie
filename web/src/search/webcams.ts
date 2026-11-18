/**
 * Webcams : par nom ou par lieu (« webcam Chamonix », « caméra Perrache »).
 *
 * Les listes viennent du module Caméras (Windy, Criter, webcams ouvertes) : elles se cherchent une fois la couche
 * chargée, comme les gares ou les bornes. Les 77 000 caméras de vidéoprotection d'OpenStreetMap n'y sont pas : elles
 * n'ont pas de nom.
 */
import type { CamerasData } from '../modules/cameras';
import { dataOf, indexed, openObject, shownBonus } from './access';
import { matchScore, pad, rank, TopK } from './normalize';
import type { Provider, SearchResult } from './types';

const MODULE = 'cameras';
const MAX_RESULTS = 5;

interface Entry {
  text: string;
  key: string;
  title: string;
  subtitle: string;
  lon: number;
  lat: number;
  select: { family: 'windy' | 'criter' | 'open'; id: number };
}

const build = indexed<CamerasData, Entry[]>((data) => {
  const entries: Entry[] = [];
  for (const w of data.windy?.active ? data.windy.list : []) {
    entries.push({
      text: pad(`webcam webcams camera ${w.title} ${w.city}`),
      key: `windy:${w.id}`,
      title: w.title,
      subtitle: ['Webcam Windy', w.city].filter(Boolean).join(' · '),
      lon: w.lon,
      lat: w.lat,
      select: { family: 'windy', id: w.id },
    });
  }
  for (const c of data.criter?.list ?? []) {
    entries.push({
      text: pad(`webcam webcams camera cameras trafic criter lyon ${c.name} ${c.place}`),
      key: `criter:${c.id}`,
      title: c.name,
      subtitle: ['Caméra de trafic Criter', c.place].filter(Boolean).join(' · '),
      lon: c.lon,
      lat: c.lat,
      select: { family: 'criter', id: c.id },
    });
  }
  for (const o of data.open?.list ?? []) {
    entries.push({
      text: pad(`webcam webcams camera ${o.name} ${o.town} ${o.source}`),
      key: `ouverte:${o.id}`,
      title: o.name,
      subtitle: ['Webcam', o.town].filter(Boolean).join(' · '),
      lon: o.lon,
      lat: o.lat,
      select: { family: 'open', id: o.id },
    });
  }
  return entries;
});

export const webcamsProvider: Provider = {
  warm({ manager }) {
    const data = dataOf<CamerasData>(manager, MODULE);
    if (data) build(data);
  },

  search(query, ctx) {
    const data = dataOf<CamerasData>(ctx.manager, MODULE);
    // Le seul mot « webcam » ne désigne rien : il faut un nom ou un lieu avec.
    if (!data || query.text.length < 3 || /^(web ?)?cam(era|eras|s)?$/.test(query.text)) return [];
    const bonus = shownBonus(ctx.manager, MODULE);
    const top = new TopK<Entry>(MAX_RESULTS);
    for (const entry of build(data)) {
      const match = matchScore(entry.text, query);
      if (match > 0) top.push(rank(entry.text, query, match) + bonus, entry);
    }
    return top.result().map(({ score, item: entry }): SearchResult => ({
      key: `webcam:${entry.key}`,
      kind: 'webcam',
      title: entry.title,
      subtitle: entry.subtitle,
      at: entry,
      score,
      run: () => openObject(ctx.manager, MODULE, entry.select, { fallback: entry, zoom: 14 }),
    }));
  },
};
