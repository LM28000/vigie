// Tests de la veille (zones surveillées) : géométrie (core/geo.ts) et logique pure (core/veilleLogic.ts).
// Lancer : node --test web/scripts/veille.test.mjs   (Node 22.18 ou plus : les .ts s'importent tels quels)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { circleRing, distanceM, distanceToRingM, inRing, ringAreaKm2, ringBounds, simplifyRing } from '../src/core/geo.ts';
import {
  ALERT_KEEP_MS,
  DEFAULT_TYPES,
  EVENT_TYPES,
  SERVER_TYPES,
  TYPE_LABELS,
  FORGET_MS,
  MAX_ALERTS,
  MAX_ZONES,
  REARM_MS,
  alertKey,
  applyPoll,
  decodeRef,
  decodeZonesParam,
  encodeRef,
  encodeZonesParam,
  feltRadiusKm,
  mergeZones,
  quakeEvents,
  titleWithCount,
  trimAlerts,
  unreadCount,
  zoneIdOf,
} from '../src/core/veilleLogic.ts';

const SQUARE = [[1.5, 46.5], [2.5, 46.5], [2.5, 47.5], [1.5, 47.5]];
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const event = (id, severity = 3, extra = {}) => ({ id, type: 'vigilance', severity, title: id, detail: '', module: 'vigilance-meteo', selection: {}, zoom: 7, ...extra });

// --- Géométrie --------------------------------------------------------------------------------------------------------------

test('point dans un polygone : dedans, dehors, sur un polygone concave (le creux du U est dehors)', () => {
  assert.equal(inRing(2, 47, SQUARE), true);
  assert.equal(inRing(3, 47, SQUARE), false);
  assert.equal(inRing(2, 48, SQUARE), false);
  const u = [[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]];
  assert.equal(inRing(0.5, 2, u), true);
  assert.equal(inRing(2.5, 2, u), true);
  assert.equal(inRing(1.5, 2, u), false);
  assert.equal(inRing(1.5, 0.5, u), true);
});

test('un cercle de 5 km : son centre est dedans, un point à 4,9 km aussi, à 5,1 km non ; surface proche de π r²', () => {
  const center = [2.3522, 48.8566];
  const ring = circleRing(center, 5000);
  assert.equal(ring.length, 96);
  assert.equal(inRing(center[0], center[1], ring), true);
  // 4,9 km plein est : 4 900 m / (111 320 m × cos φ) degrés de longitude
  const lonPerM = 1 / (111_320 * Math.cos((48.8566 * Math.PI) / 180));
  assert.equal(inRing(center[0] + 4900 * lonPerM, center[1], ring), true);
  assert.equal(inRing(center[0] + 5100 * lonPerM, center[1], ring), false);
  // 96 côtés : l'écart à π r² est de l'ordre de 0,1 %
  const expected = Math.PI * 25;
  assert.ok(Math.abs(ringAreaKm2(ring) - expected) / expected < 0.003, `${ringAreaKm2(ring)} vs ${expected}`);
  for (const p of ring) close(distanceM(center, p), 5000, 1);
});

test('distance à une zone : 0 dedans, sinon distance au contour (le côté le plus proche, pas le sommet)', () => {
  assert.equal(distanceToRingM([2, 47], SQUARE), 0);
  // 0,1° au nord du côté nord (47,5) : ≈ 11,06 km
  close(distanceToRingM([2, 47.6], SQUARE) / 1000, 11.06, 0.1);
  // en diagonale par rapport au coin nord-est : distance au sommet
  const corner = distanceToRingM([2.6, 47.6], SQUARE);
  close(corner, distanceM([2.6, 47.6], [2.5, 47.5]), 200);
  assert.equal(distanceToRingM([2, 47], []), Infinity);
});

test('les limites d\'un anneau', () => {
  assert.deepEqual(ringBounds(SQUARE), [1.5, 46.5, 2.5, 47.5]);
});

test('allègement d\'un contour : on garde la forme sous le plafond de sommets', () => {
  // un cercle de 3 000 sommets ramené à 100 : reste un disque de même surface (à 2 % près)
  const dense = circleRing([2, 47], 8000, 3000);
  const light = simplifyRing(dense, 100);
  assert.ok(light.length <= 100 && light.length >= 8, `${light.length} sommets`);
  const dense2 = ringAreaKm2(dense);
  assert.ok(Math.abs(ringAreaKm2(light) - dense2) / dense2 < 0.02);
  // un anneau déjà léger n'est pas touché ; un anneau fermé perd son sommet de fermeture
  assert.deepEqual(simplifyRing(SQUARE, 50), SQUARE);
  assert.deepEqual(simplifyRing([...SQUARE, SQUARE[0]], 50), SQUARE);
});

// --- Dédoublonnage ----------------------------------------------------------------------------------------------------------

test('dédoublonnage : un événement n\'est signalé qu\'une fois tant qu\'il reste là', () => {
  const t0 = 1_000_000_000;
  let seen = {};
  let out = applyPoll(seen, [{ zoneId: 'z1', events: [event('vig:33:3:3')] }], t0);
  assert.equal(out.fresh.length, 1);
  seen = out.seen;
  // relevés suivants, une minute après l'autre, pendant 3 heures : plus rien de nouveau
  for (let i = 1; i <= 180; i++) {
    out = applyPoll(seen, [{ zoneId: 'z1', events: [event('vig:33:3:3')] }], t0 + i * 60_000);
    assert.equal(out.fresh.length, 0, `relevé ${i}`);
    seen = out.seen;
  }
});

test('dédoublonnage : le même événement dans deux zones est signalé pour chacune', () => {
  const out = applyPoll({}, [{ zoneId: 'z1', events: [event('a')] }, { zoneId: 'z2', events: [event('a')] }], 5);
  assert.deepEqual(out.fresh.map((f) => f.zoneId), ['z1', 'z2']);
});

test('dédoublonnage : un autre identifiant (l\'orange devient rouge) est une nouvelle alerte', () => {
  const t0 = 10_000_000;
  const first = applyPoll({}, [{ zoneId: 'z', events: [event('vig:33:3:3', 3)] }], t0);
  const second = applyPoll(first.seen, [{ zoneId: 'z', events: [event('vig:33:3:4', 4)] }], t0 + 60_000);
  assert.deepEqual(second.fresh.map((f) => f.event.id), ['vig:33:3:4']);
});

test('dédoublonnage : disparu moins de 6 h puis revenu = déjà signalé ; disparu 6 h ou plus puis revenu = nouvelle alerte', () => {
  const t0 = 50_000_000;
  let r = applyPoll({}, [{ zoneId: 'z', events: [event('x')] }], t0);
  // il disparaît : on relève une zone vide
  r = applyPoll(r.seen, [{ zoneId: 'z', events: [] }], t0 + 60_000);
  assert.equal(r.fresh.length, 0);
  // il revient 5 h 59 après sa dernière vue : pas de nouvelle alerte
  const back1 = applyPoll(r.seen, [{ zoneId: 'z', events: [event('x')] }], t0 + REARM_MS - 60_000);
  assert.equal(back1.fresh.length, 0);
  // il revient 6 h après sa dernière vue (t0) : nouvelle alerte
  const back2 = applyPoll(r.seen, [{ zoneId: 'z', events: [event('x')] }], t0 + REARM_MS);
  assert.equal(back2.fresh.length, 1);
});

test('dédoublonnage : les traces anciennes sont oubliées, une zone absente du relevé garde les siennes, rien n\'est modifié en place', () => {
  const t0 = 90_000_000;
  const seen = { [alertKey('old', 'e')]: t0 - FORGET_MS - 1, [alertKey('other', 'e')]: t0 - 1000 };
  const frozen = JSON.stringify(seen);
  const out = applyPoll(seen, [{ zoneId: 'z', events: [event('n')] }], t0);
  assert.equal(JSON.stringify(seen), frozen);
  assert.equal(alertKey('old', 'e') in out.seen, false);
  assert.equal(out.seen[alertKey('other', 'e')], t0 - 1000);
  assert.equal(out.seen[alertKey('z', 'n')], t0);
});

// --- Alertes -----------------------------------------------------------------------------------------------------------------

test('alertes gardées : les plus récentes d\'abord, bornées en nombre et en âge', () => {
  const now = 2_000_000_000_000;
  const alerts = [];
  for (let i = 0; i < MAX_ALERTS + 20; i++) alerts.push({ key: `k${i}`, zoneId: 'z', zoneName: 'Z', event: event(`e${i}`), at: now - i * 1000, read: i % 2 === 0 });
  alerts.push({ key: 'vieille', zoneId: 'z', zoneName: 'Z', event: event('vieille'), at: now - ALERT_KEEP_MS - 1, read: true });
  const kept = trimAlerts(alerts, now);
  assert.equal(kept.length, MAX_ALERTS);
  assert.equal(kept[0].key, 'k0');
  assert.ok(!kept.some((a) => a.key === 'vieille'));
  assert.equal(unreadCount(kept), kept.filter((a) => !a.read).length);
});

test('titre de l\'onglet avec compteur', () => {
  assert.equal(titleWithCount('Vigie', 0), 'Vigie');
  assert.equal(titleWithCount('Vigie', 3), '(3) Vigie');
  assert.equal(titleWithCount('Vigie', 250), '(99+) Vigie');
});

// --- Zones dans l'adresse ------------------------------------------------------------------------------------------------

test('références de zone : aller-retour pour cercle, polygone, département, commune', () => {
  const refs = [
    { kind: 'circle', lon: 2.3522, lat: 48.8566, radius: 5000 },
    { kind: 'polygon', points: [[1.5, 46.5], [2.5, 46.5], [2, 47.5]] },
    { kind: 'department', code: '33' },
    { kind: 'department', code: '2A' },
    { kind: 'commune', code: '33063' },
  ];
  for (const ref of refs) assert.deepEqual(decodeRef(encodeRef(ref)), ref);
  assert.equal(encodeRef(refs[0]), 'c:2.3522,48.8566,5000');
  assert.equal(encodeRef(refs[2]), 'd:33');
});

test('références invalides refusées', () => {
  for (const bad of ['', 'c:1,2', 'c:a,b,c', 'c:1,95,100', 'c:1,2,-5', 'p:1,2;3,4', 'p:1,2;3,4;x,y', 'd:', 'd:12345678', 'z:33', 'm:../etc']) {
    assert.equal(decodeRef(bad), null, bad);
  }
});

test('paramètre veille : aller-retour avec noms accentués, « ! » et « ~ », types par défaut omis', () => {
  const zones = [
    { ref: { kind: 'department', code: '33' }, types: DEFAULT_TYPES, name: 'Gironde ! (chez moi) ~ ça' },
    { ref: { kind: 'circle', lon: 5.7, lat: 45.2, radius: 10000 }, types: ['train', 'avion'], name: 'Grenoble' },
  ];
  const text = encodeZonesParam(zones);
  assert.ok(!text.slice(text.indexOf('!')).includes(' '), 'pas d\'espace brut');
  const back = decodeZonesParam(text);
  assert.equal(back.length, 2);
  assert.deepEqual(back[0].ref, zones[0].ref);
  assert.equal(back[0].name, 'Gironde ! (chez moi) ~ ça');
  assert.deepEqual(back[0].types, DEFAULT_TYPES);
  assert.deepEqual(back[1].types, ['train', 'avion']);
  assert.equal(back[1].name, 'Grenoble');
});

test('paramètre veille : les entrées invalides sont ignorées, les types inconnus aussi, le nombre de zones est borné', () => {
  assert.deepEqual(decodeZonesParam(''), []);
  const out = decodeZonesParam('n:nope!!x~d:75!pirate,train!Paris');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].types, ['train']);
  const many = Array.from({ length: MAX_ZONES + 5 }, (_, i) => `d:${i + 10}!!`).join('~');
  assert.equal(decodeZonesParam(many).length, MAX_ZONES);
});

test('identifiant de zone : stable, et différent d\'une définition à l\'autre', () => {
  const a = { kind: 'circle', lon: 2, lat: 47, radius: 1000 };
  assert.equal(zoneIdOf(a), zoneIdOf({ ...a }));
  assert.notEqual(zoneIdOf(a), zoneIdOf({ ...a, radius: 1001 }));
  assert.match(zoneIdOf(a), /^z[0-9a-z]+$/);
});

test('fusion de zones : celles qui existent déjà ne sont pas doublées, le plafond est respecté', () => {
  const zone = (id) => ({ id });
  assert.deepEqual(mergeZones([zone('a')], [zone('a'), zone('b')]).map((z) => z.id), ['a', 'b']);
  const full = Array.from({ length: MAX_ZONES }, (_, i) => zone(`z${i}`));
  assert.equal(mergeZones(full, [zone('nouvelle')]).length, MAX_ZONES);
});

// --- Séismes -------------------------------------------------------------------------------------------------------------------

test('séisme ressenti : magnitude 3 minimum, récent, assez près selon la magnitude', () => {
  const now = 1_800_000_000_000;
  const quake = (id, mag, lon, lat, ageMin = 30) => ({ id, mag, lon, lat, depthKm: 8, time: now - ageMin * 60_000, region: 'NEAR SOUTH COAST OF FRANCE' });
  // zone : le carré SQUARE ; distance calculée comme le fait la veille
  const distance = (lon, lat) => distanceToRingM([lon, lat], SQUARE);
  assert.equal(feltRadiusKm(2.9) > 0, true);
  const quakes = [
    quake('dedans', 3.2, 2, 47),
    quake('petit', 2.4, 2, 47),
    quake('proche-m4', 4.0, 2.5 + 0.2, 47), // ≈ 15 km du bord est, rayon ressenti de M 4 : 30 km
    quake('loin-m3', 3.0, 2.5 + 0.3, 47), // ≈ 23 km, rayon ressenti de M 3 : 15 km
    quake('ancien', 4.0, 2, 47, 25 * 60),
    quake('futur', 4.0, 2, 47, -10),
  ];
  const events = quakeEvents(quakes, distance, now);
  assert.deepEqual(events.map((e) => e.id).sort(), ['seisme:dedans', 'seisme:proche-m4']);
  const inside = events.find((e) => e.id === 'seisme:dedans');
  assert.equal(inside.type, 'seisme');
  assert.match(inside.detail, /dans la zone/);
  assert.match(inside.detail, /Near South Coast of France/);
  assert.equal(inside.severity, 1);
  assert.equal(events.find((e) => e.id === 'seisme:proche-m4').severity, 2);
  assert.match(events.find((e) => e.id === 'seisme:proche-m4').detail, /à \d+ km de la zone/);
  assert.equal(inside.time, Math.round((now - 30 * 60_000) / 1000));
});

test('le risque d\'avalanche fort est un type d\'événement du serveur, surveillé par défaut, avec son libellé', () => {
  assert.ok(EVENT_TYPES.includes('avalanche'));
  assert.ok(SERVER_TYPES.includes('avalanche'), 'évalué par le serveur, pas par le site');
  assert.ok(DEFAULT_TYPES.includes('avalanche'));
  assert.match(TYPE_LABELS.avalanche, /avalanche/i);
});
