/**
 * Géométrie sur la sphère, sans dépendance (ni React, ni carte) : elle est partagée par l'analyse de zone (`zone.ts`) et la
 * veille (`veille.ts`), et testée telle quelle (`node --test web/scripts/veille.test.mjs`, d'où l'absence d'import).
 */

export type Position = [lon: number, lat: number];

const EARTH_RADIUS_M = 6_371_008.8;

const rad = (degrees: number) => (degrees * Math.PI) / 180;
const deg = (radians: number) => (radians * 180) / Math.PI;

/** Distance à vol d'oiseau (mètres) entre deux positions : formule de haversine. */
export function distanceM(a: Position, b: Position): number {
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Le point à `distance` mètres de `from`, dans la direction `bearing` (radians depuis le nord). */
export function destination(from: Position, distance: number, bearing: number): Position {
  const angular = distance / EARTH_RADIUS_M;
  const [lon, lat] = [rad(from[0]), rad(from[1])];
  const lat2 = Math.asin(Math.sin(lat) * Math.cos(angular) + Math.cos(lat) * Math.sin(angular) * Math.cos(bearing));
  const lon2 = lon + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat), Math.cos(angular) - Math.sin(lat) * Math.sin(lat2));
  return [deg(lon2), deg(lat2)];
}

/** Un cercle approché par `segments` sommets (anneau ouvert), placés à la bonne distance sur la sphère. */
export function circleRing(center: Position, radius: number, segments = 96): Position[] {
  return Array.from({ length: segments }, (_, i) => destination(center, radius, (2 * Math.PI * i) / segments));
}

/** Surface (km²) d'un anneau sur la sphère (formule de Chamberlain-Duquette : somme de trapèzes en longitude). */
export function ringAreaKm2(ring: Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [a, b] = [ring[i]!, ring[(i + 1) % ring.length]!];
    sum += rad(b[0] - a[0]) * (2 + Math.sin(rad(a[1])) + Math.sin(rad(b[1])));
  }
  return (Math.abs(sum) * EARTH_RADIUS_M ** 2) / 2 / 1e6;
}

/** Le point est-il dans l'anneau (règle pair-impair) ? C'est le même test que `in_ring` du serveur (`veille.rs`). */
export function inRing(lon: number, lat: number, ring: readonly Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ouest, sud, est, nord. */
export type Bounds = [west: number, south: number, east: number, north: number];

export function ringBounds(ring: readonly Position[]): Bounds {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of ring) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [west, south, east, north];
}

/** Distance (mètres) d'un point à un segment, à plat autour du point (juste à quelques centaines de km près). */
function distanceToSegmentM(point: Position, a: Position, b: Position): number {
  const kx = Math.cos(rad(point[1])) * 111_320;
  const ky = 110_574;
  const [ax, ay] = [(a[0] - point[0]) * kx, (a[1] - point[1]) * ky];
  const [bx, by] = [(b[0] - point[0]) * kx, (b[1] - point[1]) * ky];
  const [dx, dy] = [bx - ax, by - ay];
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Distance (mètres) d'un point à une zone : 0 s'il est dedans, sinon distance au contour. */
export function distanceToRingM(point: Position, ring: readonly Position[]): number {
  if (ring.length === 0) return Infinity;
  if (inRing(point[0], point[1], ring)) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) best = Math.min(best, distanceToSegmentM(point, ring[i]!, ring[(i + 1) % ring.length]!));
  return best;
}

/** Distance (degrés) d'un point à la droite (a, b) : mesure de Douglas-Peucker. */
function perpendicular(p: Position, a: Position, b: Position): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function douglasPeucker(points: readonly Position[], tolerance: number): Position[] {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicular(points[i]!, points[first]!, points[last]!);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index >= 0 && worst > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Allège un contour (une commune en compte des milliers) jusqu'à `maxPoints` sommets au plus : Douglas-Peucker, tolérance
 * doublée jusqu'à y arriver (de 0,0001° ≈ 10 m à plusieurs km pour un grand département). Le contour reste fermé sur lui-même
 * (on retire un éventuel sommet final égal au premier).
 */
export function simplifyRing(ring: readonly Position[], maxPoints: number): Position[] {
  let points = [...ring];
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 1 && first && last && first[0] === last[0] && first[1] === last[1]) points.pop();
  let tolerance = 0.0001;
  while (points.length > maxPoints && tolerance < 5) {
    points = douglasPeucker(ring.length > 1 ? [...ring] : points, tolerance);
    const f = points[0];
    const l = points[points.length - 1];
    if (points.length > 1 && f && l && f[0] === l[0] && f[1] === l[1]) points.pop();
    tolerance *= 1.6;
  }
  return points;
}
