// Tests de la lecture de l'indice pollen (modules/pollenLogic.ts) : niveaux officiels, « aucun pollen », jours non publiés.
// Lancer : node --test web/scripts/pollen.test.mjs   (Node 22.18 ou plus : les .ts s'importent tels quels)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEVELS, NONE, TAXA, cellOf, levelName } from '../src/modules/pollenLogic.ts';

// Deux jours, trois communes : hors saison ; bouleau extrêmement élevé demain ; jour de demain non publié.
const data = {
  updatedAt: 0,
  days: ['2026-04-01', '2026-04-02'],
  sources: ['Atmo'],
  zones: {
    code: ['75056', '33063', '35238'],
    name: ['Paris', 'Bordeaux', 'Rennes'],
    lon: [2.35, -0.58, -1.68],
    lat: [48.85, 44.84, 48.11],
    src: [0, 0, 0],
    v: ['ooooooo' + 'ooooooo', 'ooooooo' + '6o6o3oo', '11oooo-' + '-------'],
  },
};

test('l’échelle officielle compte six niveaux, dont les noms de la légende d’Atmo France', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((l) => LEVELS[l].name), ['Très faible', 'Faible', 'Modéré', 'Élevé', 'Très élevé', 'Extrêmement élevé']);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((l) => LEVELS[l].color), ['#50F0E6', '#50CCAA', '#F0E641', '#FF5050', '#960032', '#872181']);
});

test('« o » est « aucun pollen », distinct du niveau 1 « très faible »', () => {
  assert.equal(cellOf(data, 0, 0), NONE);
  assert.equal(levelName(NONE), 'Aucun pollen');
  assert.equal(cellOf(data, 2, 0), 1);
  assert.equal(levelName(1), 'Très faible');
});

test('le décalage choisit le taxon : 0 global, 1 à 6 dans l’ordre du serveur', () => {
  assert.equal(TAXA[1].id, 'bouleau');
  assert.equal(cellOf(data, 1, 1, 0), 6);
  assert.equal(cellOf(data, 1, 1, 2), 6); // bouleau
  assert.equal(cellOf(data, 1, 1, 4), 3); // graminées
  assert.equal(cellOf(data, 1, 1, 6), NONE); // ambroisie
});

test('« - » et les positions hors réponse sont « non évalué » (0)', () => {
  assert.equal(cellOf(data, 2, 0, 6), 0);
  assert.equal(cellOf(data, 2, 1, 0), 0);
  assert.equal(cellOf(data, 9, 0, 0), 0);
  assert.equal(cellOf(data, 0, 5, 0), 0);
});
