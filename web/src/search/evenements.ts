/**
 * Événements : par type, titre ou ville (« concert Lyon », « marché de Noël », « exposition Nantes »).
 *
 * Cherche parmi ceux de la période réglée sur la couche (par défaut : le jour de la frise). La liste vient de la couche une fois
 * chargée ; sinon, une requête qui ressemble à une recherche d'événement (concert, expo, marché…) la fait lire en arrière-plan :
 * les résultats arrivent à la frappe suivante.
 */
import { clock } from '../core/clock';
import { CATEGORIES, activeEvents, loadEvents, peekEvents, type EventItem, type EventsData } from '../modules/evenements';
import { formatTime } from '../ui/format';
import { dataOf, indexed, openObject, shownBonus } from './access';
import { matchScore, pad, rank, TopK } from './normalize';
import type { Provider, SearchResult } from './types';

const MODULE = 'evenements';
const MAX_RESULTS = 5;
/** Mots qui disent « je cherche un événement » : ils déclenchent la lecture en arrière-plan. */
const INTENT = /(evenement|concert|spectacle|expo|marche|brocante|festival|fete|sortie|theatre|vide.?grenier|carnaval|balade|visite)/;

interface Entry {
  text: string;
  event: EventItem;
}

const build = indexed<EventsData, Entry[]>((data) =>
  data.list.map((event) => ({ text: pad(`evenement ${CATEGORIES[event.cat]!.words} ${event.title} ${event.commune}`), event })),
);

export const evenementsProvider: Provider = {
  warm({ manager }) {
    const data = dataOf<EventsData>(manager, MODULE);
    if (data) build(data);
  },

  search(query, ctx) {
    const data = dataOf<EventsData>(ctx.manager, MODULE) ?? peekEvents();
    if (!data) {
      if (INTENT.test(query.text)) void loadEvents().catch(() => undefined);
      return [];
    }
    const settings = ctx.manager.getSnapshot()[MODULE]?.settings ?? {};
    // Les événements de la période réglée (par défaut le jour de la frise) : sans cela, « concert » ne trouverait que le passé.
    const active = new Set(activeEvents(data, settings, clock.now()).map((e) => e.id));
    const bonus = shownBonus(ctx.manager, MODULE);
    const top = new TopK<EventItem>(MAX_RESULTS);
    for (const { text, event } of build(data)) {
      if (!active.has(event.id)) continue;
      const match = matchScore(text, query);
      if (match > 0) top.push(rank(text, query, match) + bonus, event);
    }
    return top.result().map(({ score, item: e }): SearchResult => {
      let start = 0;
      for (let i = 0; i < e.spans.length; i += 2) {
        if (e.spans[i + 1]! > ctx.time) {
          start = e.spans[i]!;
          break;
        }
      }
      return {
        key: `evenement:${e.id}`,
        kind: 'evenement',
        title: e.title,
        subtitle: [CATEGORIES[e.cat]!.short, e.commune].filter(Boolean).join(' · '),
        live: start > ctx.time && start - ctx.time < 24 * 3_600_000 ? formatTime(start) : start && start <= ctx.time ? 'en cours' : undefined,
        at: e,
        score,
        run: () => openObject(ctx.manager, MODULE, { id: e.id }, { fallback: e, zoom: 15 }),
      };
    });
  },
};
