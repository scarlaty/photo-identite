import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compterVisages } from '../js/face.js';

/** Faux visage : boîte (x0, y0)–(x1, y1) en coordonnées normalisées, 4 points aux coins. */
const f = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x0, y: y1 }, { x: x1, y: y1 }];

test('compterVisages : doublon, logo sur la poitrine et petits visages ignorés ; autre personne comptée', () => {
  const principal = f(0.4, 0.2, 0.6, 0.45);
  assert.equal(compterVisages([principal], 0), 1);
  assert.equal(compterVisages([principal, f(0.41, 0.21, 0.61, 0.46)], 0), 1);   // même visage détecté deux fois
  assert.equal(compterVisages([principal, f(0.45, 0.6, 0.55, 0.72)], 0), 1);    // imprimé sur le maillot
  assert.equal(compterVisages([principal, f(0.05, 0.1, 0.08, 0.14)], 0), 1);    // visage minuscule (affiche)
  assert.equal(compterVisages([principal, f(0.05, 0.2, 0.22, 0.42)], 0), 2);    // une autre personne à côté
  assert.equal(compterVisages([principal, f(0.4, 0.5, 0.6, 0.72)], 0), 2);      // enfant tenu devant, taille proche
});
