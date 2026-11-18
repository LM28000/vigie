// Tests du préchargement de la recherche : mots qui justifient de charger une couche (`ModuleManager.prefetch` ne s'importe pas sous Node : vérifié dans le navigateur).
// Lancer : node --test web/scripts/prefetch.test.mjs   (Node 22.18 ou plus : les .ts s'importent tels quels)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prefetchRules } from '../src/search/prefetch.ts';

const modules = (text) => prefetchRules(text).map((rule) => rule.module);

test('un mot qui désigne la couche la fait charger', () => {
  assert.deepEqual(modules('webcam chamonix'), ['cameras']);
  assert.deepEqual(modules('Caméras Perrache'), ['cameras']);
  assert.deepEqual(modules('borne ionity'), ['bornes']);
  assert.deepEqual(modules('recharge tesla lyon'), ['bornes']);
  assert.deepEqual(modules('Vélib’ Bastille'), ['velos']);
  assert.deepEqual(modules('vélo’v part-dieu'), ['velos']);
  assert.deepEqual(modules('v3 bordeaux'), ['velos']);
  assert.deepEqual(modules('parking perrache'), ['parkings']);
  assert.deepEqual(modules('parc relais nantes'), ['parkings']);
  assert.deepEqual(modules('château de Blois'), ['monuments']);
  assert.deepEqual(modules('actualité rennes'), ['actualite']);
  assert.deepEqual(modules('marées saint-malo'), ['marees']);
  assert.deepEqual(modules('crue de la Loire').sort(), ['rivieres', 'vigicrues']);
});

test('sans mot explicite, rien ne se charge (pas de 53 000 bornes à chaque frappe)', () => {
  for (const text of ['', ' ', 'l', 'lyon', 'part-dieu', 'chamonix', 'bastille', 'demain 8h', 'e85', 'bor', 'cameroun', 'chargement']) assert.deepEqual(modules(text), [], text);
});

test('un mot entier ne se confond pas avec un début de mot plus long', () => {
  assert.deepEqual(modules('camping'), []);
  assert.deepEqual(modules('relaise'), []);
  assert.deepEqual(modules('charges'), []);
});
