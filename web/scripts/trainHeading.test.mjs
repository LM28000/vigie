// Test du cap des trains (fonctions pures de src/modules/trainHeading.ts).
// Lancer : node --test web/scripts/trainHeading.test.mjs   (Node 22.18 ou plus : les .ts s'importent tels quels)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heading, isReversal, vertexAngles } from '../src/modules/trainHeading.ts';

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('cap : est = 0, nord = 90, ouest = 180, sud = -90 (anti-horaire depuis l\'est)', () => {
  close(heading(0, 0, 1, 0), 0);
  close(heading(0, 0, 0, 0.01), 90);
  close(Math.abs(heading(0, 0, -1, 0)), 180);
  close(heading(0, 0, 0, -0.01), -90);
});

test('en marche : le cap est celui du tronçon qui part du sommet', () => {
  // vers l'est, puis vers le nord
  const a = vertexAngles([0, 1, 1], [0, 0, 0.02]);
  close(a[0], 0);
  close(a[1], 90);
  close(a[2], 90); // dernier sommet : cap du dernier tronçon
});

test('à l\'arrêt en gare (tronçon nul) : la rame garde le cap de son arrivée, même si elle repart en sens inverse', () => {
  // arrivée vers l'est (sommets 0 à 2), arrêt (2 et 3 confondus), départ vers l'ouest (3 à 5)
  const lon = [0, 1, 2, 2, 1, 0];
  const my = [0, 0, 0, 0, 0, 0];
  const a = vertexAngles(lon, my);
  close(a[1], 0);
  close(a[2], 0); // avant : 180, la tête de l'icône se retournait pendant l'arrêt
  close(Math.abs(a[3]), 180); // elle repart : cap du départ
  close(Math.abs(a[4]), 180);
});

test('avant le premier tronçon non nul : cap du premier tronçon', () => {
  const a = vertexAngles([5, 5, 6, 7], [0, 0, 0, 0]);
  close(a[0], 0);
  close(a[1], 0);
});

test('chemin sans déplacement : cap 0, pas de NaN', () => {
  const a = vertexAngles([1, 1, 1], [2, 2, 2]);
  assert.deepEqual([...a], [0, 0, 0]);
});

test('demi-tour : plus de 135 degrés entre deux pas', () => {
  assert.equal(isReversal(1, 0, -1, 0), true);
  assert.equal(isReversal(1, 0, -1, 0.3), true);
  assert.equal(isReversal(1, 0, 1, 0), false);
  assert.equal(isReversal(1, 0, 0, 1), false); // virage à angle droit
  assert.equal(isReversal(1, 0, -0.5, 1), false); // 116 degrés : épingle serrée, pas un demi-tour
  assert.equal(isReversal(0, 0, -1, 0), false); // pas nul
});
