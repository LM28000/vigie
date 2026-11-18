/** Actualité locale : par commune (« Laval ») ou par mot d'un titre (« incendie », « tempête »). Rien n'est cherché si la couche n'a jamais été chargée. */
import type { ActualiteData, Headline, NewsPlace } from '../modules/actualite';
import { formatRelative } from '../ui/format';
import { dataOf, indexed, openObject, shownBonus } from './access';
import { matchScore, pad, rank, TopK } from './normalize';
import type { Provider, SearchResult } from './types';

const MODULE = 'actualite';
const MAX_PLACES = 3;
const MAX_TITLES = 3;
/** On ne remonte que les titres d'une journée : plus vieux, ils n'ont plus rien d'« actualité ». */
const RECENT_MS = 24 * 3600_000;

interface Index {
  places: Array<{ text: string; place: NewsPlace }>;
  titles: Array<{ text: string; place: NewsPlace; headline: Headline }>;
}

const build = indexed<ActualiteData, Index>((data) => ({
  places: data.places.map((place) => ({ text: pad(`${place.name} actualite ${place.dept}`), place })),
  titles: data.places.flatMap((place) => place.headlines.slice(0, 20).map((headline) => ({ text: pad(headline.title), place, headline }))),
}));

export const actualiteProvider: Provider = {
  warm({ manager }) {
    const data = dataOf<ActualiteData>(manager, MODULE);
    if (data) build(data);
  },

  search(query, ctx) {
    const data = dataOf<ActualiteData>(ctx.manager, MODULE);
    if (!data) return [];
    const bonus = shownBonus(ctx.manager, MODULE);
    const now = ctx.time;
    const recent = (h: Headline) => h.t <= now && now - h.t < RECENT_MS;
    const open = (place: NewsPlace) => () => openObject(ctx.manager, MODULE, { place: place.id }, { fallback: place, zoom: place.isDept ? 8 : 12 });
    const out: SearchResult[] = [];

    const places = new TopK<NewsPlace>(MAX_PLACES);
    for (const { text, place } of build(data).places) {
      const match = matchScore(text, query);
      if (match > 0 && place.headlines.some(recent)) places.push(rank(text, query, match) + bonus + Math.min(8, place.headlines.length), place);
    }
    for (const { score, item: place } of places.result()) {
      const count = place.headlines.filter(recent).length;
      out.push({
        key: `actualite:${place.id}`,
        kind: 'actualite',
        title: place.name,
        subtitle: place.isDept ? 'Actualité · département' : `Actualité locale · département ${place.dept}`,
        live: `${count} titre${count > 1 ? 's' : ''}`,
        score,
        run: open(place),
      });
    }

    // Un mot d'un titre : peu de résultats, pour ne pas noyer les lieux et les couches.
    const titles = new TopK<{ place: NewsPlace; headline: Headline }>(MAX_TITLES);
    if (query.text.length >= 4) {
      for (const { text, place, headline } of build(data).titles) {
        if (!recent(headline)) continue;
        const match = matchScore(text, query);
        if (match > 0) titles.push(rank(text, query, match) + bonus - 12 - (now - headline.t) / 3_600_000, { place, headline });
      }
    }
    for (const { score, item } of titles.result()) {
      out.push({
        key: `actualite-titre:${item.headline.url}`,
        kind: 'actualite',
        title: item.headline.title,
        subtitle: `${item.place.name} · ${item.headline.group} · ${formatRelative(item.headline.t, now)}`,
        score,
        run: open(item.place),
      });
    }
    return out;
  },
};
