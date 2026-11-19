# Journal des changements

Historique du projet, regroupé par phase et par date, reconstruit à partir de l'historique git (`git log --reverse --format='%ad %s' --date=short`). Le projet n'a pas de numéro de version : les phases sont celles de la [feuille de route](docs/feuille-de-route.md). Les commits de fusion ne sont pas repris.

## 19 novembre 2026 — Veille : cacher les zones sur la carte

- **Panneau Veille** : case « Afficher les zones sur la carte » (par défaut cochée) et un œil par zone (`aria-pressed`) pour retirer le dessin des zones de la carte sans les supprimer : elles restent surveillées et leurs alertes arrivent. Le contour en cours de dessin reste visible.
- **Réglage local** (`carte-vivante:veille:display`, lu sans se fier au contenu) : jamais dans l'adresse de partage (`veille=`) ; l'identifiant d'une zone supprimée est oublié.
- **Tests** : 3 tests ajoutés à `web/scripts/veille.test.mjs` (`parseDisplay`, `zonesToDraw`, `setZoneHidden`, `pruneHidden`).

## 18 novembre 2026 — Qualité de l'air : mesures horaires des stations

- **Serveur** (`server/src/air_mesures.rs`, `GET /api/air/mesures`) : concentrations horaires mesurées par les stations officielles (NO₂, O₃, PM10, PM2.5, SO₂) d'après le flux « temps réel » E2 du LCSQA (Geod'air), un CSV par jour réécrit chaque heure ; relevé conditionnel (`If-None-Match`) toutes les 20 min, fichier de la veille une fois par jour ; valeurs invalides écartées, outre-mer écarté (heure locale). 24 h de série par station et par polluant, en colonnes (environ 160 Ko, 56 Ko en gzip, environ 450 stations).
- **Coordonnées** : le flux n'en a pas ; elles sont extraites une fois du « Dataset D » XML du même jeu par `server/scripts/air_stations.py` vers `server/src/data/air_stations.tsv` (821 stations de métropole), à relancer une fois par an.
- **Carte** (`web/src/modules/air.ts`) : réglage « Afficher » (indice et stations, indice seul, stations seules) et « Polluant des stations » (le pire, NO₂, O₃, PM10, PM2.5) ; point net cerné de blanc, coloré par le pire sous-indice avec la palette et les seuils ATMO 2021 (une valeur horaire comparée à des seuils journaliers : la fiche le dit), valeur écrite sous le point, mesure de plus de 3 h estompée. Fiche : niveau, valeur, type de station, tableau des polluants et courbe sur 24 h. Recherche par nom de station ou commune.
- **Tests** : 10 tests Rust sur une fixture réelle, `web/scripts/airMesures.test.mjs` (seuils, fraîcheur).

## 18 novembre 2026 — Android : fiche Play Store, confidentialité, signature

- **TWA sur Google Play** (`eu.ducray.vigie`, canal test interne) : projet Bubblewrap dont seuls `android/twa-manifest.json` et `android/README.md` sont suivis ; signature hors de `bubblewrap build` (jarsigner et apksigner demandent le mot de passe sans l'afficher).
- **Digital Asset Links** : la barre d'adresse restait affichée parce que l'empreinte notée n'était pas celle de la clé avec laquelle Play signe l'app. L'empreinte réelle a été lue sur l'APK installé (`adb pull` puis `apksigner verify --print-certs`) et ajoutée à `assetlinks.json` ; méthode dans `android/README.md`.
- **Politique de confidentialité** `web/public/confidentialite.html`, écrite d'après le code (position jamais envoyée sauf « Surveiller autour de moi », arrondie à environ 1 km ; pas de journal d'accès côté serveur ; ni statistiques ni publicité ; tiers appelés par le navigateur), lien « Confidentialité » en bas du catalogue des couches.
- **Fiche Play** (`android/fiche-play/`) : textes, réponses aux formulaires de la Console (sécurité des données, classification, public cible, accès à l'appli), six captures 1080×1920, image de présentation 1024×500, icône 512.

## 18 novembre 2026 — Application installable (PWA), prête pour une TWA

- **Manifeste** `web/public/manifest.webmanifest` (« Vigie, la France en direct », `standalone`, `id` et `scope` `/`, couleurs de l'interface sombre) lié avec `crossorigin="use-credentials"` pour passer Cloudflare Access ; `viewport-fit=cover`, `theme-color`, balises iOS, marges des bords tenant compte des encoches en paysage.
- **Icônes** (`web/public/icons`) : 192 et 512, 512 maskable (marque dans la zone de sécurité), 180 pour iOS, 512 monochrome ; sources `design/logos/vigie-icon-*.svg`, script `web/scripts/icones.sh` (`sips`, sans dépendance).
- **Service worker** écrit à la main (`web/pwa/sw.js`) et rempli au build par un plugin Vite local (`web/pwa/plugin.mjs`) : coque précachée (page et `assets/`), version tirée du contenu, navigation réseau d'abord avec repli sur la coque, jamais d'`/api`, de tuiles ni de ressources tierces en cache, jamais de réponse redirigée ou non 200 gardée ; mise à jour proposée (« Nouvelle version disponible — Recharger »), jamais forcée. Enregistré seulement en production, en contexte sûr.
- **Interface** : entrée « Installer l'application » dans le catalogue (`beforeinstallprompt`, aide *Partager → Sur l'écran d'accueil* sur iOS, absente une fois installée), avis « Hors ligne » (`web/src/core/pwa.ts`, `web/src/ui/Install.tsx`).
- **Serveur** : `site()` regroupe le service du site (`assets/` immuables, reste en `no-cache`) et sert `/.well-known/` (404 si absent, pas la page d'accueil) ; `web/public/.well-known/assetlinks.json` vide (`[]`) en attendant l'empreinte de Play. Tests : types et en-têtes.
- **Tests** : `web/scripts/pwa.test.mjs` (plugin, comportement du service worker dans un bac à sable, détection iOS).
## 18 novembre 2026 — Neige : stations de mesure lisibles

- **Stations** (`web/src/modules/neige.ts`, `design/tokens.ts`) : vues pour la première fois avec de vraies données (68 stations). L'ancien bleu `NEIGE_SOL` était celui des TER et le point creux à 0 cm faisait du bruit : rampe rose en quatre classes (1-9, 10-29, 30-69, 70 cm et plus) avec halo blanc et liseré sombre (lisible sur les aplats de risque, jour et nuit) ; 0 cm : petit rond gris sans étiquette, affiché dès le zoom 8 ; étiquettes en cm sélectives (zoom 7 : 30 cm et plus ; 8,5 : toutes celles qui ont de la neige, les plus hautes prioritaires) ; mesure de plus de 6 h estompée ; légende par classe ; fiche avec heure de Paris et « il y a X h ».
- **Noms** (`server/src/neige.rs`, `title_case`) : « Les Ecrins-nivose » devient « Les Écrins (Nivôse) » ; « Saint », élisions (« d'Arène »), mots outils en minuscules, suffixes techniques `_sapc` et `-clim` retirés, quelques accents. Côté serveur : un seul endroit pour la carte, la recherche et la synthèse. Test Rust `noms_de_stations_lisibles`.
- **Recherche** (`web/src/search/neige.ts`) : une station se trouve par son nom (« écrins », « nivôse »), « neige » ne remonte que celles qui ont de la neige.

## 18 novembre 2026 — Autour de moi : position, recherche et Veille

- **Position** (`web/src/core/position.ts`, `positionLogic.ts`) : `navigator.geolocation` seulement en contexte sûr et sur clic ; dernière position en mémoire seule (périmée après 30 min pour le classement), drapeau « déjà accepté » en `localStorage` sans coordonnées ; refus, indisponible et délai dépassé en messages français ; `watchPosition` seulement quand le suivi est coché, coupé à la fermeture du panneau. Rien n'est envoyé, journalisé ni écrit dans l'adresse (la carte se centre sur la position arrondie à environ 1 km).
- **Bouton et panneau « Autour de moi »** (`web/src/ui/Position.tsx`) : point « vous êtes ici » avec cercle de précision (surcouche deck.gl), gare la plus proche et prochains départs, vélos, bornes et carburant le moins cher à moins de 10 km ; données déjà chargées, sinon bouton « Charger » (`ModuleManager.prefetch`) ; lignes ouvrant l'objet (`openObject`) ; clavier, Échap, téléphone en feuille du bas.
- **Recherche** : bonus de proximité (30 au plus, nul au-delà de 150 km) pour les résultats qui ont une place (`SearchResult.at`), seulement si une position fraîche est connue.
- **Veille** : « Surveiller autour de moi » (10, 25 ou 50 km, centre arrondi à environ 1 km) dans le panneau et dans « Ajouter une zone ». Notifications du navigateur vérifiées en HTTPS : permission demandée au clic, message si elle est refusée.
- **Tests** : `web/scripts/position.test.mjs`.

## 18 novembre 2026 — Neige : hauteurs relevées avec l'API Observation seule

- **Problème** : la clé Météo-France est abonnée à « Données Publiques Observation » en v2, pas au « Paquet Observation » ; le serveur appelait `DPObs/v1` et `DPPaquetObs` et recevait `403`, donc aucune hauteur de neige.
- **Liste des stations** lue en `DPObs/v2/liste-stations`.
- **Repli station par station** : quand le paquet d'un département est refusé, le serveur interroge `DPObs/v2/station/horaire` pour chaque station des départements de massif à 800 m ou plus (environ 160), toutes les heures, au rythme espacé habituel.
- **Tests** : `stations_de_montagne_interrogees_une_a_une`.

## 18 novembre 2026 — Recherche : couches chargées à la demande

- **Problème** : « webcam chamonix », « borne ionity », « vélib bastille » ne donnaient rien tant que la couche n'avait pas été ouverte (les fournisseurs ne lisent que les données déjà chargées).
- **`ModuleManager.prefetch(id)`** : charge les données d'un module sans l'afficher ni armer de rafraîchissement, une seule fois (chargement partagé s'il est en cours, aucun doublon si la couche s'ouvre entre-temps), abonnés prévenus à l'arrivée ; rejette en cas d'échec sans mettre la couche masquée en erreur.
- **Mots-clés** (`web/src/search/prefetch.ts`) : webcams, bornes, vélos en libre-service, parkings, monuments, actualité locale, rivières, marées, Vigicrues. La barre précharge au premier mot reconnu (une fois par module, nouvel essai après 30 s en cas d'échec), affiche « Chargement des webcams… » ou « Webcams indisponibles », puis relance la recherche. Aucun chargement sans mot explicite.
- **Bornes** : « borne » et « recharge » ne comptent plus comme des mots à trouver (« borne ionity » se cherche comme « ionity »).
- **Tests** : `web/scripts/prefetch.test.mjs`.

## 18 novembre 2026 — Recherche : carburants et objets nommés

- **Audit** : la recherche ne connaissait ni les stations-service (« e85 », « sp95 », « gazole » ne donnaient rien, ou seulement un réglage de couche), ni les stations de mesure des rivières, tronçons Vigicrues, marégraphes, monuments, satellites, qualité de l'air par commune, vigilance par département, séismes.
- **Carburants** (`web/src/search/fuel.ts`, `fuelQuery.ts`) : E85, SP95, SP98, E10 (« sp95-e10 »), gazole (gasoil, diesel, B7), GPL(c), « superéthanol », « essence » (E10), avec variantes de saisie, suivis d'un lieu (commune, département ou code postal) ; stations classées par prix avec distance, fiche ouverte et couche réglée au choix. Le SP95 devient un réglage de la couche. Couche jamais chargée : un résultat l'affiche, réglée sur le carburant.
- **Autres fournisseurs** : eau (rivières, Vigicrues, marées), monuments, satellites, et air, vigilance, séismes (mot-clé requis) ; nouveaux types de résultats et filtres. Synonymes de couches élargis (carburants, crues, vigilance, séismes, électricité et régions, marées, rivières, monuments, couverture mobile, immobilier, photoréaliste, satellite du jour, etc.). Index préparés hors frappe (`warm`), aucune requête à la frappe.
- **Tests** : `node --test web/scripts/recherche.test.mjs`.

## 18 novembre 2026 — Neige et avalanches, marées dans les rivières

- **Neige et avalanches** (Environnement) : les 35 massifs des Alpes, des Pyrénées et de la Corse colorés selon le risque d'avalanche du bulletin de Météo-France (échelle européenne 1 à 5, chiffre sur chaque massif), stations de hauteur de neige, fiche par massif (risque par altitude, rose des pentes dangereuses, enneigement, neige fraîche, textes, validité, liens officiels), légende, mode nuit, téléphone, recherche par nom de massif. Hors saison : « pas de bulletin en cours ». Sans clé : « clé Météo-France absente ».
- **Serveur** : `server/src/neige.rs`, API du portail Météo-France (`METEOFRANCE_API_KEY`) : bulletins BRA deux fois par jour au plus, observations horaires par département, requêtes espacées, persistance dans `DATA_DIR/neige/`. Contours des massifs : Météo-France, Licence Ouverte 2.0.
- **Intégrations** : rubrique « Risque d'avalanche » dans « Aujourd'hui » (massifs en risque 4 ou 5) et type d'événement dans la veille.
- **Rivières** : les stations soumises à la marée (marégraphes, estuaires) sont gardées mais présentées à part (gris neutre, vague), sans tendance de montée ni vigilance ; la fiche et la légende l'expliquent. La règle `is_tidal` a été resserrée au passage : sur le relevé réel du 18 novembre (2 461 stations) l'ancienne en marquait 101, dont 60 à tort (sources, lacs, affluents d'estuaire comme l'Eure ou la Sèvre Nantaise) ; elle en marque 53, toutes plausibles.

## 18 novembre 2026 — Couche « Événements »

- **Événements publics** (Territoire) : ~54 000 événements des 30 prochains jours (concerts, spectacles, expositions, fêtes, marchés, sport, visites, rencontres), huit catégories (teinte + pictogramme), disques gradués de loin, points puis pictogrammes puis titres en zoomant, opacité = en cours à l'instant de la frise. Période reliée à la frise (jour, instant, week-end, 7 jours), filtres catégorie, gratuit, longues durées ; fiche avec horaires, lieu, tarif, description, lien, source et licence ; recherche (« concert Lyon »).
- **Sources** : DATAtourisme (API v1 avec la clé `DATATOURISME_API_KEY`, secrète : horaires réels, tarifs, téléphone, ~38 000 événements en 379 requêtes par jour ; sinon export CSV public sans horaires), Que faire à Paris (ODbL), OpenAgenda via le jeu Opendatasoft (sans clé). Lecture en continu, dédoublonnage titre + jour + 300 m, contenu adulte écarté.
- **API DATAtourisme** : les fiches venues de l'API montrent leurs vrais horaires (un moment par jour, jours de la semaine respectés), leur tarif (« de 12 à 25 € · gratuit pour les moins de 12 ans »), le lien officiel et le téléphone public ; l'ancien connecteur « flux » ZIP JSON-LD (`DATATOURISME_FLUX_URL`, jamais essayé) est retiré. Repli : relevé de moins de 48 h gardé, sinon export CSV. Le lieu nommé n'existe pas dans l'API : la fiche donne l'adresse.
- **Veille** : type « Événement public (dans les 6 h) », désactivé par défaut.
- **Corrections de données** : « Que faire à Paris » place les événements non localisés au même point du centre de Paris (écartés) et donne des heures locales avec un décalage faux (ignoré) ; les dates des fiches ne sont plus rognées à la fenêtre ; la fiche se redessine à l'arrivée du détail même horloge en pause (`web/src/core/infoRefresh.ts`).
- **Serveur** : `server/src/events.rs`, `GET /api/evenements` et `GET /api/evenements/fiche`. Variables `DATATOURISME_API_KEY`, `DATATOURISME_API_URL` et `EVENEMENTS_SOURCES`.

## 18 novembre 2026 — Actualité locale

- **Couche « Actualité locale »** : les titres de la presse régionale et du service public, placés sur la commune dont ils parlent. Un point par commune (taille et nombre = titres), regroupement des communes voisines de loin, anneau pour un titre rattaché à un département seul. Fiche : heure, titre (lien vers l'article chez l'éditeur), source. Période 3 h / 24 h / 3 jours comptée depuis l'instant de la frise (rejeu du passé sur trois jours). Recherche par commune ou par mot d'un titre. Option « Actualité locale » dans la veille (désactivée par défaut).
- **Droit d'auteur** : seuls le titre, l'adresse, la source et l'heure sont gardés et servis ; jamais de chapô, de texte, d'image ni de page d'article. `robots.txt` lu et respecté, `User-Agent` du projet, un fil par 15 minutes au plus avec `If-Modified-Since`, une requête toutes les 10 secondes.
- **Serveur** : `server/src/actualite.rs` (relevé, stockage de 3 jours, `GET /api/actualite`), `actualite/flux.json` (71 fils : France 3 Régions, ICI, quotidiens régionaux, actu.fr), `actualite/lieux.rs` (35 000 communes de geo.api.gouv.fr ; adresse de l'article, puis nom de commune dans le titre, puis département). Ouest-France (robots.txt), Sud Ouest, La Voix du Nord et d'autres (accès refusé) écartés. Mode `--actualite-seule` pour tester sans le reste. Pas de nouvelle dépendance.
- **Site** : module `actualite`, lignes de tableau à lien (`InfoRow.href`) et tableau en liste (`InfoTable.layout`), fournisseur de recherche, jeton de couleur `actualite-1`.
- **Pas de rubrique dans « Aujourd'hui »** : les « communes dont on parle le plus » ne sont que les plus grandes villes et les sièges des rédactions régionales : trop bruité pour être utile.
- **Tests** : tests Rust de la localisation, de la lecture RSS/Atom, du `robots.txt` et des filtres.

## 17 novembre 2026 — Zones surveillées (veille) et orages

- **Veille** : jusqu'à 12 zones (cercle, polygone, commune, département) ; Vigie prévient dans l'application quand il s'y passe quelque chose (vigilance orange ou rouge, crue, rivière en forte montée, incendie, séisme ressenti, brouillage GPS, avion militaire, train supprimé ou très en retard à une gare de la zone). Avis discret, liste des alertes, pastille, compteur dans le titre, son facultatif ; `Notification` seulement en contexte sûr (le site est en HTTP). Dédoublonnage par identifiant d'événement, zones gardées dans le navigateur et dans l'adresse (`veille=`), version téléphone (onglet de la feuille).
- **Serveur** : `POST /api/veille` (`server/src/synthese/veille.rs`) évalue les zones sur un index national recalculé au plus toutes les 30 s depuis les caches en mémoire ; aucune requête externe, PRIM comprise.
- **Synthèse** : rubrique « Orages » d'après la vigilance Météo-France (pas de source d'éclairs en points) ; marégraphes et estuaires retirés des rivières en forte montée (18 des 45 stations « montantes » du relevé étaient la marée).
- **Tests** : `node --test web/scripts/veille.test.mjs` (géométrie, dédoublonnage, adresse, séismes) et tests Rust de `synthese::veille` et `rivers::is_tidal`.

## 17 novembre 2026 — Trains : même sens à tous les zooms

- **Trains à l'arrêt tournés à l'envers selon le zoom** : le cap de l'icône (sous le zoom 13) était celui du tronçon *suivant* l'arrêt, alors que la rame dessinée voiture par voiture (zoom 13 et plus, à plat ou en 3D) s'étend derrière son *arrivée*. Pour un train qui repart en sens inverse (terminus, rebroussement) la tête de l'icône pointait donc à l'opposé du nez de la rame. Mesure sur le relevé du 16 novembre (05 h 30, 09 h, 17 h UTC) : 5, 5 et 12 trains à l'arrêt à 180° d'écart, plus aucun après correction ; en marche, aucun écart (500 trains sur 509 à moins de 25° du déplacement réel, les 9 autres sont des courbes).
- **Un seul cap pour toutes les représentations** (`web/src/modules/trainHeading.ts`) : en marche, celui du tronçon parcouru ; à l'arrêt, celui de l'arrivée (la rame reste comme elle est arrivée). Au départ d'un rebroussement, la rame ne se replie plus sur sa propre voie : elle part en ligne droite derrière la tête, comme au départ d'un terminus.
- **Test** : `node --test web/scripts/trainHeading.test.mjs` (Node 22.18 ou plus).

## 17 novembre 2026 — Synthèse « Aujourd'hui en France »

- **Panneau « Aujourd'hui en France »** : ce qui compte en ce moment (vigilances météo, crues, rivières, feux, brouillage GPS, avions, air, trains en retard, séismes), en rubriques ; chaque ligne mène à la couche et à l'objet concerné sur la carte. Bouton parmi les puces de couches, feuille sur téléphone, lien partageable (`synthese=1`), Échap pour fermer. Une source muette est dite « indisponible », jamais « calme ».
- **Serveur** : `GET /api/synthese` (`server/src/synthese.rs`) résume les réponses déjà en mémoire, **aucune requête externe**, réponse gardée 30 s. Le contenu ne se charge qu'à l'ouverture du panneau.

## 17 novembre 2026 — Vue photoréaliste

- **Vue photoréaliste** (réglage facultatif) : Google Photorealistic 3D Tiles via Cesium ion, `Tile3DLayer` deck.gl, altitudes ramenées au niveau de la mer par le géoïde, maillage toujours devant le fond de carte (tampon de profondeur vidé), affichage à plat, nuit par assombrissement. Jeton `CESIUM_ION_TOKEN` gardé sur le serveur (`GET /api/photoreal/endpoint`). Décodeur Draco hébergé par le site ([docs/rendu-3d.md](docs/rendu-3d.md#vue-photoréaliste)).

## 16 novembre 2026 — Satellite du jour

- **Satellite du jour** (Ciel et espace) : la France vue par NOAA-20 (défaut), NOAA-21, Terra ou Aqua, d'après NASA GIBS (tuiles WMTS sans clé, CORS ouvert : client seulement), en vraies couleurs ou « neige et feux » (fausses couleurs). Date liée à la frise du temps (jour UTC) ; pour aujourd'hui, repli sur la veille tant que la mosaïque ne couvre pas la France. Surzoom au-delà du niveau 9, drapé sur le relief, sous bâtiments et noms, bandeau et fiche avec date et satellite ([docs/couches.md](docs/couches.md#satellite-du-jour--source-et-choix)).

## 16 novembre 2026 — Bus d'Île-de-France activés

- **Bus d'Île-de-France activés par défaut** (`IDFM_MODES=metro,tram,train,cable,bus`, retirables) : ≈ +45 Mo en permanence, pire cumulé estimé à 805 Mo avec les tuiles, sous le seuil de 850 Mo ([mesures](docs/couches.md#bus-dîle-de-france--mesures-et-décision)).
- **GTFS lu en flux** : `stop_times.txt` n'est plus gardé, courses construites au fil de la lecture, tracés simplifiés à la volée, identifiants réduits à une empreinte ; pic de construction avec bus 169 → 57 Mo, mémoire résidente 211 → 69 Mo (macOS). Lecture en mémoire de secours si le GTFS n'est pas groupé. L'ancien modèle d'Île-de-France est libéré avant la relecture.
- **SIRI décodé circulation par circulation** (`DeserializeSeed`), corps de la réponse transmis au décodeur par morceaux (gzip décompressé au fil de l'eau) ; arrêts annoncés sur 32 octets, mises à jour de courses deux fois plus petites : pic de décodage 22 → 7 Mo, temps réel gardé 17 → 11 Mo.
- **Rapprochement mesuré sur de vraies réponses PRIM** (2 requêtes) : 67 % des bus rapprochés (96,5 % de ceux qui donnent l'heure théorique, 96 % de bonnes attributions quand on cache l'identifiant), appels aberrants écartés (positions invraisemblables : 8,9 et 7,5 → 6,6 et 4,5 % pour métro et tramway, 1,25 et 1,03 → 1,24 et 0,74 % pour les bus, sur les deux relevés). Le flux « MeC » (41 % des bus) mélange les passages de plusieurs véhicules : laissé à l'horaire théorique.
- Site : bus des réseaux de plus de 1 500 véhicules absents sous le zoom 12, petits sans contour jusqu'au 14, positions recalculées au plus tous les demi-pas de glissement.
- Outils : `IDFM_SIRI_FICHIERS` (rejeu de réponses enregistrées, aucune requête PRIM), tests `mesure_gtfs_idfm` (tas exact, relecture, SIRI) et `qualite_siri_idfm`.

## 16 novembre 2026 — Rivières et parkings en direct

- **Rivières en direct** (Environnement) : les ~2 800 stations hydrométriques de métropole (Hub'Eau, API Hydrométrie, Licence Ouverte), un point par station coloré par la **tendance de la hauteur sur 3 h** (monte vite, monte, stable, baisse ; échelle divergente validée jour et nuit, doublée d'un symbole), anneau vide pour les stations sans mesure récente, anneau de la couleur de vigilance quand le tronçon Vigicrues voisin est jaune, orange ou rouge. Fiche : hauteur, débit, tendance, courbe de 48 h chargée à l'ouverture, lien Hydroportail. Serveur : `GET /api/rivieres`, `GET /api/rivieres/{code}` ; relevé toutes les 15 min par lots de 20 000 (jamais une requête par station), référentiel une fois par jour, quelques Mo en mémoire. En direct seulement ([docs/couches.md](docs/couches.md#rivières-en-direct-hubeau-hydrométrie)).
- Mesures aberrantes écartées (saut d'au moins 1 m à plus de 10 m/h entre deux mesures : zéro d'échelle changé, valeur 9999) et étiquettes désencombrées.
- Fiche : `InfoChart.grain` règle le pas des repères verticaux (des centimètres de rivière, pas des mètres de marée).
- **Parkings** (Transports) : places libres de 257 parkings et parcs relais de 9 agglomérations (Rennes, Nantes, Strasbourg, Bordeaux, Clermont-Ferrand, Tours, Aix-Marseille, Orléans, Grenoble), en Licence Ouverte ou ODbL, sans compte. Le serveur (`server/src/parkings.rs`) relève chaque source toutes les 5 minutes, unifie les formats (un décodeur testé par source), garde 24 h de places libres par parking pour la courbe de la fiche (`GET /api/parkings`, `GET /api/parkings/courbe`). Site : disque par agglomération de loin, jauge de places libres de près, « Complet » barré de blanc, donnée de plus de 30 min en gris, rampe `parking-1` à `parking-4` validée jour et nuit, recherche, légende. Sources écartées et raisons : [docs/couches.md](docs/couches.md#parkings--sources-et-choix).
- Fiche : la courbe accepte un compte (`integer`, axe depuis 0) et un pas d'heures (`hourStep`).

## 16 novembre 2026 — Foudre en direct, webcams ouvertes, recherche de webcams et de modes de vision

- **Foudre en direct** (Ciel et espace) : les éclairs des 45 dernières minutes vus du satellite MTG (imageur d'éclairs LI), lus directement par le navigateur sur le service ouvert EUMETView (EUMETSAT, sans compte ni clé), recolorés dans une rampe jaune d'or validée (`ECLAIR`, jour et nuit) et d'autant plus transparents qu'ils sont anciens ; fondu à l'arrivée d'une image (coupé avec `prefers-reduced-motion`) ; relecture du passé possible (archive depuis mai 2025). Blitzortung.org écarté (conditions de réutilisation).
- **Radioactivité ambiante (Téléray)** : non intégrée, aucune source ouverte et réutilisable (API de teleray.asnr.fr non documentée et sans licence, EURDEP soumis à accord) : voir [docs/couches.md](docs/couches.md#radioactivité-ambiante-téléray--pas-intégrée).
- **Webcams ouvertes** : 13 webcams d'Orléans Métropole et du littoral d'Anglet (data.gouv.fr, Licence Ouverte 2.0), position et page de la webcam sans image, `GET /api/webcams/ouvertes`, listes relues toutes les 6 h ; fiche avec source et licence. Les autres jeux examinés (Saint-Nazaire, déchèteries d'Orléans, caméras de comptage…) sont écartés et motivés dans [docs/couches.md](docs/couches.md#caméras--sources-et-choix).
- **Fiche webcam** vérifiée sur la prod, ordinateur et téléphone : image décodée avant d'être montrée, mention « Windy Webcams » devenue un lien vers la page de la webcam, fiche ouverte à mi-hauteur sur téléphone quand elle porte une image.
- **Recherche** : webcams par nom ou lieu (« webcam Chamonix »), modes de vision (« vision thermique », « écran cathodique »…).
- **Visite guidée** : treizième étape « Les caméras de Paris » (cônes de vision, zoom 17 incliné), sautée sans données.

## 15 novembre 2026 — Avions militaires, brouillage GPS, modes de vision, caméras

- **Avions militaires et d'État** : le drapeau `dbFlags` (bit 0) des réponses d'adsb.lol et d'adsb.fi est exposé (`military`), sans requête de plus. Silhouette et anneau sarcelle, mention dans la fiche, légende, réglage « Afficher : tous / militaires seulement ».
- **Brouillage GPS** : nouvelle couche (Ciel et espace), `GET /api/brouillage`. Grille de 0,5° sur 20 min des avions à la position dégradée (NIC < 7 ou NACp < 8, hors MLAT et TIS-B), couleur d'une seule teinte validée, cases grises quand il y a moins de 5 avions, fiche par case qui rappelle que c'est une estimation indirecte ([docs/couches.md](docs/couches.md#brouillage-gps--lecture-et-limites)).
- **Modes de vision** : un bouton en forme d'œil parmi les commandes de la carte (et la touche `V`) applique un rendu à toute la carte, fond et couches : vision nocturne (vert phosphore, grain, vignettage), thermique (fausses couleurs noir, violet, rouge, jaune, blanc), écran cathodique (lignes de balayage, aberration chromatique, teinte ambrée). Filtres CSS et SVG sur le seul canevas de la carte, sans dépendance ; interface et clics intacts ; mode gardé dans l'adresse (`vision=`) et en préférence locale ; aucun mouvement avec `prefers-reduced-motion` ([docs/rendu-3d.md](docs/rendu-3d.md#modes-de-vision), [docs/utilisation.md](docs/utilisation.md#modes-de-vision)).
- **Caméras** (catégorie Territoire) : vidéoprotection d'OpenStreetMap (≈ 80 000 points `man_made=surveillance`, extraction Overpass hebdomadaire par le serveur), avec **cône de vision 3D** posé sur le relief quand la direction est connue et cercle pour les dômes sans direction ; webcams publiques avec image : **Windy Webcams** (clé `WINDY_WEBCAMS_KEY` côté serveur, lien d'image demandé à l'ouverture de la fiche et gardé 8 minutes au plus) et **caméras de trafic Criter** de la Métropole de Lyon (Licence Ouverte 2.0). Deux réglages d'affichage.
- Fiche : nouveau champ `image` (`InfoContent.image`) : image rechargée tant que la fiche est ouverte, jamais agrandie, avec heure, texte alternatif et lien.
- Documentation : sources et licences, variable `WINDY_WEBCAMS_KEY` ([docs/couches.md](docs/couches.md#caméras--sources-et-choix)).

## 14 novembre 2026 — Relief plus fin, avions sans refus

- **Relief Mapterhorn** : `maxzoom` relevé de 12 à 16 (tuiles de 0,8 m par pixel en France issues du LiDAR) ; le relief « LiDAR HD » en 3D devient un réglage éteint par défaut, son altitude étant la même jusqu'au zoom 16 ([docs/rendu-3d.md](docs/rendu-3d.md)).
- **Avions** : une requête à la fois toutes les 3,3 s au lieu de trois d'un coup (adsb.lol répondait « 429 »), `Retry-After` suivi, recul court et progressif (2 à 12 s) au lieu de 60 s, cercles déjà obtenus conservés et republiés.

## 13 novembre 2026 — Analyse de zone

- Analyse de zone : outil de dessin (cercle, polygone, tactile), panneau de résultats, zone dans l'adresse (`zone=`) ([docs/analyse-de-zone.md](docs/analyse-de-zone.md)).
- Habitants sans 4G : couverture mobile croisée avec la grille de population, et moteur d'analyse côté serveur (`POST /api/analyse`).

## 12 novembre 2026 — Visite guidée, performance, nouvelles couches

- **Visite guidée** : douze étapes en trois minutes jouées sur la vraie carte (trains, pointe à Paris, avion suivi, détroit, isochrones, population, prix, zones blanches, élections, photos de 1950, météo, nuit).
- **Marées** : niveau de la mer aux marégraphes REFMAR (Shom), courbe de 48 h, marées estimées.
- **Relief LiDAR HD** : estompages MNT, MNS, MNH et hauteur du sursol en couleurs (IGN, Géoplateforme).
- **Élections** : municipales 2026, 1er et 2nd tour, nuance de la liste en tête, listes de la commune en fichier annexe.
- **Bus d'Île-de-France** : mesures sur le vrai GTFS, mémoire réduite (pas de « demain » pour les bus, heures non dupliquées), tests SIRI, recommandation de ne pas les activer avec 1 Go.
- **Performance** : échelle sans lecture du GPU pendant le mouvement, altitudes mémorisées, gares et véhicules posés sur le relief dans la vue seulement ; banc de mesure `perf/` (vues de ville de ~52 à ~17 ms par image).
- Prix de l'immobilier : fiche listant les ventes d'un même point, pastille du nombre dès le zoom 16.
- Photos anciennes sans trous ; aplats de tuiles au-dessus des ponts du fond de carte.
- Historique : l'archive brute SNCF est gardée 180 jours (`ARCHIVE_SNCF_JOURS`).

## 11 novembre 2026 — Phase 4 : gros volumes et moteur de tuiles

- **Accidents de la route** (ONISR) : collecte en colonnes, grille 3D puis un point par accident selon la gravité.
- **Population** : carreaux INSEE de 200 m en colonnes 3D.
- **Habitants atteints** par les isochrones (grille INSEE de 200 m, par tranche de 30 min).
- **Élections** : un jeu de tuiles par scrutin (présidentielle 2022, européennes 2024, législatives 2024), résultats par bureau de vote, commune et département.
- **Couverture mobile** (ARCEP) : rastérisation des polygones en grille de 250 m.
- **Prix de l'immobilier** (DVF) : source nettoyée, médianes par histogrammes fusionnables, carte divergente autour de la médiane.
- Photos aériennes anciennes, monuments historiques et accidents fusionnés.
- Fabrication des tuiles : une seule à la fois, `TUILES_JEUX`, mémoire bornée (élections sous 150 Mo).
- Mesure de mémoire des collecteurs (tests ignorés).

## 10 novembre 2026 — Moteur de tuiles, historique, isochrones, refonte, maquettes 3D

- **Moteur de tuiles vectorielles** : MVT, PMTiles v3, généralisation par zoom, service `/api/tuiles`.
- **Historique et relecture du passé** : avions, bateaux et transports enregistrés en tronçons colonnes compressés, retards des trains rejoués depuis l'archive du temps réel.
- **Photos aériennes anciennes** (IGN) avec rideau avant / après sur le relief 3D ; **monuments historiques** (base Mérimée).
- **Isochrones** : RAPTOR sur les horaires SNCF, puis multimodal (cars TER, Île-de-France, cars interurbains régionaux), itinéraire détaillé, durée au curseur, recherche « depuis Rennes », gare de départ dans l'adresse.
- **Transports d'Île-de-France** : métro, RER, Transilien, tramways d'après le GTFS d'IDFM et le SIRI global de PRIM.
- **Maquettes 3D** construites dans le code : avions (sept familles), bateaux par type AIS, trains voiture par voiture, bus, trams et métros ; éclairage par le vrai soleil.
- **Refonte de l'interface** : recherche universelle, chrome neutre, scènes, catalogue, frise du temps, fiche unifiée avec statuts (direct, rejoué, estimé, prévu), adresse partageable, feuille de téléphone ; fond de carte calme et nuit sombre ; nouveaux symboles.
- **Qualité de l'air** (Atmo Data) ; suivi d'un avion à son altitude.
- **Phase 3 : tout ce qui bouge** : avions (adsb.lol), satellites (CelesTrak, SGP4), bateaux (aisstream.io), bus, trams et métros (GTFS-RT, ~140 réseaux, positions estimées pour 47 réseaux).
- **Couches météo et ciel** : radar de pluie (RainViewer), vent animé (Open-Meteo, ARPEGE), ombres des bâtiments.
- **Couches rapides** : bornes de recharge, trafic routier, vigilance météo, carburants, vigilance crues, électricité par région, vélos en libre-service, feux détectés par satellite.
- Le serveur sert aussi le site ; image Docker : `MALLOC_ARENA_MAX=2` pour contenir l'empreinte mémoire.

## 9 et 10 novembre 2026 — Phases 0 et 1 : socle et trains

- **Phase 0 : socle** de la carte 3D : globe, relief, modules, horloge, fiche au clic, jour et nuit, séismes ; nuit plus lisible.
- **Phase 1 : trains** : serveur Rust, horaires et temps réel SNCF, trains sur les vraies voies avec leur altitude, trajet et arrêts au clic, tableau d'affichage des gares, caméra qui suit, vitesse réaliste (accélération, vitesse de la ligne, freinage), voies ferrées.
- Déploiement Docker du serveur (serveur maison) et README du serveur permanent.
