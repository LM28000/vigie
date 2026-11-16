/**
 * Module « Vue photoréaliste » : les Google Photorealistic 3D Tiles (maillages texturés tirés de photos aériennes), servis
 * par Cesium ion et dessinés par le `Tile3DLayer` de deck.gl. Le maillage remplace les bâtiments extrudés et leurs ombres
 * (ils sont masqués tant qu'il est affiché) et contient déjà le sol.
 *
 * - **Accès.** Le jeton Cesium ion reste sur le serveur : le site demande `/api/photoreal/endpoint` et reçoit l'adresse du
 *   jeu de tuiles (avec la clé de session d'ion, faite pour le navigateur) et les mentions à afficher. Sans jeton, le serveur
 *   répond 503 et la couche affiche l'erreur. Les tuiles sont chargées directement chez Google par le navigateur, jamais mises
 *   en cache par Vigie (conditions de Google).
 * - **Zoom.** Le maillage n'est demandé qu'à partir d'un zoom réglable (14 par défaut) : plus loin, il faudrait charger des
 *   centaines de tuiles pour un rendu que le fond de carte fait aussi bien. Le niveau de détail est réglé par
 *   `maximumScreenSpaceError` : plus grossier sur téléphone, avec un plafond de mémoire plus bas.
 * - **Altitudes.** Voir `photorealLayer.ts` (géoïde) et `map/baseMap.ts` (`setPhotorealShown`).
 * - **Crédits.** Les logos et mentions d'ion et de Google sont affichés tant que le maillage l'est, avec les mentions de droits
 *   d'auteur des tuiles à l'écran (fournisseurs des photos).
 * - **Nuit.** Les photos ont leur propre éclairage, on ne peut que les assombrir : voir `nightTint`.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import { defineModule, type LegendItem, type LoadContext, type RenderContext } from '../core/module';
import { ModuleManager } from '../core/moduleManager';
import { setPhotorealShown } from '../map/baseMap';
import './photoreal.css';
import { SeaLevelScenegraphLayer, Tile3DLayer, tileCopyright } from './photorealLayer';

/** Décodeur Draco servi par le site (public/draco/) : loaders.gl irait sinon le chercher chez gstatic.com. */
const DRACO_MODULES = { 'draco_wasm_wrapper.js': '/draco/draco_wasm_wrapper.js', 'draco_decoder.wasm': '/draco/draco_decoder.wasm' };

interface Attribution {
  html: string;
  collapsible?: boolean;
}

interface PhotorealData {
  /** Adresse du `root.json`, avec la clé de session de Cesium ion. */
  url: string;
  attributions: Attribution[];
}

const LAYER_PREFIX = 'photoreal';
const CREDIT_CLASS = 'photoreal-credit';

/** Seuils de zoom proposés au réglage : le module est redessiné quand on en franchit un. */
const ZOOM_BREAKS = [12, 13, 14, 15, 16] as const;
const DEFAULT_MIN_ZOOM = 14;

const isPhone = (): boolean => window.matchMedia?.('(max-width: 719.98px), (pointer: coarse)').matches ?? false;

/** Niveau de détail : erreur d'écran maximale tolérée, en pixels (plus petit = plus fin, plus de tuiles) et plafond de mémoire des tuiles. */
const DETAIL: Record<string, { sse: number; mb: number; requests: number }> = {
  fin: { sse: 8, mb: 384, requests: 48 },
  standard: { sse: 16, mb: 256, requests: 32 },
  econome: { sse: 32, mb: 96, requests: 16 },
};

/** Niveau de détail réellement utilisé : « auto » donne le standard sur ordinateur et l'économe sur téléphone. */
function detailOf(settings: Readonly<Record<string, string>>): string {
  const choice = settings.detail ?? 'auto';
  if (choice in DETAIL) return choice;
  return isPhone() ? 'econome' : 'standard';
}

const minZoomOf = (settings: Readonly<Record<string, string>>): number => Number(settings.zoom) || DEFAULT_MIN_ZOOM;

/** Vrai si le maillage est dessiné pour cette vue. */
function isActive(ctx: RenderContext<PhotorealData>): boolean {
  return ctx.data !== undefined && ctx.view.zoom >= minZoomOf(ctx.settings);
}

/**
 * Assombrissement de la nuit : la photo est multipliée par cette couleur. Le fond de carte de nuit est un bleu-gris sombre
 * (calmStyle) ; on descend à 38 % de la luminosité avec une dominante bleue, pour que les rues et les toits restent lisibles
 * sans le jour sur un fond noir.
 */
function nightTint(night: number): [number, number, number, number] {
  const k = 1 - 0.62 * night;
  return [Math.round(255 * k * 0.86), Math.round(255 * k * 0.93), Math.round(255 * k), 255];
}

// --- Suivi du chargement (résumé de la couche, crédits) ---

interface TilesetLike {
  stats?: { get(name: string): { count: number } };
  options: { onTraversalComplete?: (tiles: unknown[]) => unknown[] };
}

let tileset: TilesetLike | undefined;
let credits: string[] = [];
let creditsKey = '';

function onTilesetLoad(loaded: TilesetLike): void {
  tileset = loaded;
  loaded.options.onTraversalComplete = (selected) => {
    const found = new Set<string>();
    for (const tile of selected) for (const mention of tileCopyright(tile as Parameters<typeof tileCopyright>[0])) found.add(mention);
    const sorted = [...found].sort();
    const key = sorted.join('|');
    if (key !== creditsKey) {
      creditsKey = key;
      credits = sorted;
      renderCredits();
    }
    return selected;
  };
}

function statCount(name: string): number {
  return tileset?.stats?.get(name).count ?? 0;
}

// --- Crédits (logos et mentions obligatoires) ---

let creditElement: HTMLElement | undefined;
let attributions: Attribution[] = [];
let creditsShown = false;

/**
 * Convertit le HTML des mentions renvoyé par Cesium ion en éléments sûrs : seuls `span`, `a` (https) et `img`
 * (images hébergées par Cesium) sont gardés, sans style ni script.
 */
function safeNodes(html: string): Node[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const convert = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent ?? '');
    if (!(node instanceof HTMLElement)) return null;
    const tag = node.tagName.toLowerCase();
    if (tag === 'img') {
      const src = node.getAttribute('src') ?? '';
      if (!/^https:\/\/assets\.ion\.cesium\.com\//.test(src)) return null;
      const img = document.createElement('img');
      img.src = src;
      img.alt = node.getAttribute('alt') ?? '';
      return img;
    }
    if (tag !== 'span' && tag !== 'a') return null;
    const element = document.createElement(tag);
    if (tag === 'a') {
      const href = node.getAttribute('href') ?? '';
      if (!/^https:\/\//.test(href)) return null;
      (element as HTMLAnchorElement).href = href;
      (element as HTMLAnchorElement).target = '_blank';
      (element as HTMLAnchorElement).rel = 'noopener noreferrer';
    }
    for (const child of node.childNodes) {
      const converted = convert(child);
      if (converted) element.append(converted);
    }
    return element;
  };
  return [...doc.body.childNodes].map(convert).filter((n): n is Node => n !== null);
}

function renderCredits(): void {
  const element = creditElement;
  if (!element) return;
  element.hidden = !creditsShown;
  if (!creditsShown) return;
  element.replaceChildren();
  const logos = document.createElement('span');
  logos.className = `${CREDIT_CLASS}__logos`;
  for (const attribution of attributions) {
    const item = document.createElement('span');
    item.append(...safeNodes(attribution.html));
    logos.append(item);
  }
  element.append(logos);
  if (credits.length > 0) {
    const data = document.createElement('span');
    data.className = `${CREDIT_CLASS}__data`;
    data.textContent = `Imagerie : ${credits.join(', ')}`;
    element.append(data);
  }
}

function showCredits(show: boolean): void {
  if (show === creditsShown && creditElement) return;
  creditsShown = show;
  renderCredits();
}

// --- Le module ---

async function load({ signal }: LoadContext): Promise<PhotorealData> {
  const response = await fetch('/api/photoreal/endpoint', { signal });
  if (response.status === 503) throw new Error('Vue photoréaliste indisponible : le serveur n’a pas de jeton Cesium ion (CESIUM_ION_TOKEN)');
  if (!response.ok) throw new Error(`Vue photoréaliste indisponible : Cesium ion ne répond pas (${response.status})`);
  const json = (await response.json()) as { url: string; attributions?: Attribution[] };
  attributions = json.attributions ?? [];
  return { url: json.url, attributions };
}

export const photoreal = defineModule<PhotorealData>({
  id: 'photoreal',
  name: 'Vue photoréaliste',
  category: 'territoire',
  description:
    'Les villes et les paysages en maillage 3D texturé d’après des photos aériennes (Google Photorealistic 3D Tiles, via Cesium ion), à partir du zoom 14 (réglable). Remplace les bâtiments extrudés et leurs ombres ; les couches (avions, trains, bus…) restent posées dessus. Charge de nombreuses tuiles : à réserver aux bonnes connexions.',
  attribution: 'Google Photorealistic 3D Tiles (© Google, imagerie Airbus, Maxar Technologies et autres), via Cesium ion',
  drawOrder: -50,
  // Rien à rejouer dans le temps : seule la nuit (par huitièmes) et les franchissements de zoom redessinent.
  timeStepMs: 600_000,
  zoomBreaks: ZOOM_BREAKS,
  load,
  // L'adresse ne change que si le serveur ouvre une nouvelle session (toutes les demi-heures au plus) : on la relit rarement,
  // car changer d'adresse recharge tout le maillage.
  refreshIntervalMs: 2 * 60 * 60_000,

  settings: [
    {
      id: 'zoom',
      label: 'Affichée à partir du zoom',
      defaultValue: String(DEFAULT_MIN_ZOOM),
      options: [12, 13, 14, 15, 16].map((v) => ({ value: String(v), label: String(v) })),
    },
    {
      id: 'detail',
      label: 'Détail',
      defaultValue: 'auto',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'fin', label: 'Fin' },
        { value: 'standard', label: 'Standard' },
        { value: 'econome', label: 'Économe' },
      ],
    },
  ],

  legend(): LegendItem[] {
    return [{ color: 'var(--ui-muted)', label: 'Maillage 3D de Google : photos aériennes, sol et bâtiments compris' }];
  },

  summary(ctx) {
    if (!ctx.data) return null;
    const minZoom = minZoomOf(ctx.settings);
    if (ctx.view.zoom < minZoom) return `Approchez-vous (zoom ${minZoom} ou plus) pour voir le maillage 3D de Google`;
    const inView = statCount('Tiles In View');
    const mb = Math.round(statCount('Tile Memory Use') / (1024 * 1024));
    return inView > 0 ? `${inView} tuiles à l’écran · ${mb} Mo de maillages en mémoire` : 'Chargement du maillage 3D de Google…';
  },

  deckLayers(ctx) {
    if (!isActive(ctx) || !ctx.data) return [];
    const detail = detailOf(ctx.settings);
    const options = DETAIL[detail]!;
    return [
      new Tile3DLayer({
        // Un autre niveau de détail demande un autre jeu de tuiles (la tolérance est lue au chargement) : autre identifiant.
        id: `${LAYER_PREFIX}/tuiles-${detail}`,
        data: ctx.data.url,
        pickable: false,
        loadOptions: { modules: DRACO_MODULES, tileset: { maximumScreenSpaceError: options.sse, maximumMemoryUsage: options.mb, maxRequests: options.requests } },
        onTilesetLoad: (loaded) => onTilesetLoad(loaded as unknown as TilesetLike),
        onTileError: (tile, message) => console.warn('[photoreal] tuile en erreur', message, tile.id),
        // La nuit est un simple assombrissement : voir `nightTint`.
        _subLayerProps: { scenegraph: { type: SeaLevelScenegraphLayer, getColor: nightTint(ctx.night) } },
        parameters: { depthCompare: 'less-equal', depthWriteEnabled: true, cullMode: 'none' },
      }),
    ];
  },

  native: {
    add(map: MapLibreMap) {
      const element = document.createElement('div');
      element.className = CREDIT_CLASS;
      element.hidden = true;
      map.getContainer().append(element);
      creditElement = element;
    },
    update(map, ctx) {
      const active = isActive(ctx);
      if (setPhotorealShown(map, active)) ModuleManager.current?.refresh('ombres-batiments');
      attributions = ctx.data?.attributions ?? attributions;
      showCredits(active);
    },
    remove(map) {
      if (setPhotorealShown(map, false)) ModuleManager.current?.refresh('ombres-batiments');
      creditElement?.remove();
      creditElement = undefined;
      creditsShown = false;
      tileset = undefined;
      credits = [];
      creditsKey = '';
    },
  },
});
