# Application Android (TWA)

Vigie est publiée sur Android comme une **Trusted Web Activity** : Chrome affiche https://vigie.du-cray.eu en plein écran, sans barre d'adresse. Le code de l'app est le site lui-même ; chaque déploiement du site met l'app à jour, sans republier.

Seul `twa-manifest.json` est suivi par git. Le projet Gradle (`app/`, `gradle/`, `build.gradle`…) est régénéré par Bubblewrap, et la clé de signature n'est **jamais** dans le dépôt.

## Outils (Mac)

- Bubblewrap installé dans `~/.local/bubblewrap` (`~/.local/bubblewrap/node_modules/.bin/bubblewrap`).
- `~/.bubblewrap/config.json` : JDK 17 (`/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk`, Bubblewrap n'accepte que la 17) et un SDK `/Users/Shared/bubblewrap-sdk` (chemin sans espace : Bubblewrap ne met pas de guillemets autour d'apksigner) fait de liens vers `/Users/Shared/Android/sdk`, plus `tools` → `cmdline-tools/latest` (Bubblewrap exige ce dossier).

## Régénérer le projet

Le site est derrière Cloudflare Access : Bubblewrap ne peut pas y lire le manifeste ni les icônes. `twa-manifest.json` les prend donc sur un serveur local :

```sh
(cd web && pnpm build)
(cd web/dist && python3 -m http.server 4317 --bind 127.0.0.1) &   # arrêter ensuite par son PID
cd android && ~/.local/bubblewrap/node_modules/.bin/bubblewrap update --manifest=./twa-manifest.json
# puis remettre la vraie adresse du manifeste dans app/build.gradle (resValue webManifestUrl)
```

## Clé d'envoi et construction

La clé d'envoi (« upload key ») est dans `~/.android-keys/vigie-upload.keystore`, alias `vigie`, et ses mots de passe dans Vaultwarden. Google Play re-signe l'app avec sa propre clé (signature des apps par Google Play).

```sh
cd android && ~/.local/bubblewrap/node_modules/.bin/bubblewrap build   # demande les mots de passe → app-release-bundle.aab
```

Chaque nouvelle version envoyée au Play Store demande d'augmenter `appVersionCode` dans `twa-manifest.json`.

## Digital Asset Links

`web/public/.well-known/assetlinks.json` doit contenir le paquet `eu.ducray.vigie` et l'empreinte SHA-256 de la **clé de signature de Google Play** (Play Console → Test et publication → Configuration → Intégrité de l'application). Le fichier doit être lisible sans connexion : application Cloudflare Access « Bypass » sur `vigie.du-cray.eu/.well-known/assetlinks.json`. Sans cela, l'app s'ouvre avec une barre d'adresse.
