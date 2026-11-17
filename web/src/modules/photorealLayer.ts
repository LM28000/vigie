/**
 * Couche deck.gl des Google Photorealistic 3D Tiles : un `Tile3DLayer` dont chaque tuile est dessinée par une
 * `ScenegraphLayer` retouchée sur trois points.
 *
 * 1. **Altitude.** Les tuiles de Google donnent des hauteurs au-dessus de l'ellipsoïde WGS84 ; tout le reste de la carte
 *    (relief de MapLibre, avions, trains) compte au-dessus du niveau de la mer, 43 à 57 m plus haut en France. L'origine
 *    de chaque tuile est abaissée de l'ondulation du géoïde (`map/geoid.ts`), et d'un petit décalage réglable.
 * 2. **Lumière.** Les photos sont déjà éclairées (le soleil du jour de la prise de vue est dans la texture) : on les affiche
 *    telles quelles (`_lighting: 'flat'`, texture × couleur), sans rééclairer. La couleur sert à assombrir la nuit.
 * 3. **Couleur.** `getColor` vient du module (la nuit), voir `photoreal.ts`.
 */
import { Layer } from '@deck.gl/core';
import { Tile3DLayer } from '@deck.gl/geo-layers';
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import { geoidUndulation } from '../map/geoid';

/**
 * Vide le tampon de profondeur avant le maillage. Le fond de carte (relief compris) a déjà été dessiné, et son relief, plus
 * lisse que le maillage, en perçait des plaques (pentes, baie du Mont-Saint-Michel). Sans lui dans le tampon, le maillage
 * recouvre toujours le fond là où il est chargé, et le fond reste visible ailleurs ; les couches dessinées ensuite (avions,
 * trains, bus…) ne se testent plus que contre le maillage.
 */
export class DepthClearLayer extends Layer {
  static override layerName = 'DepthClearLayer';

  initializeState(): void {}

  override draw(): void {
    const gl = (this.context.device as unknown as { gl?: WebGL2RenderingContext }).gl;
    if (!gl) return;
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }
}

/** Marque une couche dont l'origine a déjà été ramenée au niveau de la mer (un `clone` repasse par le constructeur). */
const SEA_LEVEL = 'photorealSeaLevel';

/** Décalage vertical du maillage par rapport au relief de MapLibre, en mètres (positif : vers le haut). Voir docs/rendu-3d.md. */
export const MESH_LIFT_M = 0;

export class SeaLevelScenegraphLayer extends ScenegraphLayer<number> {
  static override layerName = 'SeaLevelScenegraphLayer';

  // deck.gl fusionne tous les objets de propriétés reçus (les nôtres passent en dernier).
  constructor(...propObjects: Array<Record<string, unknown>>) {
    const merged = Object.assign({}, ...propObjects) as Record<string, unknown>;
    const origin = merged.coordinateOrigin as [number, number, number] | undefined;
    const fix: Record<string, unknown> = { _lighting: 'flat' };
    if (origin && !merged[SEA_LEVEL]) {
      fix.coordinateOrigin = [origin[0], origin[1], (origin[2] ?? 0) - geoidUndulation(origin[0], origin[1]) + MESH_LIFT_M];
      fix[SEA_LEVEL] = true;
    }
    super(...(propObjects as []), fix as never);
  }
}

/** Les mentions de droits d'auteur d'une tuile (« Data SIO, NOAA, U.S. Navy, NGA, GEBCO; Airbus »), lues dans son glTF. */
export function tileCopyright(tile: { content?: { gltf?: { asset?: { copyright?: string } } } }): string[] {
  const copyright = tile.content?.gltf?.asset?.copyright;
  return copyright ? copyright.split(';').map((s) => s.trim()).filter(Boolean) : [];
}

export { Tile3DLayer };
