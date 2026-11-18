import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TEMPLATE = fileURLToPath(new URL('./sw.js', import.meta.url));

/**
 * Fichiers de la coque : la page d'accueil et les fichiers de assets/ du build (JS, CSS, polices
 * `woff2`). Ni les cartes sources, ni les polices `woff` (un navigateur qui a des service workers
 * lit le `woff2`), ni le reste de public/ (décodeurs, icônes) qui se charge à la demande.
 */
export function shellFiles(fileNames) {
  return ['/', ...fileNames.filter((name) => name.startsWith('assets/') && /\.(js|css|woff2)$/.test(name)).sort().map((name) => `/${name}`)];
}

/** Version du service worker : change si la page ou l'un des fichiers (nommés d'après leur contenu) change. */
export function shellVersion(files, indexHtml) {
  return createHash('sha256').update(files.join('\n')).update('\0').update(indexHtml).digest('hex').slice(0, 12);
}

/** Remplit le modèle : version du build et liste des fichiers à garder. */
export function renderServiceWorker(template, files, version) {
  return template.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(files, null, 2));
}

/** Plugin Vite : à la fin du build, écrit `sw.js` à la racine du site construit. Pas de service worker en développement. */
export function serviceWorker() {
  return {
    name: 'vigie-service-worker',
    apply: 'build',
    enforce: 'post',
    writeBundle(options, bundle) {
      const html = bundle['index.html'];
      if (!html || !options.dir) return;
      const files = shellFiles(Object.keys(bundle));
      const version = shellVersion(files, String(html.source));
      writeFileSync(`${options.dir}/sw.js`, renderServiceWorker(readFileSync(TEMPLATE, 'utf8'), files, version));
    },
  };
}
