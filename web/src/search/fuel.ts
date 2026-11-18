/**
 * Stations-service : par carburant (« e85 », « sp 95 », « gazole »), éventuellement suivi d'un lieu
 * (« e85 lyon », « gazole moins cher près de Rennes », « essence 35 »), ou « station service Rennes ».
 *
 * Les stations sont celles que la couche Carburants a déjà chargées (aucune requête à la frappe) :
 * on garde les moins chères du carburant, autour du lieu cité, sinon autour du centre de la carte.
 * Si la couche n'a jamais été affichée, rien n'est en mémoire : un seul résultat propose de l'afficher.
 * Le flux officiel ne donne pas l'enseigne (Total, Leclerc…) : elle ne se cherche pas.
 */
import { distanceM } from '../core/geo';
import { FUELS, recentPrice, type FuelData, type FuelId, type Station } from '../modules/fuel';
import { dataOf, indexed, mapOf, openObject } from './access';
import { parseFuelQuery } from './fuelQuery';
import { fold, matchScore, pad, type Query } from './normalize';
import type { Provider, SearchResult } from './types';

const MODULE = 'carburants';
const MAX_RESULTS = 5;
/** Rayon autour d'une commune citée, et autour du centre de la carte. */
const AROUND_PLACE_KM = 15;
const AROUND_VIEW_KM = 30;
/** Sous ce zoom, la carte montre un pays ou un continent : « près d'ici » n'a pas de sens. */
const VIEW_MIN_ZOOM = 8;

interface Index {
  entries: Array<{ station: Station; text: string }>;
  /** Centre de chaque commune (nom normalisé), moyenne de ses stations. */
  cities: Map<string, { lon: number; lat: number; n: number }>;
}

const build = indexed<FuelData, Index>((data) => {
  const cities: Index['cities'] = new Map();
  const entries = data.stations.map((station) => {
    const key = fold(station.city);
    const c = cities.get(key);
    if (c) {
      c.lon += station.lon;
      c.lat += station.lat;
      c.n++;
    } else if (key) cities.set(key, { lon: station.lon, lat: station.lat, n: 1 });
    return { station, text: pad(`${station.city} ${station.postcode} ${station.address}`) };
  });
  for (const c of cities.values()) {
    c.lon /= c.n;
    c.lat /= c.n;
  }
  return { entries, cities };
});

const label = (id: FuelId) => FUELS.find((f) => f.id === id)!.short;
const euros = (price: number) => `${price.toFixed(3).replace('.', ',')} €/L`;
const kmText = (m: number) => (m < 10_000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m / 1000)} km`);

/** Le lieu cité, vu par les stations : un centre et un rayon (commune), ou un filtre de texte (code postal, rue). */
type Where = { kind: 'around'; lon: number; lat: number; radiusKm: number } | { kind: 'filter'; test: (text: string, s: Station) => boolean } | { kind: 'none' };

function resolvePlace(place: string, index: Index): Where {
  if (!place) return { kind: 'none' };
  if (/^\d{2,5}$/.test(place)) return { kind: 'filter', test: (_t, s) => s.postcode.startsWith(place) };
  const exact = index.cities.get(place);
  if (exact) return { kind: 'around', lon: exact.lon, lat: exact.lat, radiusKm: AROUND_PLACE_KM };
  if (place.length >= 3) {
    const starting = [...index.cities].filter(([name]) => name.startsWith(`${place} `) || name.startsWith(place));
    // Un seul nom de commune commence ainsi (« rennes » : « Rennes ») : c'est elle. Plusieurs : on filtre par texte.
    if (starting.length === 1) return { kind: 'around', lon: starting[0]![1].lon, lat: starting[0]![1].lat, radiusKm: AROUND_PLACE_KM };
  }
  const query = { text: place, raw: place, tokens: place.split(' ').map((word) => ({ word, whole: ` ${word} `, start: ` ${word}` })), glued: null } satisfies Query;
  return { kind: 'filter', test: (text) => matchScore(text, query) > 0 };
}

export const fuelProvider: Provider = {
  warm({ manager }) {
    const data = dataOf<FuelData>(manager, MODULE);
    if (data) build(data);
  },

  search(query, ctx) {
    const fq = parseFuelQuery(query.raw);
    if (!fq) return [];
    const { manager } = ctx;
    const current = manager.getSnapshot()[MODULE]?.settings.carburant as FuelId | undefined;
    const fuelId = fq.fuel ?? current ?? 'gazole';
    const data = dataOf<FuelData>(manager, MODULE);

    if (!data) {
      // Rien en mémoire : la couche n'a jamais été affichée. Un résultat l'affiche, réglée sur ce carburant.
      return [
        {
          key: `carburant-couche:${fuelId}`,
          kind: 'station',
          title: `Afficher les prix du ${label(fuelId)}`,
          subtitle: 'Charge la couche Carburants : les stations se chercheront ensuite ici',
          score: 400,
          run: () => {
            manager.setVisible(MODULE, true);
            manager.setSetting(MODULE, 'carburant', fuelId);
          },
        },
      ];
    }

    const { entries, cities } = build(data);
    const where = resolvePlace(fq.place, { entries, cities });
    const map = mapOf(manager);
    const viewCenter = !fq.place && map && map.getZoom() >= VIEW_MIN_ZOOM ? map.getCenter() : null;
    const origin: { lon: number; lat: number; radiusKm: number } | null =
      where.kind === 'around' ? where : viewCenter ? { lon: viewCenter.lng, lat: viewCenter.lat, radiusKm: AROUND_VIEW_KM } : null;

    const found: Array<{ station: Station; price: number; distance: number }> = [];
    for (const { station, text } of entries) {
      const price = recentPrice(station, fuelId);
      if (price === undefined) continue;
      let distance = 0;
      if (where.kind === 'filter' && !where.test(text, station)) continue;
      if (origin) {
        distance = distanceM([origin.lon, origin.lat], [station.lon, station.lat]);
        if (distance > origin.radiusKm * 1000) continue;
      }
      found.push({ station, price, distance });
    }
    if (found.length === 0) return [];
    // Les moins chères d'abord ; à prix égal, la plus proche.
    found.sort((a, b) => a.price - b.price || a.distance - b.distance);

    return found.slice(0, MAX_RESULTS).map(({ station, price, distance }, i): SearchResult => ({
      key: `station:${station.id}:${fuelId}`,
      kind: 'station',
      title: station.city || 'Station-service',
      subtitle: [fq.generic ? `${label(fuelId)} (essence)` : label(fuelId), station.address, origin ? kmText(distance) : undefined].filter(Boolean).join(' · '),
      live: euros(price),
      // Le moins cher en tête, puis dans l'ordre : le groupe passe devant les couches quand on a nommé un carburant.
      score: (fq.fuel ? 400 : 330) - i * 2,
      run: () => {
        manager.setSetting(MODULE, 'carburant', fuelId);
        openObject(manager, MODULE, { id: station.id }, { fallback: station, zoom: 15 });
      },
    }));
  },
};
