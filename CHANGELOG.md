# Journal des changements

Historique du projet, regroupé par phase et par date, reconstruit à partir de l'historique git (`git log --reverse --format='%ad %s' --date=short`). Le projet n'a pas de numéro de version : les phases sont celles de la [feuille de route](docs/feuille-de-route.md). Les commits de fusion ne sont pas repris.

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
