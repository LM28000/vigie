/**
 * Cap des trains : une seule définition, partagée par la tête (icône de loin), les rames
 * dessinées voiture par voiture et les maquettes 3D. Fonctions pures, sans dépendance, pour
 * pouvoir être testées seules (`node --test web/scripts`).
 */

const DEG = Math.PI / 180;

/** Cap d'un tronçon tel qu'il apparaît sur la carte (Web Mercator), en degrés deck.gl (anti-horaire depuis l'est). */
export function heading(lon1: number, my1: number, lon2: number, my2: number): number {
  return Math.atan2(my2 - my1, (lon2 - lon1) * DEG) / DEG;
}

/**
 * Cap de la rame à chaque sommet du chemin (`lon` en degrés, `my` en ordonnée Mercator).
 *
 * - Sur un tronçon de longueur non nulle, c'est le cap de ce tronçon (sens de marche).
 * - À l'arrêt (tronçon de longueur nulle entre l'arrivée et le départ d'une gare), la rame
 *   reste telle qu'elle est arrivée : le cap du dernier tronçon parcouru. Prendre celui du
 *   tronçon suivant retournait la tête de l'icône dès qu'un train repart en sens inverse
 *   (terminus, rebroussement), alors que le corps de la rame, lui, s'étend derrière son
 *   arrivée : de loin le train pointait d'un côté, de près la rame de l'autre.
 * - Avant le premier tronçon non nul (départ du terminus), le cap du premier tronçon.
 */
export function vertexAngles(lon: ArrayLike<number>, my: ArrayLike<number>): Float32Array {
  const count = lon.length;
  const angles = new Float32Array(count);
  let last = Number.NaN;
  for (let k = 0; k < count; k++) {
    if (k + 1 < count && (lon[k + 1] !== lon[k] || my[k + 1] !== my[k])) {
      last = heading(lon[k]!, my[k]!, lon[k + 1]!, my[k + 1]!);
    }
    angles[k] = last;
  }
  // Le début du chemin (avant tout déplacement) prend le cap du premier tronçon non nul.
  let next = 0;
  for (let k = count - 1; k >= 0; k--) {
    if (Number.isNaN(angles[k]!)) angles[k] = next;
    else next = angles[k]!;
  }
  return angles;
}

/**
 * Vrai si deux pas consécutifs du chemin font demi-tour (angle de plus de 135 degrés) : le train
 * a rebroussé chemin (terminus en cul-de-sac) et sa rame ne peut pas se replier sur son passé.
 */
export function isReversal(ax: number, ay: number, bx: number, by: number): boolean {
  const lengths = Math.hypot(ax, ay) * Math.hypot(bx, by);
  return lengths > 0 && (ax * bx + ay * by) / lengths < -0.7;
}
