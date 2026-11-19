# Fiche Google Play de Vigie (`eu.ducray.vigie`)

Tout ce qu'il faut pour passer des tests internes aux **tests fermés** : textes de la fiche, réponses aux formulaires de la Play Console, visuels. Rédigé le 18 novembre 2026 d'après le code du dépôt (ce qui est collecté, ce qui sort de l'appareil : voir `web/public/confidentialite.html`, qui est la politique de confidentialité à déclarer).

Adresse e-mail de contact : `louis-marie@du-cray.com` (aussi dans `web/public/confidentialite.html`).

## 0. Deux points bloquants à régler avant de cliquer

1. **La politique de confidentialité doit être publique.** Play Console la vérifie sans connexion. Or `vigie.du-cray.eu` est derrière Cloudflare Access : sans règle, l'adresse renvoie la page de connexion et Google refuse la fiche. Ajouter dans Cloudflare Zero Trust une application ou une règle Access « Bypass » (Everyone) pour le chemin **`/confidentialite.html`**, comme c'est déjà le cas pour `/.well-known/assetlinks.json` (voir `docs/deploiement.md`). Vérifier ensuite depuis une fenêtre privée, sans cookie : `https://vigie.du-cray.eu/confidentialite.html` doit s'afficher directement. Le fichier est servi par le serveur (`site()` dans `server/src/api.rs`) avec `content-type: text/html`, `cache-control: no-cache` ; il faut déployer le site pour qu'il existe.
2. **L'examinateur de Google doit pouvoir entrer dans l'application** (voir « Accès à l'application » plus bas). Sans compte de test, l'application est rejetée pour « accès impossible ».

## 1. Textes de la fiche principale (français, langue par défaut)

### Nom de l'application (30 caractères maximum)

```
Vigie : la France en direct
```

27 caractères.

### Description courte (80 caractères maximum)

```
Trains, avions, météo, air, territoire : la France en direct sur une carte 3D.
```

78 caractères.

### Description complète (4 000 caractères maximum)

<!-- DEBUT-DESCRIPTION -->
```
Vigie montre la France en direct sur une carte en 3D. On y voit circuler les trains, les avions et les bateaux, on suit la météo et la qualité de l'air, et on explore le territoire couche après couche. Une frise du temps permet de rejouer ce qui s'est passé.

CE QUE VOUS POUVEZ FAIRE

Transports
• Suivre les trains en circulation et ouvrir le tableau d'affichage d'une gare : prochains départs, retards, ponctualité.
• Voir les avions au-dessus du pays et les bateaux le long des côtes.
• Afficher les bus, trams et métros, les vélos en libre-service, les parkings, les bornes de recharge, le trafic routier et le prix des carburants.
• Calculer jusqu'où l'on va en transports depuis une gare (isochrones).

Météo et environnement
• Radar de pluie, vent animé, foudre en direct, vigilance Météo-France et vigilance crues.
• Niveaux des rivières, marées, séismes récents, feux, satellites.
• Qualité de l'air (indice ATMO), neige et risques d'avalanche en montagne.
• Jour et nuit réels, ombres des bâtiments.

Territoire
• Une ville en 3D : bâtiments, relief, réseau de transport.
• Population au carreau de 200 m, prix de l'immobilier, résultats des élections par bureau de vote.
• Monuments historiques, couverture mobile, relief LiDAR HD de l'IGN, photos aériennes anciennes.
• Actualité locale placée sur la commune concernée : le titre, la source, l'heure et un lien vers l'article chez l'éditeur.

Outils
• Une recherche unique : gare, train, vol, navire, ville, adresse, couche.
• Une frise du temps pour revenir en arrière et rejouer une journée.
• Une visite guidée de trois minutes pour découvrir l'application.
• L'analyse d'une zone que vous dessinez : habitants, prix, couverture mobile, résultats électoraux, accidents, monuments, gares.
• La Veille : surveillez une commune, un département ou un cercle autour de vous et recevez une alerte quand quelque chose s'y passe (vigilance, crue, feu, séisme, avalanche).
• Des modes de vision (nocturne, thermique, cathodique) et le partage d'une vue par lien.

DONNÉES ET LIMITES
Vigie s'appuie sur des données ouvertes et publiques : SNCF, Météo-France, IGN, INSEE, data.gouv.fr, OpenStreetMap, ADS-B et d'autres sources, citées dans l'application. Vigie n'est affiliée à aucun de ces organismes et n'est ni un service officiel, ni un service d'urgence. Les informations sont indicatives, parfois décalées de quelques minutes : pour votre sécurité, référez-vous aux sources officielles.

VIE PRIVÉE
Pas de publicité, pas de mesure d'audience, pas de traceur. Votre position n'est demandée que si vous touchez « Autour de moi » et reste sur votre appareil. La politique de confidentialité complète est accessible dans l'application et à l'adresse https://vigie.du-cray.eu/confidentialite.html.

ACCÈS
L'accès à Vigie est protégé par une connexion sécurisée : il faut un compte, fourni par l'éditeur. Pour demander un accès, écrivez à l'adresse de contact de la fiche.
```
<!-- FIN-DESCRIPTION -->

2927 caractères (maximum 4 000).

### Catégorie, étiquettes

- **Type** : Application.
- **Catégorie suggérée** : **Cartes et navigation** (le manifeste web déclare `navigation`, `travel`, `weather`). Alternative : Météo. **Ne pas choisir « Actualités et magazines »** (voir plus bas : l'application n'en est pas une).
- **Étiquettes** (jusqu'à 5, à prendre dans la liste proposée par la Console, les libellés exacts peuvent différer) : Cartes et navigation, Météo, Transports en commun, Voyages (ou Trains), Informations locales. Ne pas ajouter d'étiquette qui ne figure pas dans la liste.

### Coordonnées (fiche principale > Coordonnées)

| Champ | Valeur |
| --- | --- |
| Adresse e-mail (publique) | `louis-marie@du-cray.com` (obligatoire) |
| Téléphone | laisser vide |
| Site Web | laisser vide (le site est privé), ou `https://vigie.du-cray.eu/` si on accepte que Google tombe sur la page de connexion |
| Politique de confidentialité | `https://vigie.du-cray.eu/confidentialite.html` (publique : voir section 0) |

### Visuels (dans ce dossier)

| Fichier | Rôle | Format |
| --- | --- | --- |
| `icone-512.png` | Icône de l'application | 512 x 512, PNG, carré plein (les coins transparents de l'icône du site sont remplis avec `#0E121B`) |
| `feature-graphic.png` | Image de présentation | 1024 x 500, PNG (source : `feature-graphic.html` + `fond-carte.png` + `icone-512.png`) |
| `captures/01-trains-et-avions.png` | Capture téléphone 1 | 1080 x 1920 |
| `captures/02-paris-3d.png` | Capture téléphone 2 | 1080 x 1920 |
| `captures/03-tableau-de-gare.png` | Capture téléphone 3 | 1080 x 1920 |
| `captures/04-meteo-vent.png` | Capture téléphone 4 | 1080 x 1920 |
| `captures/05-neige-alpes.png` | Capture téléphone 5 | 1080 x 1920 |
| `captures/06-qualite-air.png` | Capture téléphone 6 | 1080 x 1920 |

Les captures sont prises sur l'instance du réseau local (données du jour de la prise : 18 novembre 2026, vers 18 h 40). Elles ne montrent aucune donnée personnelle. Les captures de tablette (7 et 10 pouces) sont facultatives.

## 2. Formulaires « Contenu de l'application » (Politique > Contenu de l'application)

### Politique de confidentialité

URL : `https://vigie.du-cray.eu/confidentialite.html`.

### Accès à l'application

Choisir **« Tout ou partie des fonctionnalités de mon appli sont limitées »** (accès restreint) et ajouter des instructions. Pourquoi : la connexion Cloudflare Access / Authentik bloque tout visiteur sans compte, y compris l'examinateur de Google et le robot de pré-lancement.

Options pour fournir l'accès (je n'ai créé aucun compte) :

1. **Compte de test dédié dans Authentik** (recommandé) : un utilisateur `play-review@…` sur une adresse que vous contrôlez, autorisé dans la politique Cloudflare Access de l'application, sans second facteur interactif (ou avec un code stable que Google peut saisir), mot de passe long dédié, supprimé ou désactivé une fois l'examen terminé. Dans la Console : nom d'utilisateur, mot de passe et instructions : « Ouvrir l'application. La page de connexion de l'organisation s'affiche : saisir l'adresse et le mot de passe fournis. La carte s'ouvre ensuite sans autre étape. » Attention : si Cloudflare Access envoie un code par e-mail (« One-time PIN »), l'examinateur ne peut pas le lire ; il faut que le fournisseur d'identité Authentik accepte directement identifiant et mot de passe.
2. **Règle Access « Bypass » ou ouverture temporaire** pendant la durée de l'examen : plus simple pour Google, mais le site devient public pendant ce temps. À éviter si les couches ne doivent pas l'être.
3. **Sans compte** : l'application serait rejetée. À ne pas faire.

Cocher « Les instructions ne sont pas nécessaires sur certaines versions » seulement si la politique d'accès change entre les versions testées.

### Annonces

**Non**, l'application ne contient pas de publicité.

### Classification du contenu (questionnaire IARC)

- Adresse e-mail de contact : `louis-marie@du-cray.com`.
- Catégorie : **Utilitaire, productivité, communication ou autre**. (Ne pas prendre « Référence, actualités ou éducation » : ce serait la porte vers les déclarations d'application d'actualités.)
- Violence, sang, peur : **Non** à toutes les questions. Contenu sexuel et nudité : **Non**. Grossièretés : **Non**. Drogues, alcool, tabac : **Non**. Jeux d'argent, jeux simulant l'argent : **Non**.
- Contenu généré par les utilisateurs / interaction entre utilisateurs : **Non** (aucun profil, aucun message, aucun partage de contenu entre personnes ; les images de webcams et les titres de presse viennent d'éditeurs tiers, pas des utilisateurs de l'application).
- Partage de la position de l'utilisateur avec d'autres utilisateurs : **Non** (la position ne quitte pas l'appareil ; voir la politique).
- Achats numériques : **Non**.
- Accès web non restreint : **Non** (l'application affiche un seul site ; les liens « Source » ouvrent le navigateur du téléphone).
- Résultat attendu : PEGI 3 / ESRB Everyone / USK 0. Si la Console propose une note plus élevée, relire la réponse qui l'a déclenchée.

### Public cible et contenu

- Tranche d'âge : **18 ans et plus** uniquement. Raisons : l'application n'est pas conçue pour les enfants (couches électorales, immobilier, avions militaires, risques naturels), l'accès est réservé à des comptes que l'éditeur ouvre, et choisir 18+ évite d'entrer dans la politique « Familles » de Google (obligations supplémentaires de conformité sur les SDK et la publicité, qui ne servent à rien ici). Si une tranche plus jeune était cochée, Google exigerait en plus de justifier l'absence d'attrait pour les enfants.
- L'application ne contient aucun élément qui attire les enfants.

### Applications d'actualités

**Non, ce n'est pas une application d'actualités.** Raisonnement : la couche « Actualité locale » ne montre que le titre, la source, l'heure et un lien vers l'article chez l'éditeur ; elle est une couche parmi une quarantaine, sur une carte dont l'objet principal est la visualisation de données en direct (transports, météo, territoire). La fiche ne se présente pas comme une source d'actualités et ne doit pas utiliser la catégorie « Actualités et magazines ». Le critère de Google porte sur l'application telle qu'elle se présente et sur sa catégorie. Risque résiduel faible : si Google la jugeait « actualités », la Console demanderait un site d'éditeur et des informations sur les sources ; la déclaration serait alors à reprendre.

### Application gouvernementale

**Non.** Vigie n'est ni développée par un organisme public ni pour son compte (la description le dit : « Vigie n'est affiliée à aucun de ces organismes »).

### Santé

Choisir **« Mon application n'a aucune des fonctionnalités de santé »** (les alertes météo, la qualité de l'air et l'avalanche sont de l'information publique, pas des fonctions de santé).

### Fonctionnalités financières

**Non** : aucun paiement, aucun prêt, aucune cryptomonnaie. (Les prix de l'immobilier et des carburants sont de l'information publique.)

### ID de publicité

**Non** : l'application n'utilise pas l'identifiant publicitaire.

### Sécurité des données (Data safety)

Principe : ce que **le code de Vigie** envoie hors de l'appareil, plus ce que la connexion Cloudflare Access / Authentik traite pour le compte de l'éditeur. Le code ne contient ni publicité, ni mesure d'audience, ni SDK tiers (vérifié : ni `gtag`, ni `sentry`, ni `analytics` dans `web/` ; le service worker ne garde que la coque).

**Questions générales**

| Question | Réponse |
| --- | --- |
| L'application collecte-t-elle ou partage-t-elle des types de données obligatoires ? | **Oui** (adresse e-mail, via la connexion) |
| Toutes les données collectées sont-elles chiffrées en transit ? | **Oui** (HTTPS, Cloudflare) |
| Les utilisateurs peuvent-ils demander la suppression de leurs données ? | **Oui**, en écrivant à l'adresse de contact (suppression du compte de connexion) |
| Application « Familles » / conforme à une validation indépendante | Non / Non applicable |

**Types de données**

| Type | Collecté | Partagé | Obligatoire ou facultatif | Finalité | Remarque |
| --- | --- | --- | --- | --- | --- |
| Informations personnelles > **Adresse e-mail** | Oui | Non | Obligatoire | Gestion du compte (authentification), sécurité | Traitée par Cloudflare Access et Authentik pour le compte de l'éditeur (sous-traitants : Google ne compte pas cela comme un « partage »). Le code de Vigie ne la reçoit pas. |
| Position > **Position approximative** | Oui, ou « non » si traitée de façon éphémère (voir remarque) | Non | Facultatif | Fonctionnalités de l'application | Seulement si l'utilisateur crée une zone « Surveiller autour de moi » : un cercle centré sur sa position **arrondie à environ 1 km** est envoyé au serveur pour calculer la réponse, sans être conservé (traitement éphémère). Position exacte (« Autour de moi ») : jamais envoyée. Choix prudent : la déclarer comme collectée et facultative. |
| Identifiants de l'appareil ou autres ID > adresse IP | Voir remarque | Non | Obligatoire | Sécurité, prévention de la fraude | Cloudflare et Authentik voient l'adresse IP à la connexion (comme tout service web). Le serveur de Vigie ne la journalise pas. Google ne la classe pas toujours comme « identifiant » ; si la Console propose « Identifiants de l'appareil ou autres ID » pour cela, la déclarer ici : collecté, non partagé, obligatoire, finalité sécurité. |
| Tout le reste (nom, adresse postale, téléphone, paiements, santé, messages, photos, contacts, activité dans l'appli, historique de navigation, plantages, diagnostics, ID publicitaire) | Non | Non | n/a | n/a | Aucune collecte : pas de mesure d'audience, pas de journal d'accès côté serveur, pas de rapport de plantage envoyé. |

**Avertissement** : je n'ai pas pu vérifier à votre place les règles internes de Cloudflare et d'Authentik (durée de conservation des journaux de connexion) ni l'état de la Console de Google à cette date. Les cases ci-dessus suivent la définition de Google (« collecter » = transmettre hors de l'appareil, sauf traitement éphémère ; un sous-traitant qui traite pour votre compte n'est pas un « partage »). Relire chaque case au moment de la saisie ; en cas de doute, cocher « collecté » plutôt que « non collecté ». Les tiers contactés directement par le navigateur (fonds de carte, IGN, EMSC, etc.) voient l'adresse IP et la zone affichée, comme pour tout site web consulté dans Chrome : l'application étant une Trusted Web Activity, ces requêtes sont celles de Chrome, pas d'un SDK de l'application ; elles sont toutes listées dans la politique de confidentialité (section 7).

**Pratiques de sécurité** : chiffrement en transit oui ; suppression sur demande oui (e-mail) ; « conforme à la politique Familles » non ; examen de sécurité indépendant non.

### Compte et suppression

La Console demande si l'application « permet de créer un compte ». Réponse : **non** (les comptes sont créés par l'éditeur dans Authentik, jamais depuis l'application) ; en conséquence, aucune URL de suppression de compte dans l'application n'est exigée. Indiquer la procédure de suppression par e-mail dans la politique (déjà fait, section 9).

## 3. Écrans de la Play Console, dans l'ordre, et quoi cliquer

Menu de gauche, application **Vigie**.

1. **Tableau de bord > « Configurer votre application »** : la liste des tâches à faire. Les écrans suivants y mènent.
2. **Politique > Contenu de l'application** (ou Tableau de bord > tâche « Contenu de l'application ») :
   - *Règles de confidentialité* : coller l'URL de la politique > Enregistrer.
   - *Accès à l'application* : « Tout ou partie des fonctionnalités sont limitées » > Ajouter des instructions > nom, identifiants, explications (section 2) > Enregistrer.
   - *Annonces* : « Non » > Enregistrer.
   - *Classification du contenu* : Démarrer le questionnaire > e-mail de contact > catégorie « Utilitaire… » > réponses « Non » > Enregistrer > Envoyer.
   - *Audience cible et contenu* : tranche « 18 ans et plus » > « Non » à l'attrait pour les enfants > Enregistrer.
   - *Applications d'actualités* : « Mon application n'est pas une application d'actualités » > Enregistrer.
   - *Sécurité des données* : Démarrer > répondre comme en section 2 (e-mail, position approximative facultative, chiffrement, suppression sur demande) > Aperçu > Enregistrer.
   - *Application gouvernementale* : « Non ».
   - *Fonctionnalités financières* : « Mon application ne propose aucune fonctionnalité financière ».
   - *Santé* : « Aucune fonctionnalité de santé ».
   - *ID de publicité* : « Non ».
3. **Croissance > Présence sur le Store > Fiche Play Store principale** :
   - Détails de l'application : nom (27 caractères), description courte, description complète (section 1).
   - Éléments graphiques : Icône (`icone-512.png`), Image de présentation (`feature-graphic.png`), Captures d'écran du téléphone (les six de `captures/`, dans l'ordre 01 à 06). Pas de vidéo.
   - Enregistrer, puis **Envoyer pour examen** si la Console le propose (l'examen de la fiche est séparé de celui de la version).
4. **Croissance > Présence sur le Store > Paramètres du Store** : catégorie « Cartes et navigation », étiquettes, coordonnées (e-mail, site laissé vide). Type : Application. Enregistrer.
5. **Tests et publication > Tests > Tests fermés** :
   - Créer une piste (ou utiliser « Tests fermés – Alpha ») > **Créer une version** > envoyer le `.aab` signé (voir `android/README.md`) ou promouvoir la version du test interne (« Promouvoir la version > Tests fermés »). Notes de version : une ligne en français entre balises `<fr-FR>…</fr-FR>`.
   - Onglet **Testeurs** : choisir la liste d'e-mails ou un groupe Google (testeurs inscrits avec leur compte Google ; voir ci-dessous les règles du compte personnel), définir les pays (France au minimum) et l'adresse ou l'URL de commentaires (`louis-marie@du-cray.com`).
   - **Examiner la version > Lancer le déploiement** pour les tests fermés.
6. **Tableau de bord** : vérifier qu'aucune tâche ne reste en rouge. Après le déploiement, Google examine l'application (souvent quelques heures à quelques jours). Le lien d'adhésion au test s'affiche dans l'onglet Testeurs : à envoyer aux testeurs, qui doivent aussi se connecter à Vigie (voir « Accès »).
7. **Tests et publication > Production** : « Candidater pour la production » n'est possible qu'après la durée de test exigée.

### À vérifier dans la Console (règles que je ne peux pas confirmer à cette date)

Pour un compte développeur **personnel** créé après novembre 2023, Google exigeait, à ma connaissance, un test fermé avec **au moins 12 testeurs inscrits depuis 14 jours consécutifs** avant de demander l'accès à la production. La Console affiche les conditions du compte actuel dans « Tests fermés » ou dans le tableau de bord : les relire, car elles ont déjà changé une fois. Chaque testeur doit pouvoir se connecter à Vigie (comptes Authentik, voir plus haut), sans quoi un test « actif » ne prouve rien.

## 4. Régénérer les visuels

Les captures sont prises sur l'instance du réseau local `http://192.168.0.75:8787/` (jamais `vigie.du-cray.eu`), avec Playwright (viewport 412 x 732, facteur d'échelle 1080/412, ramené à 1080 x 1920 par `sips -z 1920 1080`). Les adresses (`#vue=…&couches=…&t=direct`) décrivent chaque vue :

| Capture | Adresse (fragment) | Remarque |
| --- | --- | --- |
| 01 | `#vue=6.3/47.3/2.6/0/50&couches=trains,avions,jour-nuit&t=direct` | |
| 02 | `#vue=15.8/48.8530/2.3499/-25/60&couches=trains,transports&t=direct` | Notre-Dame, Paris |
| 03 | `#vue=14/45.7605/4.8590/0/50&couches=trains,voies,transports&t=direct` | puis recherche « Lyon Part Dieu » et feuille tirée vers le haut |
| 04 | `#vue=5.6/46.6/2.5/0/30&couches=pluie,vent,vigilance-meteo,jour-nuit&t=direct` | |
| 05 | `#vue=8.3/45.3/6.6/0/55&couches=neige&t=direct` | Alpes du Nord |
| 06 | `#vue=5.6/46.6/2.5/0/30&couches=air,vent,jour-nuit&t=direct` | |

L'accueil de première visite est neutralisé en posant `localStorage['carte-vivante:accueil-vu'] = '1'` avant le chargement. L'image de présentation : `feature-graphic.html` rendue à 1024 x 500 (facteur 1) avec `fond-carte.png` (capture de la carte sans interface) ; l'icône : `web/public/icons/icon-512.png` posée sur `#0E121B`.
