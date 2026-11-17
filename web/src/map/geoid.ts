/**
 * Ondulation du géoïde au-dessus de l'ellipsoïde WGS84, sur la France et ses abords, pour passer des hauteurs
 * ellipsoïdales (celles des Google Photorealistic 3D Tiles) aux altitudes au-dessus du niveau de la mer (celles du
 * relief de MapLibre, des avions et de tout le reste de la carte). En France, l'ellipsoïde est 43 à 57 m *sous* le géoïde :
 * altitude = hauteur ellipsoïdale - ondulation.
 *
 * Données : modèle EGM96 (grille de 15', fichier PROJ `us_nga_egm96_15.tif`), rééchantillonné sur 41° à 52° N et
 * 6° O à 10° E au quart de degré, au huitième de mètre (un octet par point : (ondulation - 30 m) × 8, du nord au sud puis
 * de l'ouest à l'est). Interpolation bilinéaire ; hors de la grille, le point le plus proche. EGM96 et EGM2008 (celui des
 * relevés derrière Mapterhorn) diffèrent de moins d'un mètre ici, ce qui est sans effet visible.
 */

const WEST = -6;
const NORTH = 52;
const STEP = 0.25;
const COLS = 65;
const ROWS = 45;
const GRID =
  'xMLBwMDBwcC/vLm0r6mjnpmWk5GOi4iFgoB/fXt5d3Z0c3JxcHBvbm1sa2trbGxtbm5vcHFycnN0dXZ3d3Z1dHPCwcLCwsHAvru4tbGspqCbl5OQjoyJhoOBfnx7eXd1dHNzc3NycnFwb29vbm5ubm9wcXN1dnh5ent8fX5+fXx7e8HCwsPCwL67uLWxramknpmVkY6LiIaDgX99e3l3dnRzcnJzc3Nzc3Nzc3NzcnFxcXJ1d3p9f4GDhYaGhoWEgoGAwsPDwsG/vLq3tLCrp6Gcl5OOi4eEgoB+fXt6eXh2dXNzc3N0dHV1dnd3eHh3dnV2d3p9gIOGiYyOj4+OjImHhoXEw8LBwL68ure0sKuloJuWkYyIhIF/fXx6enl4eHZ1dHR0dHV2dnd4eXp7fHx7e3x+gIKEh4qNkZOUlJKQjYuKicTDwcC+vbu6t7SvqqSfmpWQi4aDgH58enl3d3Z2dXV0dHR1dXZ2d3h6fH1/gIGCg4WGiImKjI+SlJWVk5GQjo2MwsG/vbu6ube1sq6po56ZlI+KhoKAfnx6eHZ1dXV1dHR0dHR1dXZ3eHp9f4GDhYeJi42Njo6PkZKUlJOTkpGRkI7Bv7y6uLe1tLKvq6einpmUj4qGg4B/fXp4dnV2dnZ2dnV0dHR0dXd5fH+Bg4WHio2PkZKSk5OUlJSTkpKSkpKRj7+9u7m4trSzsK2qpqGdmZWQjIiEgX99enh3d3h4eXl4d3Z1dHV2eHt+gIKEhoiLjpGTlJWWlpaWlJKRkZKTk5KQvby6ubi2tbOwramloZ6al5OPi4iEgX58enl5eXp6enl4d3Z2dnd5fH6AgoSGiYyOkJGTlJaXl5aUkpGRkpSUlJK7urm4trSzsa6sqKWhnpuZlpOQjYqGg4B+fXx7enl4eHd3dnZ2eHl7fH6Ag4aJjI2Ojo+SlJaXlpSSkJGSlJWVlLm4trSyr62rqqinpKKgnZqYlZORj4yKh4SCf317eXd2dXV1dXZ3eXp7fH+ChomKi4uLjZCTlZaVk5GQkZKUlZWUtrWzsa6rqaenpqalpKGfm5mWlZOSkI6LiIWCf3x6eHZ1dHR0dnh5e3t9f4KFiImJiYqNkJOVlJOSkZKSk5SUlJO1s7Kwraupp6empqalo6CcmZeVlJORj42Kh4SBfnx6eHZ1dHV2eXt8fX6Ag4aIiYqKjJCTlZWUk5KTlZWVlJORkLSzsrGvrauqqaempaSin52al5WUkpGPjYqHhYJ/fXx6eXd3d3l7fX5/gIKFiIqLjI2Qk5WWlpWUlZeZmZeUkY6Ms7KxsK+tq6qopqSioJ6dm5mXlZSSkY+NioiGg4F+fXx7enp7fH5/gIGChIeKjI2OkJKVl5iYl5iZm5ualpGNioizsrCurKmopqWkop+dm5mYl5aVlJKRj42LiYeEgoB+fX19fn+AgYKCg4WHiYuMjY6Qk5aYmZqampqamZWRjIiGhbGwr6yppqSjoqGfnZuZl5aVlJSTkpCOjIuJh4WDgYB/f4GCg4SEhIWGiIqLjIyNjpGTl5mampqYl5WSjoqGhISFq6ysq6mmo6Ggn56dm5mXlZOTkpKSkI6MiomIh4WEg4KDhIaHh4eIiYuMjo6OjY6Qk5aZm5ual5SRjouIhYOChIifo6anp6ajoZ+dnJybmZeVk5KSkpGRj42LiomJiYiHhoeJiouLi4uMjpCRkZCQkZSYm52dm5iVko+Ni4mGhYaJjpKWm5+io6Kgnpybm5uamJaUkpKRkZCPjo2MjIyMjIuLjI6PkI+Pj5CSk5STkpOVmZ2fn56al5WUk5OSkI6MjJCVh4qOlJmdnp6dnJuampmYl5WUkpGRkJCPj46Ojo+Pj4+QkpOTk5KSk5WWlpWVlpmeoaKhnpuZmZqcnJyZlpSUl5yCgoWJjpOXmpucnJuZmJeWlZSTkpGQkZCQkI+QkZKTlJWWl5eXlpaXmJmYl5eZnJ+ioqCenZ6hpKWlop+bmZmcoIKAgIKFio+UmJucm5mXlpWUk5KRkJCRkZGRkZKTlZeZmpucnJybm5ycnZyamZmbnZ+fn5+ipquuramjnJiXmJyghYOBgIKFiY6TmJucm5mWlJORkI+Oj5CRkZKSlJaZnJ6goqOjoqGhoaKioJ2amZiZm5yfpKqxtbSvppuSjYuOk5iIhoWDg4SGiY6TmJycm5iVkpCOjIuMjY6PkZOVmJueoqWoqquqqaioqKeloJyYl5ianqSrs7i4sqeZjIF7eXt/hYiHhoaFhIOEh4uRlpmZl5SRjoyLiYmJioyPkpWYnJ+jp6uvsLGwsLCvraijnpuanJ+lrLO4uLKllYV4bmhlZWdqgoKBgYB/fXx9gIWLj5GRj46NjIuJh4eIio2RlZibnqKmq6+ytLW2trWxq6aioaKlqa60ubiypZOBcWdgXFlWU1J3dnZ2d3d1dHN1eoCFiIqLjI2NjIqIh4eJjJCUmJueoqWqrrK1uLq6uLOtqKanqq2xtrq7uK2ciHVoYV5cWVROSGtrbG5xcnJwb3F1e4GGiYyPkJCOjIqJiYqMj5OXm56ipaissLS4urq3sauoqKuusrW4u725rp6Lem9pZ2ZkX1lRaGpuc3d5d3RycnZ9g4mOkpSVlJGPjY2Njo+Rk5ebn6KlqKyvs7a4trKtqaeoq66wsrW5vLqzp5iKf3d0cnFva2V0eX+FiIiEfXl3eoCGjJGVl5iXlJKRkZKTk5SWmJyfoqaprK+ytLSxrailpaaoqqutsLS3t7OroJWLgnx6ent7eI6TmJycmZGJgn+Ag4eMj5OVl5eWlJSUlZaXl5ianJ6hpairrrCwrqunpKOio6Slp6mrra6tqaSdlYyEfnx+gYODq62vr62nn5ePi4qKi4yNkJOWmJiXlpWVlpiYmJmam56hpKiqq6uppqSioaGhoaKkpqemop6ZlZGMhoB9fYCFiInAv768ubSuqKKdmpeVk5KTlpmcnZ2bmZmam5uamZiZmp2go6WmpaSioqGhoJ+fn6Kjop2Wj4uIhoN/fHx/hYqNjcvJx8XDwLy4s6+qpqKenJudn6KkpaSjo6SkpKOhn52dnp+goaGhoKCgoKCfnJubm5uYkoqFgoKBfnx7foSLkJKS0c7MysrIxcG9uLSwq6ikoqKjpairra6vsbKzsa+sqqimpKKhoJ+enp2dnZqXlJOSkIyGgX9/gIB+fX+EjJKVlZTV0c7My8rHw7+7uLWxrqqmo6Kjp6yws7a4uru6ube1s6+rp6Ohn52bmZiXlZGNioiFgX58fH+AgH+Aho+XmpmVk9jSzcvJx8TBvry7ubezrqmkoaCjqK2wsrS1tra2t7e2s6+rpqKem5eUkpGPjImFgn98ent9gIB/f4SOmqKinJSQ2dLMycbDwb++vr++vbm1r6ijoaGkp6mpqampqaqsr7Cwrqqmop2Yko6Mi4qJhoOAfnt6e32Af35/hpOgp6adkozW0czHxMG+vL2/wcHAvbm0rqijoqKjo6Kgn56foKKlqKmpp6Ogm5SOiYaGhYWDgX99e3p6fH5+fX+FkZ6lo5qQitPPy8bCvru6u77BwsG+u7axq6aioaCfnpycnJydnqCio6Ohn5uXkYqFgoGBgX99fHt6eXl6fHx8foONl52clY2I0c7KxcC9urq7vsHCwb67t7KtqKSioJ+enJydnp6enp+enpyalpKNiIOAgH9+fHp5eXl4eHh6e3x+goiPlZWRjIfRzsrFwb28vL3AwsLBvru4tbCrp6WjoqCfnp6fn56dm5qYlpSRjoqGg4CAf358enh4eXl4d3h5fH6Ch4yQkpCMiNHPzMjEwb++vr+/v728u7q4tLCsqqmnpaOgoJ+fnZqYlZORj4yKiIWDgH9/fn16eHh5eXh2dnd7gIWJjZCSkY2I';

let cells: Uint8Array | undefined;

function grid(): Uint8Array {
  cells ??= Uint8Array.from(atob(GRID), (c) => c.charCodeAt(0));
  return cells;
}

/** Ondulation du géoïde (m) en un point : hauteur ellipsoïdale - altitude au-dessus du niveau de la mer. */
export function geoidUndulation(lon: number, lat: number): number {
  const g = grid();
  const x = Math.min(COLS - 1, Math.max(0, (lon - WEST) / STEP));
  const y = Math.min(ROWS - 1, Math.max(0, (NORTH - lat) / STEP));
  const x0 = Math.min(COLS - 2, Math.floor(x));
  const y0 = Math.min(ROWS - 2, Math.floor(y));
  const fx = x - x0;
  const fy = y - y0;
  const at = (cx: number, cy: number) => g[cy * COLS + cx]! / 8 + 30;
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}
