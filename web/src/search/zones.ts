/**
 * Communes et départements « avec un mot-clé » : « air Lyon » (qualité de l'air d'une commune), « vigilance Gironde »,
 * « séisme Pyrénées ».
 *
 * Le mot-clé est obligatoire : sans lui, « Lyon » proposerait 15 000 fiches de qualité de l'air derrière chaque
 * nom de commune. Sans mot de lieu après le mot-clé, la couche elle-même est proposée par `layers.ts`
 * (et « séisme » seul donne les derniers séismes).
 */
import departements from '../data/departements.json';
import { formatDateTime } from '../ui/format';
import { dataOf, indexed, openObject, shownBonus } from './access';
import { matchScore, pad, parseQuery, rank, TextIndex, TopK, type Query } from './normalize';
import type { Provider, SearchResult } from './types';

const MAX_RESULTS = 4;

const AIR_WORDS = /\b(?:qualite de l air|qualite air|qualite|air|pollution|pollue|atmo|ozone|smog|particules)\b/g;
const ALERT_WORDS = /\b(?:vigilance meteo|vigilance|alerte meteo|alerte|meteo|orages?|canicule|tempete)\b/g;
const QUAKE_WORDS = /\b(?:tremblements? de terre|seismes?|tremblements?|secousses?)\b/g;
const LINKS = /\b(?:de|du|des|la|le|les|a|au|en|dans|sur|pour|d|l|recent|recents|derniers|dernier)\b/g;

/** Retire le mot-clé de la requête ; `null` si elle n'en contient pas, sinon ce qui reste (le lieu). */
function without(query: Query, words: RegExp): Query | null {
  if (!query.text.match(words)) return null;
  return parseQuery(query.text.replace(words, ' ').replace(LINKS, ' ').replace(/\s+/g, ' ').trim());
}

// --- Qualité de l'air, par commune ---

interface AirZones { zones: { name: string[]; lon: number[]; lat: number[]; epci: number[] } }

const airIndex = indexed<AirZones, TextIndex>((data) => new TextIndex(data.zones.name.map((name) => pad(name))));

/** Atmo écrit ses communes en capitales : « GRAND-FORT-PHILIPPE » devient « Grand-Fort-Philippe ». */
function titleCase(text: string): string {
  return text.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_all, before: string, letter: string) => before + letter.toUpperCase());
}

// --- Vigilance, par département ---

const DEPARTMENTS = (departements as unknown as { features: Array<{ properties: { code: string; nom: string }; geometry: { coordinates: unknown } }> }).features.map((f) => ({
  code: f.properties.code,
  name: f.properties.nom,
  text: pad(`${f.properties.nom} ${f.properties.code}`),
  // Un point du contour, faute de mieux : la carte est recentrée sur la couche, qui sait où est le département.
  geometry: f.geometry,
}));

function firstPoint(coordinates: unknown): { lon: number; lat: number } {
  let part: unknown = coordinates;
  while (Array.isArray(part) && Array.isArray(part[0])) part = part[0];
  const p = part as number[];
  return { lon: p[0] ?? 2.4, lat: p[1] ?? 46.6 };
}

// --- Séismes ---

interface Quake { id: string; lon: number; lat: number; mag: number; time: number; region: string }

const quakeText = new WeakMap<Quake, string>();
const textOfQuake = (q: Quake): string => {
  let t = quakeText.get(q);
  if (!t) quakeText.set(q, (t = pad(q.region)));
  return t;
};

/** Les régions de l'EMSC sont en anglais et en capitales (« PYRENEES », « SOUTHERN ITALY ») : une casse plus lisible. */
const regionName = (region: string) => titleCase(region);

export const zonesProvider: Provider = {
  warm({ manager }) {
    const air = dataOf<AirZones>(manager, 'air');
    if (air) airIndex(air);
  },

  search(query, ctx) {
    const { manager } = ctx;
    const out: SearchResult[] = [];

    const air = without(query, AIR_WORDS);
    const airData = air && air.text.length >= 3 ? dataOf<AirZones>(manager, 'air') : undefined;
    if (air && airData) {
      const index = airIndex(airData);
      const top = new TopK<number>(MAX_RESULTS);
      const bonus = shownBonus(manager, 'air');
      for (const i of index.candidates(air)) {
        const text = index.texts[i]!;
        const match = matchScore(text, air);
        if (match > 0) top.push(rank(text, air, match) + bonus + (airData.zones.epci[i] ? 0 : 5), i);
      }
      for (const { score, item: i } of top.result()) {
        out.push({
          key: `air:${i}`,
          kind: 'zone',
          title: titleCase(airData.zones.name[i]!),
          subtitle: `Qualité de l’air · ${airData.zones.epci[i] ? 'intercommunalité' : 'commune'}`,
          score: score + 60, // un mot-clé a été tapé : c'est bien cela qu'on cherche
          run: () => openObject(manager, 'air', { i }, { fallback: { lon: airData.zones.lon[i]!, lat: airData.zones.lat[i]! }, zoom: 10 }),
        });
      }
    }

    const alert = without(query, ALERT_WORDS);
    if (alert && alert.text.length >= 2) {
      const top = new TopK<(typeof DEPARTMENTS)[number]>(MAX_RESULTS);
      for (const d of DEPARTMENTS) {
        const match = matchScore(d.text, alert, true);
        if (match > 0) top.push(rank(d.text, alert, match), d);
      }
      for (const { score, item: d } of top.result()) {
        out.push({
          key: `vigilance:${d.code}`,
          kind: 'zone',
          title: `Vigilance météo · ${d.name}`,
          subtitle: `Département ${d.code}`,
          score: score + 60,
          run: () => openObject(manager, 'vigilance-meteo', { code: d.code }, { fallback: firstPoint(d.geometry.coordinates), zoom: 7 }),
        });
      }
    }

    const quake = without(query, QUAKE_WORDS);
    const quakes = quake ? dataOf<Quake[]>(manager, 'seismes') : undefined;
    if (quake && quakes) {
      const top = new TopK<Quake>(MAX_RESULTS);
      const hasPlace = quake.text.length >= 2;
      for (const q of quakes) {
        const text = textOfQuake(q);
        // Sans lieu : les plus récents ; avec un lieu : ceux de la région (les plus forts d'abord, à correspondance égale).
        if (!hasPlace) top.push(q.time / 1e9, q);
        else {
          const match = matchScore(text, quake);
          if (match > 0) top.push(rank(text, quake, match) + q.mag + q.time / 1e11, q);
        }
      }
      for (const [rankIndex, { score, item: q }] of top.result().entries()) {
        out.push({
          key: `seisme:${q.id}`,
          kind: 'zone',
          title: `Séisme · ${regionName(q.region)}`,
          subtitle: formatDateTime(q.time),
          live: `M ${q.mag.toFixed(1).replace('.', ',')}`,
          score: hasPlace ? score + 40 : 330 - rankIndex * 2,
          run: () => openObject(manager, 'seismes', { id: q.id }, { fallback: q, zoom: 7 }),
        });
      }
    }
    return out;
  },
};
