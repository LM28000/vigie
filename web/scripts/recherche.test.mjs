// Tests de la recherche : lecture des requêtes de carburant (search/fuelQuery.ts).
// Lancer : node --test web/scripts/recherche.test.mjs   (Node 22.18 ou plus : les .ts s'importent tels quels)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFuelQuery } from '../src/search/fuelQuery.ts';

const fuel = (text) => parseFuelQuery(text)?.fuel ?? null;

test('chaque carburant se reconnaît sous ses graphies courantes', () => {
  for (const text of ['e85', 'E85', 'e-85', 'e 85', 'superéthanol', 'Super-éthanol', 'bioéthanol', 'éthanol']) assert.equal(fuel(text), 'e85', text);
  for (const text of ['sp95', 'SP95', 'sp 95', 'sp-95', 'sans plomb 95']) assert.equal(fuel(text), 'sp95', text);
  for (const text of ['sp98', 'SP 98', 'sp-98', 'sans plomb 98']) assert.equal(fuel(text), 'sp98', text);
  for (const text of ['e10', 'E-10', 'sp95-e10', 'SP95 E10', 'sp 95 e 10']) assert.equal(fuel(text), 'e10', text);
  for (const text of ['gazole', 'Gazole', 'gasoil', 'gas-oil', 'diesel', 'B7']) assert.equal(fuel(text), 'gazole', text);
  for (const text of ['gpl', 'GPLc', 'gpl-c']) assert.equal(fuel(text), 'gplc', text);
});

test('« sp95-e10 » est un E10, pas un SP95 ; « sp95 » seul reste un SP95', () => {
  assert.equal(parseFuelQuery('sp95-e10').fuel, 'e10');
  assert.equal(parseFuelQuery('sp95').fuel, 'sp95');
  assert.equal(parseFuelQuery('sp95 e10 lyon').place, 'lyon');
});

test('« essence » est un E10 dit vaguement', () => {
  const q = parseFuelQuery('essence');
  assert.equal(q.fuel, 'e10');
  assert.equal(q.generic, true);
  assert.equal(parseFuelQuery('sans plomb').generic, true);
  assert.equal(parseFuelQuery('sp98').generic, false);
});

test('le lieu est ce qui reste une fois le carburant et les mots de liaison retirés', () => {
  assert.equal(parseFuelQuery('e85 lyon').place, 'lyon');
  assert.equal(parseFuelQuery('gazole moins cher près de Rennes').place, 'rennes');
  assert.equal(parseFuelQuery('gazole moins cher près de Rennes').cheapest, true);
  assert.equal(parseFuelQuery('sp98 à Saint-Étienne').place, 'saint etienne');
  assert.equal(parseFuelQuery('essence 35').place, '35');
  assert.equal(parseFuelQuery('diesel pas cher autour de Brest').place, 'brest');
  assert.equal(parseFuelQuery('e85').place, '');
  assert.equal(parseFuelQuery('e85').cheapest, false);
});

test('« station service » sans carburant demande un lieu', () => {
  const q = parseFuelQuery('station service Rennes');
  assert.equal(q.fuel, null);
  assert.equal(q.place, 'rennes');
  assert.equal(parseFuelQuery('prix carburant paris').place, 'paris');
  assert.equal(parseFuelQuery('station service'), null);
  assert.equal(parseFuelQuery('carburants'), null);
});

test('ce qui ne parle pas de carburant n’en est pas', () => {
  for (const text of ['lyon', 'part-dieu', 'pluie', 'demain 8h', 'super u lyon', 'go to paris', 'e8', 'sp9', 'ethiopie']) assert.equal(parseFuelQuery(text), null, text);
});
