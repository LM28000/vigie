// Tests de la position de la personne : arrondi, bonus de proximité, sélection autour d'un point, zone de Veille (core/positionLogic.ts).
// Lancer : node --test web/scripts/position.test.mjs   (Node 22.18 ou plus : les .ts s'importent tels quels)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { distanceM } from '../src/core/geo.ts';
import {
  PROXIMITY_MAX_BONUS,
  addProximity,
  POSITION_MAX_AGE_MS,
  WATCH_RADII_KM,
  accuracyText,
  aroundMeRef,
  distanceText,
  geolocationMessage,
  isFresh,
  proximityBonus,
  roundPosition,
  within,
} from '../src/core/positionLogic.ts';
import { decodeRef, encodeRef, zoneIdOf } from '../src/core/veilleLogic.ts';

const LYON = [4.8357, 45.764];

test('l’arrondi à ~1 km : deux décimales, jamais plus de 0,8 km d’écart, jamais -0', () => {
  assert.deepEqual(roundPosition(4.83574, 45.76399), [4.84, 45.76]);
  assert.deepEqual(roundPosition(-0.004, 0.004), [0, 0]);
  assert.ok(!Object.is(roundPosition(-0.004, 0.004)[0], -0));
  for (const [lon, lat] of [[4.8357, 45.764], [2.3522, 48.8566], [-1.5536, 47.2184], [9.4501, 42.9999]]) {
    const [rlon, rlat] = roundPosition(lon, lat);
    assert.ok(distanceM([lon, lat], [rlon, rlat]) < 800, `${lon},${lat}`);
  }
});

test('le bonus de proximité : borné, décroissant, nul au loin, jamais négatif', () => {
  assert.equal(proximityBonus(0), PROXIMITY_MAX_BONUS);
  let previous = Infinity;
  for (const m of [0, 500, 2_000, 10_000, 40_000, 90_000, 149_000]) {
    const bonus = proximityBonus(m);
    assert.ok(bonus <= previous && bonus > 0 && bonus <= PROXIMITY_MAX_BONUS, `${m} m : ${bonus}`);
    previous = bonus;
  }
  assert.equal(proximityBonus(10_000), 15);
  assert.equal(proximityBonus(151_000), 0);
  assert.equal(proximityBonus(Infinity), 0);
  assert.equal(proximityBonus(NaN), 0);
  assert.equal(proximityBonus(-5), 0);
});

test('à correspondance égale, le résultat proche passe devant ; un début de mot (+60) ne se fait pas battre par la seule proximité', () => {
  const near = 300 + proximityBonus(distanceM(LYON, [4.85, 45.77]));
  const far = 300 + proximityBonus(distanceM(LYON, [2.35, 48.85]));
  assert.ok(near > far);
  assert.ok(360 > 300 + PROXIMITY_MAX_BONUS);
});

test('`addProximity` : le résultat proche remonte, celui sans place et celui lointain gardent leur score, l’entrée n’est pas modifiée', () => {
  const results = [
    { key: 'paris', score: 300, at: { lon: 2.35, lat: 48.85 } },
    { key: 'lyon', score: 295, at: { lon: 4.85, lat: 45.77 } },
    { key: 'action', score: 295 },
  ];
  const out = addProximity(results, LYON, distanceM);
  assert.equal(results[1].score, 295);
  assert.ok(out[1].score > out[0].score, 'Lyon passe devant Paris');
  assert.equal(out[0].score, 300);
  assert.equal(out[2].score, 295);
  assert.deepEqual(addProximity([], LYON, distanceM), []);
});

test('`within` garde ce qui est dans le rayon, du plus proche au plus lointain', () => {
  const items = [
    { name: 'loin', at: [2.35, 48.85] },
    { name: 'b', at: [4.86, 45.77] },
    { name: 'a', at: [4.837, 45.765] },
    { name: 'limite', at: [4.8357, 45.764 + 0.095] }, // ~10,5 km au nord
  ];
  const found = within(items, LYON, 10_000, (i) => i.at, distanceM);
  assert.deepEqual(found.map((f) => f.item.name), ['a', 'b']);
  assert.ok(found[0].distance < found[1].distance);
  assert.equal(within(items, LYON, 100, (i) => i.at, distanceM).length, 0);
  // près du pôle, le premier tri par degrés ne doit pas écarter à tort
  assert.equal(within([{ at: [10, 89.9] }], [0, 89.95], 50_000, (i) => i.at, distanceM).length, 1);
});

test('la zone « autour de moi » : cercle de 10, 25 ou 50 km autour de la position arrondie, même forme que les autres zones', () => {
  assert.deepEqual(WATCH_RADII_KM, [10, 25, 50]);
  const ref = aroundMeRef(4.83574, 45.76399, 25);
  assert.deepEqual(ref, { kind: 'circle', lon: 4.84, lat: 45.76, radius: 25_000 });
  assert.equal(encodeRef(ref), 'c:4.84,45.76,25000');
  assert.deepEqual(decodeRef(encodeRef(ref)), ref);
  // même position arrondie et même rayon : même zone (pas de doublon) ; autre rayon : autre zone
  assert.equal(zoneIdOf(aroundMeRef(4.8401, 45.7641, 25)), zoneIdOf(ref));
  assert.notEqual(zoneIdOf(aroundMeRef(4.8401, 45.7641, 10)), zoneIdOf(ref));
  // la position exacte n'apparaît nulle part dans la définition
  assert.ok(!JSON.stringify(ref).includes('83574') && !JSON.stringify(ref).includes('76399'));
});

test('fraîcheur de la position gardée en mémoire', () => {
  const now = 1_000_000_000;
  assert.equal(isFresh({ at: now - 60_000 }, now), true);
  assert.equal(isFresh({ at: now - POSITION_MAX_AGE_MS - 1 }, now), false);
});

test('messages d’erreur en français pour chaque code, et mises en forme', () => {
  assert.match(geolocationMessage(1), /refusée/);
  assert.match(geolocationMessage(2), /introuvable/);
  assert.match(geolocationMessage(3), /trop de temps/);
  assert.match(geolocationMessage(0), /impossible/);
  assert.equal(distanceText(450), '450 m');
  assert.equal(distanceText(3_440), '3,4 km');
  assert.equal(distanceText(12_400), '12 km');
  assert.equal(accuracyText(23), '± 25 m');
  assert.equal(accuracyText(2_300), '± 2,3 km');
});
