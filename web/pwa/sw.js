/*
 * Service worker de Vigie. Modèle : `web/pwa/sw.js`, complété au build par `web/pwa/plugin.mjs`
 * (liste des fichiers de la coque et version) pour donner `dist/sw.js`.
 *
 * Il ne garde que la COQUE de l'application (page d'accueil et fichiers de assets/, nommés d'après
 * leur contenu), pour que le site s'ouvre sans réseau. Tout le reste passe sans que le service worker
 * s'en mêle : /api/* (données en direct, flux, tuiles de l'application), tuiles et ressources
 * d'autres sites (fonds de carte, 3D, GIBS…), manifeste, icônes.
 *
 * Une réponse n'entre dans le cache que si elle est un 200 sans redirection du site même : derrière
 * Cloudflare Access, une session expirée renvoie une redirection vers la page de connexion, qu'il ne
 * faut ni garder ni masquer.
 */
const VERSION = '__VERSION__';
const PREFIX = 'vigie-coque-';
const CACHE = PREFIX + VERSION;
const PAGE = '/';
const SHELL = __PRECACHE__;

/** Une réponse qu'on peut garder : un vrai 200 du site, pas une redirection ni une erreur. */
function storable(response) {
  return response.status === 200 && response.type === 'basic' && !response.redirected;
}

async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(
    SHELL.map(async (url) => {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      // Un seul fichier refusé (session expirée, serveur en panne) annule l'installation : l'ancienne version reste en service.
      if (!storable(response)) throw new Error(`${url} : réponse ${response.status} inutilisable`);
      await cache.put(url, response);
    }),
  );
}

self.addEventListener('install', (event) => {
  // Pas de skipWaiting ici : la nouvelle version attend que l'utilisateur accepte « Recharger ».
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** Réseau d'abord ; la coque en cache seulement si le réseau est coupé ou le serveur injoignable (502 à 504). */
async function navigate(request) {
  const shell = () => caches.match(PAGE, { cacheName: CACHE });
  try {
    const response = await fetch(request);
    if (response.status >= 502 && response.status <= 504) return (await shell()) ?? response;
    // Redirections (Cloudflare Access) et autres réponses : telles quelles, le navigateur les suit.
    return response;
  } catch (error) {
    const cached = await shell();
    if (cached) return cached;
    throw error;
  }
}

/** Fichier de la coque : le cache d'abord (il est nommé d'après son contenu), sinon le réseau, sans rien stocker. */
async function asset(request, pathname) {
  const cached = await caches.match(pathname, { cacheName: CACHE });
  return cached ?? fetch(request);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.well-known/')) return;
  if (request.mode === 'navigate') return event.respondWith(navigate(request));
  if (url.pathname.startsWith('/assets/')) return event.respondWith(asset(request, url.pathname));
});
