# Utiliser Vigie

Le serveur maison sert la carte en permanence, sur le réseau de la maison : **http://192.168.0.75:8787/**. Aucun programme n'a besoin de tourner sur l'ordinateur qui l'affiche.

L'écran a quatre zones fixes. Au repos, elles couvrent moins de 15 % de la carte.
- **En haut à gauche, la recherche** (`⌘K` ou `/`) trouve d'une seule barre :
  - une ville ou une adresse (géocodage de l'IGN) ;
  - une gare et ses départs ;
  - un train par son numéro ;
  - un vol, un navire, une ligne de bus ;
  - **un carburant** : « e85 », « sp95 », « sp 98 », « e10 », « gazole », « gasoil », « gpl », « superéthanol », « essence », éventuellement suivi d'un lieu (« e85 lyon », « gazole moins cher près de Rennes », « essence 35 », « station service Nantes »). Les stations qui le vendent, les moins chères d'abord, avec le prix ; autour de la commune citée (15 km), sinon autour du centre de la carte (30 km, à partir du zoom 8) ou, de plus loin, dans toute la France. Choisir une station ouvre sa fiche et règle la couche Carburants sur ce carburant. Tant que la couche n'a jamais été affichée, un seul résultat propose de l'afficher (les stations se chercheront ensuite). Le flux officiel ne donne pas l'enseigne : « Total » ou « Leclerc » ne se cherchent pas ;
  - une fois leur couche chargée : une station de mesure ou un tronçon de cours d'eau (« Loire », « Seine Paris »), un marégraphe (« marée Brest »), un monument historique (« château Chambord », « cathédrale Chartres »), un satellite (« ISS »), et, avec un mot-clé, la qualité de l'air d'une commune (« air Lyon »), la vigilance d'un département (« vigilance Gironde », « vigilance 33 »), les séismes (« séisme », « séisme Pyrénées ») ;
  - une station de vélos, une borne, une webcam par son nom (« webcam Chamonix », « caméra Perrache »), une couche, une scène ;
  - **sans ouvrir la couche** : un mot qui désigne une couche (webcam, borne, recharge, vélo, vélib, parking, monument, château, actualité, rivière, crue, marée…) la charge en arrière-plan sans l'afficher (ligne « Chargement des webcams… » puis résultats ; « Webcams indisponibles » en cas d'échec). Sans ce mot, rien ne se charge. Choisir un résultat ouvre alors la couche et la fiche ;
  - un mode de vision (« vision thermique », « vision nocturne », « écran cathodique », « vision normale ») ;
  - une date (« demain 8h », « il y a 2 h », « direct »).
- **Sous la recherche, les pastilles des couches affichées.** Un clic ouvre leurs réglages, la croix les masque. Le bouton « Couches » ouvre le catalogue, avec un filtre et des scènes prêtes à l'emploi (Ce qui bouge, Météo, Qualité de l'air, Énergie, Ma ville…) et la visite guidée.
- **À droite, la fiche de l'objet choisi.** Elle montre :
  - le type ;
  - un statut : en direct, rejoué, estimé ou prévu ;
  - trois chiffres clés ;
  - le détail ;
  - les actions : Suivre, Partager, Source.
- **En bas, la frise du temps.** Elle couvre de −7 jours à +2 jours, avec les bandes de jour et de nuit, la vitesse et des sauts rapides.

L'adresse de la page garde tout : la vue, les couches, les réglages, l'instant et l'objet choisi. Un lien partagé rouvre exactement la même carte.

Raccourcis :

| Touche | Effet |
|---|---|
| `Espace` | Lecture ou pause |
| `←` / `→` | Une heure avant ou après |
| `L` | Ouvrir les couches |
| `V` | Passer au mode de vision suivant |
| `Échap` | Fermer |

Sur téléphone, tout passe dans une feuille qui monte du bas, à trois hauteurs.

### Aujourd'hui en France

Le bouton « Aujourd'hui » (parmi les puces de couches) ouvre un panneau qui résume ce qui compte en ce moment : vigilances, crues, rivières, feux, brouillage GPS, avions, air, trains en retard, séismes. Cliquer une ligne active la couche et centre la carte sur l'objet. Une rubrique « indisponible » signale une source qui n'a pas répondu, pas un calme. Le panneau s'ouvre aussi par un lien (`synthese=1`) et se ferme avec `Échap`.

La rubrique **Orages** s'appuie sur la vigilance orages de Météo-France (orange et rouge par département, aujourd'hui et demain ; le jaune est un simple « à noter ») : aucune source ouverte, sans clé et réutilisable, ne donne les éclairs en points (la couche Foudre est une image satellite, et Blitzortung est exclu). La rubrique le dit et renvoie à la couche Foudre. Les rivières « en forte montée » ne comptent plus les marégraphes ni les estuaires (la marée y fait monter l'eau de 1 à 3 m en 3 h).

### Veille : zones surveillées

Le bouton « Veille » (à côté d'« Aujourd'hui », touche `S`, onglet de la feuille sur téléphone) ouvre vos zones surveillées. Vous en ajoutez jusqu'à 12 : **cercle** ou **polygone** dessinés sur la carte (le même outil que l'analyse de zone), **commune** (recherche par nom ou code postal, contour de geo.api.gouv.fr), **département**, ou un cercle de 10 km autour du centre de la carte. Pour chaque zone, vous choisissez ce qui vous prévient : vigilance orange ou rouge, vigilance crues (jaune et plus), rivière en forte montée (30 cm en 3 h, marée exclue), incendie (au moins 20 MW), séisme ressenti (magnitude 3 ou plus, dans la zone ou à 15 km par unité de magnitude au-dessus de 2), brouillage GPS, avion militaire (désactivé par défaut), train supprimé ou en retard de 30 minutes ou plus au départ ou à l'arrivée d'une gare de la zone.

- **Alertes dans l'application** : avis discret (jamais bloquant), liste des alertes récentes (marquées « Nouveau »), pastille avec le nombre sur le bouton, compteur dans le titre de l'onglet, signal sonore facultatif (coupé par défaut). Chaque alerte dit sa gravité par un signe et un mot. Un clic vole vers l'objet et ouvre sa fiche. Une alerte n'est signalée qu'une fois ; elle l'est de nouveau si l'événement disparaît six heures ou plus, ou change de gravité (orange puis rouge).
- **Le site est en HTTP** sur le réseau local : le navigateur n'y propose ni `Notification` ni Web Push. Le site n'utilise `Notification` que si la page est en contexte sûr (`window.isSecureContext`, le jour où elle sera en HTTPS) ; un réglage apparaît alors. Rien n'est configuré pour HTTPS ni exposé à Internet.
- **Relevé** : toutes les minutes, tant qu'une zone existe et que le site est ouvert (un onglet masqué est relevé au rythme du navigateur). Si le serveur ne répond pas, le panneau le dit : ce n'est pas « rien à signaler ». Une source muette (trains, par exemple) est signalée de même.
- **Conservation** : zones, alertes et alertes déjà signalées sont dans ce navigateur (`localStorage`, `carte-vivante:veille:*`) ; sans stockage, la veille marche en mémoire. Les zones sont aussi dans l'adresse (`veille=`) : un lien partagé les ajoute à celles de la personne qui l'ouvre (elles révèlent donc les lieux surveillés).

### Modes de vision

Le bouton en forme d'œil, parmi les commandes de la carte (en bas à droite, au-dessus de l'analyse de zone), ouvre un menu de quatre rendus appliqués à toute la carte, fond et couches comprises. Le bouton se remplit quand un mode est actif.

| Mode | Rendu |
|---|---|
| Normal | La carte telle quelle (par défaut). |
| Vision nocturne | Monochrome vert phosphore, ombres relevées, léger grain animé, bords assombris. |
| Thermique | Fausses couleurs d'après la luminance : noir, violet, rouge, jaune, blanc. Les surfaces claires (routes, places) ressortent en jaune, les bâtiments et l'eau en violet. |
| Écran cathodique | Lignes de balayage, franges rouge et bleu sur les contours, teinte ambrée, bords assombris. |

- **Seule la carte change** : la recherche, les pastilles, la fiche, la frise et les commandes gardent leurs couleurs. Les clics et les gestes fonctionnent comme d'habitude, les objets restent sélectionnables.
- **Clavier** : `V` passe au mode suivant (annoncé aux lecteurs d'écran) ; dans le menu, les flèches changent de mode, `Entrée` ou `Espace` valide, `Échap` ferme.
- **Mémoire** : le mode est dans l'adresse (`vision=nocturne`, `vision=thermique` ou `vision=cathodique` ; absent : normal), donc un lien partagé rouvre le même rendu. Il est aussi retenu dans le navigateur comme mode de départ quand l'adresse n'en dit rien ; un mode venu d'une adresse n'écrase pas cette préférence.
- **`prefers-reduced-motion`** : le grain de la vision nocturne reste fixe (aucune animation). Aucun mode ne scintille.
- **Lisibilité** : les modes colorés changent le sens des couleurs de la carte (le rouge d'un retard, le bleu d'un TER). Revenir à « Normal » pour lire une légende.

### Visite guidée

Une visite de trois minutes, treize étapes, jouée sur la vraie carte : les trains de France, Paris à l'heure de pointe (rejouée d'après l'enregistrement du serveur), un avion suivi à Roissy, le Pas-de-Calais, les isochrones depuis Paris avec la population à portée, les colonnes d'habitants, le prix du m², les zones blanches des Alpes, les élections, les caméras de vidéoprotection de Paris (cônes de vision à l'échelle de la rue), les photos aériennes des années 50 (le rideau glisse seul), le vent et la pluie, la nuit.

- **Pour la lancer** : bouton « Visite guidée » de l'accueil (première visite), en tête des scènes du catalogue des couches, commande « visite » de la recherche, ou lien avec `#visite` (le drapeau est retiré de l'adresse dès qu'il est lu).
- **Commandes** : pause, étape précédente et suivante, `Espace` (pause), `←` `→` (étape), `Échap` (quitter). Glisser ou zoomer sur la carte met la visite en pause ; la reprise repart de l'étape. Avec `prefers-reduced-motion`, la caméra saute au lieu de voler.
- **Quitter** rend l'état d'avant : caméra, couches, réglages, instant, objet choisi, relief et projection.
- **Données absentes** : une légende n'apparaît qu'une fois les données de l'étape à l'écran (`ready`) ; sans données après un délai (navires, avions la nuit, isochrones non prêtes), l'étape est passée et un avis le dit. Les étapes rejouées cherchent un enregistrement couvert sur sept jours, sinon elles passent au direct ou sont sautées.
- **Ajouter ou changer une étape** : c'est une entrée de `web/src/core/tourStops.ts` (caméra, couches, réglages, instant, test `ready`, légende) ; la mécanique est dans `core/tour.ts`, le panneau dans `ui/Tour.tsx`. En développement, `window.__tour` donne la main depuis la console.

Le fond de carte (OpenFreeMap Liberty) est retouché au chargement (`map/calmStyle.ts`) :
- les routes sont en gris chaud, l'eau en bleu-gris, avec moins de libellés de loin ;
- il passe à une vraie palette sombre la nuit, selon le soleil au centre de la vue.

La couleur reste ainsi réservée aux données.

Les véhicules sont des **maquettes 3D** de près : avions (dès le zoom 6,5), bateaux (zoom 10), trains voiture par voiture (zoom 13), bus, trams et métros (zoom 15). En deçà, ce sont des silhouettes à plat. Les maquettes sont construites dans le code (`web/src/models/`, aucun fichier à télécharger), à leurs dimensions réelles de près et agrandies jusqu'à une taille minimale à l'écran de loin. Le vrai soleil de l'instant affiché les éclaire quand la couche « Jour et nuit » est allumée. Elles passent derrière le relief et les bâtiments ; un train en tunnel reste visible en fantôme à plat. Chaque couche de véhicules a un réglage « Rendu » pour revenir aux symboles à plat.
