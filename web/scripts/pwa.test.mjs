// Tests de l'application installable : plugin de build (liste de la coque, version), service worker (ce qu'il intercepte et garde), logique d'installation.
// Lancer : node --test web/scripts/pwa.test.mjs   (Node 22.18 ou plus : les .ts s'importent tels quels)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { renderServiceWorker, shellFiles, shellVersion } from '../pwa/plugin.mjs';
import { canRegisterServiceWorker, isIos, isIosSafari, isStandalone } from '../src/core/pwaLogic.ts';

const TEMPLATE = readFileSync(new URL('../pwa/sw.js', import.meta.url), 'utf8');

test('la coque : la page et les fichiers de assets/ utiles, triés, sans cartes sources ni woff', () => {
  const files = shellFiles([
    'index.html',
    'assets/index-B.js',
    'assets/a-A.js',
    'assets/index-B.css',
    'assets/police-C.woff2',
    'assets/police-C.woff',
    'assets/index-B.js.map',
    'assets/image-D.png',
    'sw.js',
  ]);
  assert.deepEqual(files, ['/', '/assets/a-A.js', '/assets/index-B.css', '/assets/index-B.js', '/assets/police-C.woff2']);
});

test('la version change avec la page ou avec un fichier, pas autrement', () => {
  const a = shellVersion(['/', '/assets/x-1.js'], '<html>1</html>');
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(a, shellVersion(['/', '/assets/x-1.js'], '<html>1</html>'));
  assert.notEqual(a, shellVersion(['/', '/assets/x-2.js'], '<html>1</html>'));
  assert.notEqual(a, shellVersion(['/', '/assets/x-1.js'], '<html>2</html>'));
});

/** Charge le service worker rempli dans un bac à sable avec un faux cache et un faux réseau. */
function loadWorker({ network }) {
  const files = ['/', '/assets/app-1.js'];
  const source = renderServiceWorker(TEMPLATE, files, 'v1');
  const listeners = {};
  const stores = new Map();
  const cacheOf = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const map = stores.get(name);
    return { put: async (url, response) => void map.set(url, response), match: async (url) => map.get(url) };
  };
  const fetched = [];
  const context = {
    URL,
    Request: class {
      constructor(url, init) {
        this.url = url;
        Object.assign(this, init);
      }
    },
    Response,
    Error,
    self: {
      location: new URL('https://vigie.test/'),
      addEventListener: (type, fn) => void (listeners[type] = fn),
      skipWaiting: () => void (context.skipped = true),
      clients: { claim: async () => undefined },
    },
    caches: {
      open: async (name) => cacheOf(name),
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name),
      match: async (url, { cacheName }) => stores.get(cacheName)?.get(url)?.clone(), // le vrai cache rend une copie à chaque lecture
    },
    fetch: async (request) => {
      const url = typeof request === 'string' ? request : request.url;
      fetched.push(url);
      return network(url);
    },
  };
  vm.runInNewContext(source, context);
  const run = async (type, init) => {
    let promise;
    const event = { ...init, waitUntil: (p) => (promise = p), respondWith: (p) => (promise = p) };
    listeners[type](event);
    return promise === undefined ? undefined : promise;
  };
  const ask = (url, mode = 'cors', method = 'GET') => {
    let handled = false;
    let promise;
    listeners.fetch({ request: { url, mode, method }, respondWith: (p) => ((handled = true), (promise = p)) });
    return { handled, response: promise };
  };
  return { run, ask, stores, fetched, context };
}

/** Réponses « de site » : type basic, comme celles du réseau pour une page du même domaine. */
const basic = (body, init = {}) => {
  const response = new Response(body, init);
  Object.defineProperty(response, 'type', { value: 'basic' });
  return response;
};

test('install : la coque est gardée ; une redirection (Cloudflare Access) annule l’installation', async () => {
  const ok = loadWorker({ network: (url) => basic(`corps ${url}`) });
  await ok.run('install');
  const kept = ok.stores.get('vigie-coque-v1');
  assert.deepEqual([...kept.keys()], ['/', '/assets/app-1.js']);

  const redirected = loadWorker({
    network: (url) => {
      const response = basic('connexion');
      Object.defineProperty(response, 'redirected', { value: url === '/' });
      return response;
    },
  });
  await assert.rejects(redirected.run('install'), /inutilisable/);

  const refused = loadWorker({ network: () => basic('non', { status: 403 }) });
  await assert.rejects(refused.run('install'), /inutilisable/);
});

test('activate : les caches des anciennes versions sont supprimés, pas ceux des autres', async () => {
  const worker = loadWorker({ network: (url) => basic(url) });
  worker.stores.set('vigie-coque-v0', new Map());
  worker.stores.set('autre-chose', new Map());
  await worker.run('install');
  await worker.run('activate');
  assert.deepEqual([...worker.stores.keys()].sort(), ['autre-chose', 'vigie-coque-v1']);
});

test('fetch : /api, ressources d’autres sites, POST et fichiers hors coque ne sont pas interceptés', () => {
  const worker = loadWorker({ network: (url) => basic(url) });
  assert.equal(worker.ask('https://vigie.test/api/trains?from=1&to=2').handled, false);
  assert.equal(worker.ask('https://vigie.test/api/tuiles/pop/1/5/16/11/8').handled, false);
  assert.equal(worker.ask('https://vigie.test/api/trains', 'navigate').handled, false);
  assert.equal(worker.ask('https://vigie.test/.well-known/assetlinks.json', 'navigate').handled, false);
  assert.equal(worker.ask('https://tile.openstreetmap.org/5/16/11.png').handled, false);
  assert.equal(worker.ask('https://tile.test/', 'navigate').handled, false);
  assert.equal(worker.ask('https://vigie.test/manifest.webmanifest').handled, false);
  assert.equal(worker.ask('https://vigie.test/icons/icon-192.png').handled, false);
  assert.equal(worker.ask('https://vigie.test/api/veille', 'cors', 'POST').handled, false);
  assert.deepEqual(worker.fetched, []);
});

test('fetch : fichiers de assets/ depuis le cache, sinon le réseau sans rien stocker', async () => {
  const worker = loadWorker({ network: (url) => basic(`réseau ${url}`) });
  await worker.run('install');
  worker.fetched.length = 0;
  const hit = worker.ask('https://vigie.test/assets/app-1.js');
  assert.equal(hit.handled, true);
  assert.match(await (await hit.response).text(), /^corps|réseau/); // la coque en cache
  assert.deepEqual(worker.fetched, []);

  const miss = worker.ask('https://vigie.test/assets/nouveau-9.js');
  assert.match(await (await miss.response).text(), /^réseau /);
  assert.deepEqual([...worker.stores.get('vigie-coque-v1').keys()], ['/', '/assets/app-1.js']);
});

test('fetch : navigation en réseau d’abord, coque en cache hors ligne, redirection suivie telle quelle', async () => {
  let online = true;
  let reply = () => basic('page du réseau');
  const worker = loadWorker({
    network: (url) => {
      if (url === '/' || url === '/assets/app-1.js') return basic(`coque ${url}`);
      if (!online) throw new TypeError('Failed to fetch');
      return reply();
    },
  });
  await worker.run('install');

  const live = worker.ask('https://vigie.test/?x=1', 'navigate');
  assert.equal(await (await live.response).text(), 'page du réseau');

  online = false;
  const offline = worker.ask('https://vigie.test/', 'navigate');
  assert.equal(await (await offline.response).text(), 'coque /');

  // Serveur injoignable derrière le tunnel (502) : la coque, plutôt qu'une page d'erreur.
  online = true;
  reply = () => basic('Bad gateway', { status: 502 });
  assert.equal(await (await worker.ask('https://vigie.test/', 'navigate').response).text(), 'coque /');

  // Un 403 ou une redirection de connexion ne sont ni remplacés ni gardés : le navigateur les suit.
  reply = () => basic('refusé', { status: 403 });
  const refused = await (await worker.ask('https://vigie.test/', 'navigate').response);
  assert.equal(refused.status, 403);
  assert.deepEqual([...worker.stores.get('vigie-coque-v1').keys()], ['/', '/assets/app-1.js']);
});

test('message SKIP_WAITING : la nouvelle version prend la main', async () => {
  const worker = loadWorker({ network: (url) => basic(url) });
  await worker.run('message', { data: { type: 'SKIP_WAITING' } });
  assert.equal(worker.context.skipped, true);
  const other = loadWorker({ network: (url) => basic(url) });
  await other.run('message', { data: { type: 'autre' } });
  assert.equal(other.context.skipped, undefined);
});

test('installation : détection iOS, Safari, mode autonome, enregistrement', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
  assert.equal(isIos(iphone, 'iPhone', 5), true);
  assert.equal(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5), true); // iPad qui se dit Mac
  assert.equal(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0), false);
  assert.equal(isIos('Mozilla/5.0 (Linux; Android 15)', 'Linux armv8l', 5), false);
  assert.equal(isIosSafari(iphone), true);
  assert.equal(isIosSafari(iphone.replace('Version/18.0', 'CriOS/130.0')), false);
  assert.equal(isStandalone({ displayStandalone: true, iosStandalone: false }), true);
  assert.equal(isStandalone({ displayStandalone: false, iosStandalone: true }), true);
  assert.equal(isStandalone({ displayStandalone: false, iosStandalone: false }), false);
  assert.equal(canRegisterServiceWorker({ prod: true, secure: true, supported: true }), true);
  assert.equal(canRegisterServiceWorker({ prod: false, secure: true, supported: true }), false); // développement
  assert.equal(canRegisterServiceWorker({ prod: true, secure: false, supported: true }), false); // HTTP sur le réseau local
  assert.equal(canRegisterServiceWorker({ prod: true, secure: true, supported: false }), false);
});
