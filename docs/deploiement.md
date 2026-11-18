# Déploiement

Le serveur tourne en permanence dans Docker (`compose.yaml`, `server/Dockerfile`) : il archive le temps réel en continu, enregistre l'historique des couches mobiles et sert le site. Rien n'est exposé à Internet par défaut.

> Le projet s'appelle Vigie depuis novembre 2026 (anciennement « Carte vivante »). Les identifiants techniques gardent l'ancien nom pour ne rien casser en production : nom du projet et de l'image Docker (`carte-vivante`, `carte-vivante-serveur`), exécutable `carte-vivante-serveur`, clés `localStorage` du navigateur (`carte-vivante:*`).

```mermaid
flowchart LR
  subgraph Image["Image Docker (build multi-étapes)"]
    W["Étape 1 : node + pnpm<br/>pnpm build → web/dist"] --> F
    R["Étape 2 : rust<br/>cargo build --release"] --> F
    F["Étape 3 : debian slim<br/>binaire + site (/web)"]
  end
  F --> C["Conteneur<br/>lecture seule, sans privilège"]
  C --- D[("/data<br/>sources, tuiles, caches")]
  C --- A[("/archive<br/>historique, flux SNCF")]
```

L'image se construit depuis la racine du dépôt (contexte `.`). Étapes du `server/Dockerfile` : Node 24 et pnpm 12.8.1 construisent le site, Rust 1.94 compile le serveur (les dépendances d'abord, pour garder le cache Docker), puis une image Debian `trixie-slim` avec les certificats ne contient que le binaire et le site. Le conteneur ne tourne jamais en administrateur.

## Installation

```bash
git clone https://github.com/LM28000/vigie.git vigie && cd vigie
mkdir -p data archive              # avant le premier démarrage : sinon Docker les crée au nom de root
cat > .env <<EOF
BIND_ADDRESS=192.168.0.75          # adresse d'écoute (127.0.0.1 par défaut : la machine seule)
RUN_AS=1000:1000                   # utilisateur:groupe propriétaire de data/ et archive/
ARCHIVE_PATH=./archive             # où garder les archives (environ 50 Mo par jour)
EOF
# Facultatif, couche « Bateaux » : clé gratuite d'aisstream.io, saisie sans l'afficher.
read -rsp "Clé aisstream : " k && printf 'AISSTREAM_API_KEY=%s\n' "$k" >> .env && chmod 600 .env && unset k
# Facultatif, couche « Qualité de l'air » : compte gratuit Atmo Data (admindata.atmo-france.org).
# Le conteneur doit recevoir ATMO_USERNAME et ATMO_PASSWORD (comme AISSTREAM_API_KEY) ; entre apostrophes.
read -rp "Identifiant Atmo Data : " u && printf "ATMO_USERNAME='%s'\n" "$u" >> .env
read -rsp "Mot de passe Atmo Data : " p && printf "ATMO_PASSWORD='%s'\n" "$p" >> .env && chmod 600 .env && unset u p
# Facultatif, métro, RER, Transilien et tramways d'Île-de-France : clé gratuite de la plateforme PRIM
# (prim.iledefrance-mobilites.fr, quota de 1 000 requêtes par jour, dont la carte n'en prend que 480).
read -rsp "Clé PRIM : " k && printf "IDFM_PRIM_API_KEY='%s'\n" "$k" >> .env && chmod 600 .env && unset k
# Facultatif, webcams Windy de la couche « Caméras » : clé gratuite (api.windy.com/keys), saisie sans l'afficher.
read -rsp "Clé Windy Webcams : " k && printf "WINDY_WEBCAMS_KEY='%s'\n" "$k" >> .env && chmod 600 .env && unset k
# Facultatif, couche « Neige et avalanches » : clé du portail API Météo-France (portail-api.meteofrance.fr ; abonnements « BRA » et « Observation »).
read -rsp "Clé Météo-France : " k && printf "METEOFRANCE_API_KEY='%s'\n" "$k" >> .env && chmod 600 .env && unset k
docker compose up -d --build       # installer, ou mettre à jour après un git pull
docker compose logs -f             # suivre les journaux
```

Le conteneur est isolé : son système de fichiers est en lecture seule, il n'a aucun privilège, sa mémoire est limitée à 1 Go (le pic mesuré est de 540 Mo) et ses journaux sont bornés à 30 Mo. Il n'écoute que sur l'adresse choisie et n'est pas exposé à Internet.

Les archives sont rangées dans `archive/sncf-trip-updates/AAAA-MM-JJ/HHMMSS.pb.gz` (heure UTC), une par version du flux temps réel.

Le fichier `.env` n'est jamais versionné (voir [SECURITY.md](../.github/SECURITY.md)). Le modèle des variables est dans [`.env.example`](../.env.example).

## Variables d'environnement

Toutes les variables lues par le serveur (`grep -rn 'env::var' server/src`), avec leur valeur par défaut. Une variable vide ou absente prend la valeur par défaut. Aucune clé n'est jamais renvoyée au navigateur.

### Serveur

| Variable | Défaut | Rôle |
|---|---|---|
| `HOST` | `127.0.0.1` (`0.0.0.0` dans l'image) | Adresse d'écoute. |
| `PORT` | `8787` | Port d'écoute. |
| `DATA_DIR` | `../data` (`/data` dans l'image) | Où ranger les fichiers téléchargés, les tuiles et les caches. |
| `ARCHIVE_DIR` | aucun (`/archive` dans l'image) | S'il est défini : archive le flux temps réel SNCF et enregistre l'historique des avions, bateaux et transports. |
| `WEB_DIR` | `../web/dist` (`/web` dans l'image) | Site construit à servir à la racine ; ignoré si le dossier ne contient pas `index.html` (l'API seule est alors servie). |
| `RUST_LOG` | `info,tower_http=warn` | Niveau des journaux (syntaxe `tracing`). |
| `HISTORIQUE_JOURS` | `7` | Jours d'historique conservés (de 1 à 365 ; une autre valeur redonne 7). |
| `ARCHIVE_SNCF_JOURS` | `180` | Jours de conservation de l'archive brute du flux SNCF ; `0` = sans limite. |

### Couches qui demandent un compte ou une clé

| Variable | Défaut | Rôle |
|---|---|---|
| `AISSTREAM_API_KEY` | aucune | Clé [aisstream.io](https://aisstream.io) ; sans elle, la couche « Bateaux » est désactivée. |
| `ATMO_USERNAME`, `ATMO_PASSWORD` | aucun | Compte Atmo Data ; sans eux, la couche « Qualité de l'air » est désactivée. |
| `IDFM_PRIM_API_KEY` | aucune | Clé PRIM d'Île-de-France Mobilités ; sans elle, métro, RER, Transilien et tramways d'Île-de-France sont ignorés. |
| `METEOFRANCE_API_KEY` | aucune | Clé du [portail API Météo-France](https://portail-api.meteofrance.fr) (API « Données Publiques BRA » et « Données Publiques Observation »), envoyée dans l'en-tête `apikey` ; sans elle, la couche « Neige et avalanches » dit « clé Météo-France absente » (`/api/neige` répond 503) et le serveur ne fait aucune requête vers Météo-France. Facultatifs, pour les essais : `METEOFRANCE_MAX_REQUETES` (plafond de requêtes par processus), `METEOFRANCE_API_BASE` (autre adresse de l'API, pour rejouer des bulletins). La clé ne sort jamais du serveur. |
| `WINDY_WEBCAMS_KEY` | aucune | Clé [Windy Webcams API](https://api.windy.com/keys) (niveau gratuit) ; sans elle, les webcams Windy de la couche « Caméras » sont désactivées (la fiche et la légende le disent), les caméras Criter et la vidéoprotection d'OpenStreetMap restent disponibles. La clé ne sort jamais du serveur. |

### Île-de-France (PRIM)

| Variable | Défaut | Rôle |
|---|---|---|
| `IDFM_MODES` | `metro,tram,train,cable,bus` | Modes suivis ; les bus coûtent ≈ 50 Mo en permanence et au plus ≈ 60 Mo de pic (voir [couches](couches.md#bus-dîle-de-france--mesures-et-décision)) ; les retirer pour revenir aux seuls modes lourds. |
| `IDFM_INTERVALLE_S` | `180` (minimum `120`) | Intervalle du relevé SIRI, en secondes. |
| `IDFM_MEMOIRE_MO` | `100` | Budget de mémoire du modèle d'Île-de-France. |
| `IDFM_GTFS_URL` | GTFS public d'Île-de-France Mobilités | Adresse du GTFS (doit commencer par `https://`). |

### Transports estimés

| Variable | Défaut | Rôle |
|---|---|---|
| `TRANSPORTS_ESTIMES` | actif | `non` désactive les positions estimées d'après les horaires. |
| `CESIUM_ION_TOKEN` | aucun | Jeton Cesium ion de la vue photoréaliste ; sans lui, le réglage est indisponible. Le navigateur ne le voit jamais : il demande `GET /api/photoreal/endpoint`, le serveur interroge Cesium ion et ne transmet qu'une adresse de tuiles à durée limitée. |
| `TRANSPORTS_DECALAGE_S` | `0` | Décale l'horloge (test hors du direct ; le temps réel est alors ignoré). |
| `DATATOURISME_API_KEY` | aucune | Clé de l'API DATAtourisme v1 de l'exploitant (couche « Événements » ; clé demandée sur <https://www.datatourisme.fr/utiliser-les-donnees>). **Secrète** (`chmod 600 .env`, entre apostrophes) : le serveur l'envoie seulement à l'API, dans l'en-tête `X-API-Key`, sans jamais la journaliser ni la donner au navigateur. Sans elle, ou quand l'API échoue et que le relevé précédent a plus de 48 h, l'export CSV public « fêtes et manifestations » de data.gouv.fr est lu (sans clé, sans horaires ni tarifs). Une lecture complète par jour (quelques centaines de requêtes ; quota de l'API : 1 000 par heure). Détails : [couches.md](couches.md#événements--sources-et-choix). |
| `DATATOURISME_API_URL` | `https://api.datatourisme.fr/v1` | Adresse de base de l'API DATAtourisme, pour un essai sur un autre serveur ; à laisser vide en production. |
| `EVENEMENTS_SOURCES` | `paris,datatourisme,openagenda` | Sources d'événements relevées (liste séparée par des virgules). |

### Isochrones

| Variable | Défaut | Rôle |
|---|---|---|
| `ISO_CARS_TER` | actif | `non` : ignore les Car TER du GTFS SNCF. |
| `ISO_IDF` | actif | `non` : ignore le métro, RER, Transilien et tramways d'Île-de-France. |
| `ISO_CARS_REGIONAUX` | actif | `non` : ignore les cars interurbains régionaux. |
| `ISO_CACHE_MO` | `800` | Taille maximale du cache des GTFS régionaux (`transit-interurbain/`). |
| `ISO_MEMOIRE_MO` | `80` | Budget de mémoire des cars régionaux. |

### Moteur de tuiles

| Variable | Défaut | Rôle |
|---|---|---|
| `TUILES_JEUX` | tous | Liste, séparée par des virgules, des jeux à mettre en service (`population`, `couverture`, `dvf`, `elec-p22t1`…). |
| `TUILES_EFFACER_SOURCES` | non défini | Si défini (n'importe quelle valeur) : efface la source d'un jeu après sa fabrication. |
| `INSEE_CARREAUX_URL` | millésime 2019 de l'INSEE | Adresse du zip des carreaux de population. |
| `ARCEP_OPERATEURS` | tous (`OF,SFR0,BOUY,FREE`) | Restreint les opérateurs (essai réduit ; entre dans l'identifiant de la source). |
| `ARCEP_TECHNOS` | `4g,voix` | Restreint les technologies. |
| `ARCEP_DEPARTEMENTS` | tous | Restreint les départements, ex. `29,22`. |
| `ARCEP_GARDER_SOURCES` | non défini | Si défini : garde les archives 7z de l'ARCEP. |

### Réservées aux tests et mesures (inutiles en production)

`ACCIDENTS_DIR`, `MONUMENTS_CSV`, `IDFM_ZIP`, `IDFM_TOUS_LES_JOURS`, `IDFM_SANS_RAPPROCHEMENT` : lues uniquement par des tests ignorés qui mesurent la mémoire sur de vrais fichiers (voir leurs commentaires dans `server/src/accidents.rs`, `monuments.rs` et `idf/measure.rs`).

### Posées par l'image Docker

`HOST`, `PORT`, `DATA_DIR`, `ARCHIVE_DIR`, `WEB_DIR` et `RUST_LOG` (valeurs ci-dessus), et `MALLOC_ARENA_MAX=2` : la glibc garde une réserve de mémoire par fil d'exécution ; avec tokio et les gros fichiers lus au démarrage, elle gonflait l'empreinte sans la rendre.

### Lues par `compose.yaml` (côté hôte)

| Variable | Défaut | Rôle |
|---|---|---|
| `BIND_ADDRESS` | `127.0.0.1` | Adresse de la machine sur laquelle le port est publié. |
| `PORT` | `8787` | Port publié. |
| `RUN_AS` | `1000:1000` | Utilisateur:groupe du conteneur (propriétaire de `data/` et `archive/`). |
| `DATA_PATH` | `./data` | Dossier monté sur `/data`. |
| `ARCHIVE_PATH` | `./archive` | Dossier monté sur `/archive`. |

`compose.yaml` transmet au conteneur `AISSTREAM_API_KEY`, `ATMO_USERNAME`, `ATMO_PASSWORD`, `IDFM_PRIM_API_KEY`, `WINDY_WEBCAMS_KEY`, `METEOFRANCE_API_KEY`, `DATATOURISME_API_KEY`, `DATATOURISME_API_URL`, `EVENEMENTS_SOURCES`, `IDFM_MODES`, `IDFM_INTERVALLE_S` et `IDFM_MEMOIRE_MO`. Les autres réglages du serveur (`TUILES_*`, `ISO_*`, `HISTORIQUE_JOURS`…) n'y sont pas déclarés : pour les changer dans Docker, il faut les ajouter à la section `environment` de `compose.yaml`.

### Côté site (développement seulement)

| Variable | Défaut | Rôle |
|---|---|---|
| `CARTE_API` | `http://127.0.0.1:8787` | Serveur auquel le proxy de Vite (`pnpm dev`) transmet `/api`. |

## Application installable (PWA) et TWA Android

Le site construit contient `manifest.webmanifest`, les icônes (`icons/`), `sw.js` (service worker, écrit au build par `web/pwa/plugin.mjs` avec la liste des fichiers de la coque et une version tirée de leur contenu) et `.well-known/assetlinks.json`.

- **En-têtes** (`site()` dans `server/src/api.rs`, testés) : `assets/*` en `public, max-age=31536000, immutable` ; tout le reste, dont `index.html`, `sw.js` et `manifest.webmanifest` (`application/manifest+json`), en `no-cache` ; `/.well-known/*` sert le dossier du même nom (JSON en `application/json`) et rend 404 pour un fichier absent, jamais la page d'accueil.
- **Cache du service worker** : seulement la coque (`/` et les fichiers de `assets/`), un cache par version (`vigie-coque-<version>`), les anciens supprimés à l'activation. Navigation : réseau d'abord, coque en cache si le réseau est coupé ou le serveur répond 502 à 504. Jamais interceptés : `/api/*`, `/.well-known/*`, autres sites, manifeste, icônes. Une réponse n'est gardée que si c'est un 200 du site sans redirection (une session Cloudflare Access expirée redirige vers `*.cloudflareaccess.com` : la redirection est suivie par le navigateur, jamais gardée).
- **Cloudflare Access** : `<link rel="manifest" crossorigin="use-credentials">` envoie le cookie `CF_Authorization` avec le manifeste, sinon il serait redirigé vers la page de connexion. Pour une TWA, `/.well-known/assetlinks.json` doit répondre sans connexion : ajouter une règle Access « Bypass » pour ce chemin.
- **TWA (Bubblewrap)** : `web/public/.well-known/assetlinks.json` contient `[]` ; le remplir avec le nom du paquet Android et l'empreinte SHA-256 du certificat de signature de Play, puis reconstruire le site :
  ```json
  [{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"eu.du_cray.vigie","sha256_cert_fingerprints":["AA:BB:..."]}}]
  ```
- **Icônes** : sources dans `design/logos/` ; `sh web/scripts/icones.sh` régénère les PNG (avec `sips`, macOS).
- **Développement** : pas de service worker avec `pnpm dev`. Pour l'essayer : `pnpm build` puis `pnpm exec vite preview` (`localhost` est un contexte sûr).

## Mémoire, disque et réseau

- **Isolation** (`compose.yaml`) : système de fichiers en lecture seule (`/tmp` en `tmpfs`), `cap_drop: ALL`, `no-new-privileges`, `mem_limit: 1g`, `cpus: 2.0`, journaux `json-file` bornés à 3 fichiers de 10 Mo.
- **Budget de mémoire** : la limite du conteneur est de 1 Go ; le pic mesuré était de 540 Mo (ancien README). Mesure plus récente, faite pour les bus d'Île-de-France : le serveur au repos tient autour de 640 Mo avec toutes les couches. Une fabrication de tuiles passe dans un processus enfant dont la mémoire est rendue à la fin, une à la fois ; pics mesurés : 100 Mo (couverture mobile), 138 Mo (élections) et 710 Mo (fabrications de tuiles, d'après la recommandation sur les bus). C'est pour cela que les bus d'Île-de-France sont désactivés par défaut.
- **Volume `data/`** : environ 350 Mo au premier démarrage (horaires SNCF, voies OpenStreetMap, relief), puis les jeux de tuiles : couverture mobile 111 Mo, immobilier 180 Mo, élections environ 380 Mo (cinq archives, davantage avec les municipales), et jusqu'à 520 Mo de cache des cars régionaux. Détails dans [moteur-de-tuiles.md](moteur-de-tuiles.md).
- **Volume `archive/`** : un dossier par couche (`avions/`, `bateaux/`, `transports/`) et `sncf-trip-updates/` (environ 120 Mo par jour, 180 jours par défaut, soit ~22 Go). Voir [historique-et-relecture.md](historique-et-relecture.md).
- **Réseau** : le conteneur n'écoute que sur `BIND_ADDRESS`. Aucun reverse proxy ni accès depuis Internet n'est prévu dans ce dépôt.
