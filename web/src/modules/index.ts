/**
 * Registre des modules. Pour ajouter une couche : écrire son module dans ce
 * dossier, puis l'ajouter à cette liste. L'ordre est celui d'affichage dans
 * le panneau (à l'intérieur de chaque catégorie).
 */
import type { LayerModule } from '../core/module';
import { aerialPhotos } from './aerialPhotos';
import { accidents } from './accidents';
import { air } from './air';
import { bikes } from './bikes';
import { buildingShadows } from './buildingShadows';
import { cameras } from './cameras';
import { chargers } from './chargers';
import { couverture } from './couverture';
import { dayNight } from './dayNight';
import { earthquakes } from './earthquakes';
import { elections } from './elections';
import { fires } from './fires';
import { floods } from './floods';
import { fuel } from './fuel';
import { immobilier } from './immobilier';
import { isochrones } from './isochrones';
import { jamming } from './jamming';
import { lightning } from './lightning';
import { lidar } from './lidar';
import { monuments } from './monuments';
import { parkings } from './parkings';
import { planes } from './planes';
import { population } from './population';
import { power } from './power';
import { railways } from './railways';
import { rain } from './rain';
import { satelliteImagery } from './satelliteImagery';
import { satellites } from './satellites';
import { ships } from './ships';
import { rivers } from './rivers';
import { tides } from './tides';
import { traffic } from './traffic';
import { trains } from './trains';
import { transit } from './transit';
import { weatherAlerts } from './weatherAlerts';
import { wind } from './wind';

export const MODULES: LayerModule[] = [
  trains, railways, isochrones, traffic, planes, ships, transit, bikes, parkings,
  floods, rivers, tides, weatherAlerts, air, fires, earthquakes,
  power, chargers, fuel, population, couverture, immobilier, elections,
  dayNight, buildingShadows, satellites, jamming, rain, lightning, satelliteImagery, wind,
  aerialPhotos, lidar, cameras, monuments, accidents,
];
