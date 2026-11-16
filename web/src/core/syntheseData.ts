/**
 * Chargement de la synthèse « Aujourd'hui en France » : `/api/synthese` (le serveur résume ce qu'il a déjà en mémoire) et,
 * pour les séismes, l'EMSC, que le site interroge de toute façon depuis son navigateur (la couche des séismes aussi).
 * Quand la couche des séismes est chargée, on lit ses données au lieu de redemander : aucune requête de plus.
 */
import type { ModuleManager } from './moduleManager';
import type { ApiSynthese, SynthesisQuake } from './syntheseModel';

const EMSC_URL = 'https://www.seismicportal.eu/fdsnws/event/1/query';
/** Rectangle autour de la France métropolitaine et de la Corse (comme la couche des séismes). */
const FRANCE_AREA = { minlat: '40', maxlat: '53', minlon: '-8', maxlon: '12' };
const QUAKE_DAYS = 4;
/** Les séismes ne se renouvellent pas à la minute : on les relit toutes les 5 minutes au plus. */
const QUAKE_TTL_MS = 5 * 60_000;

export async function fetchSynthese(signal: AbortSignal): Promise<ApiSynthese> {
  const response = await fetch('/api/synthese', { signal });
  if (!response.ok) throw new Error(`le serveur a répondu ${response.status}`);
  return (await response.json()) as ApiSynthese;
}

let quakeCache: { at: number; quakes: SynthesisQuake[] } | undefined;

interface EmscFeature {
  properties: { unid: string; lon: number; lat: number; depth: number; mag: number; time: string; flynn_region: string };
}

/** Les séismes de magnitude 2,5 ou plus des derniers jours autour de la France. `null` si l'EMSC ne répond pas (rubrique « indisponible »). */
export async function fetchQuakes(manager: ModuleManager, signal: AbortSignal): Promise<SynthesisQuake[] | null> {
  // La couche garde aussi les plus forts séismes du monde : on ne retient que ceux de la zone.
  const loaded = manager.getData<SynthesisQuake[]>('seismes');
  if (loaded) return loaded.filter((q) => q.lat >= 40 && q.lat <= 53 && q.lon >= -8 && q.lon <= 12);
  if (quakeCache && Date.now() - quakeCache.at < QUAKE_TTL_MS) return quakeCache.quakes;
  try {
    const start = new Date(Date.now() - QUAKE_DAYS * 86_400_000).toISOString().slice(0, 19);
    const query = new URLSearchParams({ format: 'json', orderby: 'time', start, minmag: '2.5', limit: '200', ...FRANCE_AREA });
    const response = await fetch(`${EMSC_URL}?${query}`, { signal });
    let quakes: SynthesisQuake[] = [];
    if (response.status !== 204) {
      if (!response.ok) return quakeCache?.quakes ?? null;
      const json = (await response.json()) as { features: EmscFeature[] };
      quakes = json.features.map(({ properties: p }) => ({
        id: p.unid,
        lon: p.lon,
        lat: p.lat,
        depthKm: p.depth,
        mag: p.mag,
        time: Date.parse(p.time),
        region: p.flynn_region,
      }));
    }
    quakeCache = { at: Date.now(), quakes };
    return quakes;
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    return quakeCache?.quakes ?? null;
  }
}
