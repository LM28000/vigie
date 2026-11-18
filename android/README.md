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

La clé d'envoi (« upload key ») est dans `~/.android-keys/vigie-upload.keystore`, alias `vigie`, et son mot de passe dans Vaultwarden. Google Play re-signe l'app avec sa propre clé (signature des apps par Google Play).

**Ne pas signer avec `bubblewrap build`** : en cas d'erreur, il affiche la commande `apksigner` avec le mot de passe en clair. On construit sans signer, puis on signe avec des outils qui demandent le mot de passe sans l'afficher :

```sh
cd android
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=/Users/Shared/bubblewrap-sdk
./gradlew assembleRelease bundleRelease && ./gradlew --stop
# bundle pour le Play Store
/opt/homebrew/opt/openjdk@17/bin/jarsigner -keystore ~/.android-keys/vigie-upload.keystore \
  -signedjar app-release-bundle.aab app/build/outputs/bundle/release/app-release.aab vigie
# APK à installer directement (facultatif)
/Users/Shared/bubblewrap-sdk/build-tools/36.1.0/zipalign -f 4 app/build/outputs/apk/release/app-release-unsigned.apk app-release-unsigned-aligned.apk
/Users/Shared/bubblewrap-sdk/build-tools/36.1.0/apksigner sign --ks ~/.android-keys/vigie-upload.keystore \
  --ks-key-alias vigie --out app-release-signed.apk app-release-unsigned-aligned.apk
```

C'est `android/app-release-bundle.aab` (signé) qu'on envoie, pas `app/build/outputs/bundle/release/app-release.aab` (non signé, refusé par la console). Chaque nouvelle version demande d'augmenter `appVersionCode` (et `versionCode` dans `app/build.gradle`). Après un changement de chemin du SDK, arrêter le démon Gradle (`./gradlew --stop`) et supprimer `app/build`, sinon « Unable to find package java.lang ».

L'app est publiée sur le canal **test interne** de la Play Console.

## Digital Asset Links

`web/public/.well-known/assetlinks.json` doit contenir le paquet `eu.ducray.vigie` et l'empreinte SHA-256 de la **clé de signature de Google Play** (Play Console → Test et publication → Configuration → Intégrité de l'application). Le fichier doit être lisible sans connexion : application Cloudflare Access « Bypass » sur `vigie.du-cray.eu/.well-known/assetlinks.json`. Sans cela, l'app s'ouvre avec une barre d'adresse.

Si la barre d'adresse reste affichée sur la carte, vérifier l'empreinte **réelle** de l'app installée depuis Play (celle notée dans la console peut être une autre ; c'est arrivé) : téléphone branché en débogage USB,

```sh
adb shell pm path --user 0 eu.ducray.vigie          # chemins des APK installés
adb pull <chemin de base.apk> /tmp/vigie-base.apk
/Users/Shared/bubblewrap-sdk/build-tools/36.1.0/apksigner verify --print-certs /tmp/vigie-base.apk | grep SHA-256
```

Ajouter l'empreinte (en majuscules, octets séparés par `:`) à `assetlinks.json` et à `fingerprints` dans `twa-manifest.json`, déployer, attendre que l'API de Google réponde `"linked": true` (voir [docs/deploiement.md](../docs/deploiement.md)), puis effacer les données de l'app sur le téléphone : Chrome garde en mémoire l'échec de la vérification.

## Fiche Play Store

Textes, réponses aux formulaires de la Console et visuels : [fiche-play/fiche.md](fiche-play/fiche.md). La politique de confidentialité est `web/public/confidentialite.html` (servie à `/confidentialite.html`, règle Access « Bypass » nécessaire). Restent à fournir : l'adresse de contact (`CONTACT_A_COMPLETER`) et un compte de test pour les examinateurs de Google.
