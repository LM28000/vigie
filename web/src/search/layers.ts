/**
 * Couches, réglages et scènes : « pluie » propose d'afficher le radar de pluie,
 * « carburants prix » ses réglages, « météo » la scène du même nom.
 */
import type { LayerModule } from '../core/module';
import type { ModuleManager } from '../core/moduleManager';
import { isShown } from './access';
import { matchScore, pad, rank, TopK, type Query } from './normalize';
import { SCENES } from './scenes';
import { SCENES as CORE_SCENES, applyScene } from '../core/scenes';
import type { Provider, SearchResult } from './types';

/** Mots que les gens tapent pour une couche, en plus de son nom. */
const SYNONYMS: Record<string, string> = {
  trains: 'train sncf tgv ter gare rail ferroviaire',
  voies: 'voies ferrees rails chemin de fer',
  trafic: 'trafic routier route bouchons embouteillages circulation',
  avions: 'avion vols vol aeroport ciel',
  bateaux: 'bateau navire navires ferry port mer ais',
  transports: 'bus tram tramway metro transports en commun',
  velos: 'velo velib bicyclette libre service',
  vigicrues: 'crues crue inondation inondations rivieres cours d eau troncon vigilance crue fleuve debordement',
  'vigilance-meteo': 'meteo orages alerte alertes tempete canicule vigilance orange rouge jaune departement grand froid neige verglas vent violent inondation avalanche',
  air: 'air pollution qualite ozone particules pm10 pm2 no2 atmo indice episode smog station stations mesure mesures concentration geodair lcsqa',
  pollen: 'pollen pollens allergie allergies allergique rhume des foins graminees bouleau ambroisie aulne olivier armoise atmo indice pollinique',
  feux: 'feu incendie incendies foret feux de foret point chaud brulage nasa firms',
  seismes: 'seisme tremblement de terre secousse magnitude sismique emsc',
  electricite: 'energie courant reseau electrique production nucleaire eolien solaire hydraulique rte consommation region centrale electrique mix bretagne normandie hauts de france grand est pays de la loire nouvelle aquitaine occitanie auvergne rhone alpes provence alpes cote d azur centre val de loire bourgogne franche comte ile de france',
  bornes: 'recharge voiture electrique irve',
  carburants: 'carburant carburants essence diesel gazole gasoil sp95 sp98 e10 e85 superethanol gpl gplc sans plomb pompe plein prix du litre station service stations',
  'jour-nuit': 'soleil crepuscule nuit jour terminateur aube coucher du soleil lever',
  'ombres-batiments': 'soleil ombre',
  satellites: 'espace iss orbite satellite starlink station spatiale tiangong hubble gps galileo',
  pluie: 'meteo radar precipitations averse',
  vent: 'rafales meteo',
  neige: 'neige avalanche avalanches risque massif montagne ski enneigement bulletin bra bera alpes pyrenees',
  parkings: 'parking parkings stationnement garer places libres parc relais',
  cameras: 'camera cameras webcam webcams videoprotection videosurveillance surveillance cctv',
  marees: 'maree marees maregraphe port niveau de la mer ocean pleine mer basse mer coefficient littoral',
  rivieres: 'riviere rivieres fleuve fleuves hauteur d eau debit station hydrometrique cours d eau loire seine rhone garonne',
  monuments: 'monument monuments historiques patrimoine chateau eglise cathedrale abbaye merimee classe inscrit',
  'couverture-mobile': 'couverture mobile reseau 4g 5g telephone orange sfr bouygues free arcep antenne zone blanche',
  immobilier: 'immobilier prix m2 metre carre logement appartement maison dvf vente',
  population: 'population habitants densite insee carreau demographie',
  accidents: 'accident accidents route securite routiere mortel victimes',
  lidar: 'lidar relief ign mnt hauteur arbres',
  photoreal: 'photoreel photorealiste photoreelle 3d google realiste vue realiste cesium',
  'satellite-jour': 'satellite du jour imagerie image satellite photo satellite sentinel nasa gibs modis',
  'brouillage-gps': 'brouillage gps gnss interference leurrage jamming',
  foudre: 'foudre eclair eclairs orage impacts mtg',
  photos: 'photos aeriennes anciennes remonter le temps ign histoire',
  isochrones: 'isochrone isochrones temps de trajet accessibilite zone atteignable',
  evenements: 'evenement evenements concert concerts spectacle spectacles exposition expositions marche brocante festival fete sortie sorties agenda animation',
  actualite: 'actualite locale presse journal titres info nouvelles article france 3 ici france bleu',
  elections: 'vote scrutin presidentielle europeennes legislatives resultats bureau de vote participation',
};

interface LayerIndex {
  layers: Array<{ text: string; name: string; module: LayerModule }>;
  settings: Array<{ text: string; module: LayerModule; settingId: string; settingLabel: string; value: string; label: string }>;
  scenes: Array<{ text: string; scene: (typeof SCENES)[number] }>;
}

let index: LayerIndex | undefined;

/** Les modules ne changent pas pendant la session : l'index est construit une fois. */
function build(manager: ModuleManager): LayerIndex {
  if (index) return index;
  index = { layers: [], settings: [], scenes: [] };
  for (const module of manager.modules) {
    index.layers.push({ text: pad(`${module.name} ${SYNONYMS[module.id] ?? ''}`), name: pad(module.name), module });
    for (const setting of module.settings ?? []) {
      for (const option of setting.options) {
        index.settings.push({
          text: pad(`${module.name} ${setting.label} ${option.label}`),
          module,
          settingId: setting.id,
          settingLabel: setting.label,
          value: option.value,
          label: option.label,
        });
      }
    }
  }
  for (const scene of SCENES) index.scenes.push({ text: pad(`scene ${scene.name} ${scene.summary} ${scene.keywords}`), scene });
  return index;
}

function sceneBonus(name: string, query: Query): number {
  const padded = pad(name);
  if (padded === ` ${query.text} `) return 120;
  return matchScore(padded, query, true) > 0 ? 50 : 0;
}

export const layersProvider: Provider = {
  search(query: Query, { manager }) {
    const { layers, settings, scenes } = build(manager);
    const out: SearchResult[] = [];

    for (const { text, name, module } of layers) {
      const match = matchScore(text, query, true);
      if (match === 0) continue;
      const shown = isShown(manager, module.id);
      // Le nom de la couche compte plus que ses synonymes : « pluie » est d'abord le Radar de pluie.
      const byName = matchScore(name, query, true) > 0;
      out.push({
        key: `couche:${module.id}`,
        kind: 'action',
        title: `${shown ? 'Masquer' : 'Afficher'} la couche ${module.name}`,
        subtitle: shown ? 'Couche affichée' : 'Couche masquée',
        score: rank(text, query, match) + (byName ? 40 : 0),
        run: () => manager.setVisible(module.id, !shown),
      });
    }

    const topSettings = new TopK<LayerIndex['settings'][number]>(3);
    for (const entry of settings) {
      // Seuls les réglages qui changent quelque chose : pas l'option déjà choisie.
      if (manager.getSnapshot()[entry.module.id]?.settings[entry.settingId] === entry.value) continue;
      const match = matchScore(entry.text, query);
      if (match > 0) topSettings.push(rank(entry.text, query, match) - 15 + (isShown(manager, entry.module.id) ? 30 : 0), entry);
    }
    for (const { score, item } of topSettings.result()) {
      out.push({
        key: `reglage:${item.module.id}:${item.settingId}:${item.value}`,
        kind: 'action',
        title: `${item.module.name} : ${item.settingLabel.toLowerCase()} ${item.label.toLowerCase()}`,
        subtitle: 'Réglage de la couche',
        score,
        run: () => {
          manager.setVisible(item.module.id, true);
          manager.setSetting(item.module.id, item.settingId, item.value);
        },
      });
    }

    for (const { text, scene } of scenes) {
      const match = matchScore(text, query, true);
      if (match === 0) continue;
      out.push({
        key: `scene:${scene.id}`,
        kind: 'action',
        title: `Scène « ${scene.name} »`,
        subtitle: scene.summary,
        // Le nom de la scène : « météo » ouvre d'abord la scène, avant ses couches prises une à une.
        score: rank(text, query, match) + sceneBonus(scene.name, query),
        run: () => {
          const core = CORE_SCENES.find((candidate) => candidate.id === scene.id);
          if (core) applyScene(manager, core);
        },
      });
    }
    return out;
  },
};
