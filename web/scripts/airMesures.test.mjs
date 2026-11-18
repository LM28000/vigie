// Tests des mesures de la qualité de l'air : seuils ATMO et valeur d'une station à un instant (modules/airMesures.ts).
// Lancer : node --test web/scripts/airMesures.test.mjs   (Node 22.18 ou plus : les .ts s'importent tels quels)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STALE_MS, prepareMesures, readingAt, slotAt, slotEndMs, stationState, subLevel } from '../src/modules/airMesures.ts';

const NO2 = 0;
const O3 = 1;
const PM10 = 2;
const PM25 = 3;
const SO2 = 4;

test('les seuils ATMO 2021 : la borne haute appartient au niveau du dessous', () => {
  // NO2 : 40, 90, 120, 230, 340.
  assert.deepEqual([0, 40, 41, 90, 91, 120, 121, 230, 231, 340, 341, 900].map((v) => subLevel(NO2, v)), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
  // O3 : 50, 100, 130, 240, 380.
  assert.deepEqual([50, 51, 100, 130, 131, 240, 241, 380, 381].map((v) => subLevel(O3, v)), [1, 2, 2, 3, 4, 4, 5, 5, 6]);
  // PM10 : 20, 40, 50, 100, 150 ; PM2.5 : 10, 20, 25, 50, 75 ; SO2 : 100, 200, 350, 500, 750.
  assert.deepEqual([20, 21, 40, 41, 50, 51, 100, 101, 150, 151].map((v) => subLevel(PM10, v)), [1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
  assert.deepEqual([10, 11, 20, 21, 25, 26, 50, 51, 75, 76].map((v) => subLevel(PM25, v)), [1, 2, 2, 3, 3, 4, 4, 5, 5, 6]);
  assert.deepEqual([100, 101, 750, 751].map((v) => subLevel(SO2, v)), [1, 2, 5, 6]);
});

test('la concentration est arrondie au µg/m³ comme l’indice : 40,4 reste « bon », 40,6 est « moyen »', () => {
  assert.equal(subLevel(NO2, 40.4), 1);
  assert.equal(subLevel(NO2, 40.6), 2);
  assert.equal(subLevel(PM25, 0), 1);
});

// 24 heures qui se terminent à 16:00 UTC ; la tranche 23 est l'heure close à 16:00, la tranche 22 celle de 15:00.
const END = Date.UTC(2026, 10, 18, 16) / 1000;
const hours = (last) => Array.from({ length: 24 }, (_, k) => last[k - (24 - last.length)] ?? null);

const mesures = () =>
  prepareMesures({
    updatedAt: END + 5400,
    end: END,
    orgs: ['ATMO GRAND EST'],
    stations: { code: ['A', 'B', 'C'], name: ['Alpha', 'Bravo', 'Charlie'], commune: ['X', 'Y', 'Z'], lon: [1, 2, 3], lat: [45, 46, 47], org: [0, 0, 0], imp: [0, 1, 2], infl: [0, 1, 2] },
    pollutants: {
      // A : NO2 dégradé (100), O3 bon (30) ; B : seulement PM10, dernière valeur à 13:00 ; C : O3 avec un trou à l'heure close.
      NO2: { i: [0], v: [hours([20, 60, 100])] },
      O3: { i: [0, 2], v: [hours([30, 31, 32]), hours([140, 150, null])] },
      PM10: { i: [1], v: [hours([10, 11, 12, null, null, null])] },
    },
  });

test('les tranches : la dernière se termine à `end`, une heure avant elle la précédente', () => {
  const m = mesures();
  assert.equal(slotEndMs(m, 23), END * 1000);
  assert.equal(slotEndMs(m, 22), (END - 3600) * 1000);
  assert.equal(slotEndMs(m, 0), (END - 23 * 3600) * 1000);
  assert.equal(slotAt(m, END * 1000 + 90 * 60_000), 23);
  assert.equal(slotAt(m, (END - 3600) * 1000 + 1), 22);
  assert.equal(slotAt(m, slotEndMs(m, 0) - 1), -1, 'avant la première heure : pas d’historique');
});

test('la dernière valeur d’une station à un instant, avec son heure et son niveau', () => {
  const m = mesures();
  const now = END * 1000 + 90 * 60_000;
  assert.deepEqual(readingAt(m, 0, NO2, now), { pollutant: NO2, value: 100, end: END * 1000, level: 3 });
  // Trou à l'heure close : on remonte à la valeur précédente (150 µg/m³ d'ozone : niveau 4).
  assert.deepEqual(readingAt(m, 2, O3, now), { pollutant: O3, value: 150, end: (END - 3600) * 1000, level: 4 });
  assert.equal(readingAt(m, 1, O3, now), undefined, 'cette station ne mesure pas l’ozone');
  // Une heure plus tôt (rejeu) : la valeur de cette heure-là, pas celle du futur.
  assert.equal(readingAt(m, 0, NO2, (END - 3600) * 1000)?.value, 60);
});

test('la station prend la couleur de son pire polluant, le chiffre de celui-ci', () => {
  const m = mesures();
  const now = END * 1000 + 90 * 60_000;
  const a = stationState(m, 0, now);
  assert.equal(a.main.pollutant, NO2);
  assert.equal(a.main.level, 3);
  assert.deepEqual(a.readings.map((r) => r.pollutant), [NO2, O3]);
  assert.equal(a.stale, false);
  // Un polluant choisi : seul celui-là compte.
  assert.equal(stationState(m, 0, now, O3).main.level, 1);
  // Une station qui ne mesure pas le polluant choisi n'a pas d'état (elle disparaît de la carte).
  assert.equal(stationState(m, 1, now, NO2), undefined);
});

test('une mesure de plus de 3 h est ancienne, et estompée seulement si rien de plus frais', () => {
  const m = mesures();
  // B : dernière valeur à 13:00 (tranche 20), 1 h 30 après l'heure close de 16:00 : 4 h 30 d'âge.
  const late = END * 1000 + 90 * 60_000;
  const b = stationState(m, 1, late);
  assert.equal(b.stale, true);
  assert.equal(b.main.end, (END - 3 * 3600) * 1000);
  assert.ok(late - b.main.end > STALE_MS);
  // À 15:30, la même valeur n'a que 2 h 30 : pas ancienne.
  assert.equal(stationState(m, 1, (END - 3600) * 1000 + 1800_000).stale, false);
  // Une station dont un polluant est frais et un autre ancien ne garde que le frais pour sa couleur.
  const mixed = prepareMesures({
    ...m,
    pollutants: { NO2: { i: [0], v: [hours([20])] }, O3: { i: [0], v: [hours([300, null, null, null, null, null, null, null])] } },
  });
  const state = stationState(mixed, 0, late);
  assert.deepEqual(state.readings.map((r) => r.pollutant), [NO2]);
  assert.equal(state.stale, false);
});
