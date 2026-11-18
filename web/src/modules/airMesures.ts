/**
 * Qualité de l'air, mesures des stations : la partie sans carte ni interface du module `air`
 * (lecture de `/api/air/mesures`, seuils ATMO, valeur d'une station à un instant). Elle s'importe telle
 * quelle dans les tests (`web/scripts/airMesures.test.mjs`).
 *
 * Source : LCSQA / Geod'air, relevée par le serveur (server/src/air_mesures.rs) : la moyenne horaire de
 * chaque polluant à chaque station de métropole, les 24 dernières heures. L'heure close la plus récente
 * a une heure et demie de retard environ ; les heures sont en secondes UTC.
 */

// --- Données du serveur ----------------------------------------------------------------------

export interface ApiMesures {
  updatedAt: number;
  /** Fin de l'heure la plus récente (secondes UTC) : la dernière valeur de chaque série se termine là. */
  end: number;
  orgs: string[];
  stations: {
    code: string[];
    name: string[];
    commune: string[];
    lon: number[];
    lat: number[];
    org: number[];
    /** 0 urbaine, 1 périurbaine, 2 rurale. */
    imp: number[];
    /** 0 fond, 1 trafic, 2 industrielle. */
    infl: number[];
  };
  /** Par polluant : les indices des stations qui le mesurent et leurs 24 heures (µg/m³, `null` : trou). */
  pollutants: Record<string, { i: number[]; v: Array<Array<number | null>> }>;
}

/** Les données prêtes à l'emploi : pour chaque station, la série de chaque polluant (indice du polluant dans `POLLUTANTS`). */
export interface Mesures extends ApiMesures {
  series: Array<Array<ReadonlyArray<number | null> | undefined>>;
  byCode: Map<string, number>;
}

export const HOURS = 24;
/** Au-delà, une mesure est dite ancienne : estompée sur la carte et signalée dans la fiche. */
export const STALE_MS = 3 * 3600_000;

export function prepareMesures(api: ApiMesures): Mesures {
  const series: Mesures['series'] = api.stations.code.map(() => []);
  POLLUTANTS.forEach((pollutant, p) => {
    const column = api.pollutants[pollutant.code];
    column?.i.forEach((station, k) => {
      if (series[station]) series[station]![p] = column.v[k];
    });
  });
  return { ...api, series, byCode: new Map(api.stations.code.map((code, i) => [code, i])) };
}

// --- Polluants et seuils ---------------------------------------------------------------------

/**
 * Seuils de l'indice ATMO (arrêté du 10 juillet 2020 modifié, en vigueur depuis le 1er janvier 2021), en µg/m³ : la borne
 * haute des niveaux 1 (bon) à 5 (très mauvais) ; au-delà, c'est le niveau 6 (extrêmement mauvais).
 * NO2, O3 et SO2 sont comparés au maximum horaire du jour, PM10 et PM2.5 à la moyenne du jour.
 */
export const POLLUTANTS = [
  { code: 'NO2', label: 'NO₂', name: 'Dioxyde d’azote', short: 'dioxyde d’azote', bounds: [40, 90, 120, 230, 340] },
  { code: 'O3', label: 'O₃', name: 'Ozone', short: 'ozone', bounds: [50, 100, 130, 240, 380] },
  { code: 'PM10', label: 'PM10', name: 'Particules PM10', short: 'particules PM10', bounds: [20, 40, 50, 100, 150] },
  { code: 'PM2.5', label: 'PM2.5', name: 'Particules fines PM2.5', short: 'particules fines PM2.5', bounds: [10, 20, 25, 50, 75] },
  { code: 'SO2', label: 'SO₂', name: 'Dioxyde de soufre', short: 'dioxyde de soufre', bounds: [100, 200, 350, 500, 750] },
] as const;

/** Niveau ATMO (1 à 6) d'une concentration, d'après les seuils du polluant (la concentration est arrondie au µg/m³, comme l'indice). */
export function subLevel(pollutant: number, value: number): number {
  const rounded = Math.round(value);
  return 1 + POLLUTANTS[pollutant]!.bounds.filter((bound) => rounded > bound).length;
}

// --- Valeur à un instant ---------------------------------------------------------------------

/** Fin (ms) de la tranche `k` (0 : la plus ancienne). */
export const slotEndMs = (m: Pick<ApiMesures, 'end'>, k: number): number => (m.end - (HOURS - 1 - k) * 3600) * 1000;

/** Dernière tranche dont l'heure est close à l'instant `time` (ms) ; -1 avant la première (il n'y a pas d'historique plus ancien que 24 h). */
export function slotAt(m: Pick<ApiMesures, 'end'>, time: number): number {
  const k = Math.floor((time - slotEndMs(m, 0)) / 3600_000);
  return k < 0 ? -1 : Math.min(HOURS - 1, k);
}

export interface Reading {
  /** Indice dans `POLLUTANTS`. */
  pollutant: number;
  value: number;
  /** Fin de l'heure mesurée (ms). */
  end: number;
  level: number;
}

/** Dernière mesure de la station pour ce polluant à l'instant `time` ; `undefined` s'il n'y en a pas dans les 24 heures. */
export function readingAt(m: Mesures, station: number, pollutant: number, time: number): Reading | undefined {
  const values = m.series[station]?.[pollutant];
  if (!values) return undefined;
  for (let k = slotAt(m, time); k >= 0; k--) {
    const value = values[k];
    if (value !== null && value !== undefined) return { pollutant, value, end: slotEndMs(m, k), level: subLevel(pollutant, value) };
  }
  return undefined;
}

export interface StationState {
  /** Mesures retenues, les plus mauvaises d'abord. */
  readings: Reading[];
  /** La plus mauvaise : elle donne la couleur et le chiffre de la station. */
  main: Reading;
  /** Plus de `STALE_MS` depuis la mesure retenue. */
  stale: boolean;
}

/**
 * Ce que la station dit à l'instant `time`. `only` : un seul polluant (indice dans `POLLUTANTS`), sinon le pire de tous ; une station
 * qui ne mesure pas le polluant choisi n'a pas d'état. Une mesure de plus de 3 h ne compte que si la station n'en a pas de plus fraîche.
 */
export function stationState(m: Mesures, station: number, time: number, only?: number): StationState | undefined {
  const all: Reading[] = [];
  for (let p = 0; p < POLLUTANTS.length; p++) {
    if (only !== undefined && p !== only) continue;
    const reading = readingAt(m, station, p, time);
    if (reading) all.push(reading);
  }
  if (all.length === 0) return undefined;
  const fresh = all.filter((r) => time - r.end <= STALE_MS);
  const readings = (fresh.length > 0 ? fresh : all).sort((a, b) => b.level - a.level || b.value / POLLUTANTS[b.pollutant]!.bounds[0] - a.value / POLLUTANTS[a.pollutant]!.bounds[0]);
  return { readings, main: readings[0]!, stale: fresh.length === 0 };
}

/** « 42 » : le chiffre posé sous le point, en µg/m³ entiers. */
export const valueText = (value: number): string => String(Math.round(value));
