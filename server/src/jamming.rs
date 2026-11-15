//! Brouillage GPS, deviné de loin : la qualité de position que les avions annoncent eux-mêmes.
//!
//! Un avion en ADS-B diffuse avec sa position deux indicateurs de la qualité de son GPS : le **NIC** (rayon dans lequel la
//! position est garantie) et le **NACp** (précision annoncée). Quand un signal GPS est brouillé ou usurpé (Baltique,
//! Méditerranée orientale, Moyen-Orient, mais aussi des alertes plus près de nous), ces valeurs s'effondrent d'un coup
//! chez tous les avions d'une même zone. La méthode est celle de gpsjam.org : on compte, par case de la grille, les avions
//! vus et ceux dont la position est dégradée, et la part de ces derniers est la mesure.
//!
//! **Seuil retenu** : un avion est « dégradé » quand son NIC est inférieur à 7 (rayon de protection de plus de 0,2 mille
//! nautique) ou son NACp inférieur à 8 (précision au-delà de 93 m), c'est-à-dire sous ce que fait un récepteur GPS sain
//! (en croisière, NIC 8 à 11 et NACp 8 à 11 : voir les réponses d'adsb.lol et adsb.fi). Ne comptent que :
//! - les avions en vol (au sol, la position de surface n'a pas les mêmes valeurs) ;
//! - les positions ADS-B reçues telles quelles : ni MLAT (calculée par les récepteurs, sans qualité GPS), ni TIS-B (relayée
//!   par le sol) ;
//! - les transpondeurs de version 2 (ou de version inconnue) : les versions 0 et 1 définissent NIC et NACp autrement, et
//!   beaucoup d'appareils légers anciens annoncent des valeurs basses sans aucun brouillage.
//!
//! **Ce que c'est, et ce que ce n'est pas.** C'est une estimation indirecte : on ne mesure pas le brouillage, on voit ses
//! effets sur les avions qui passent. Une case sans avion n'a pas de mesure ; une case avec peu d'avions est trop incertaine
//! (moins de `MIN_AIRCRAFT`, elle est montrée en gris) ; deux avions dégradés au moins sont exigés (`MIN_DEGRADED`) pour
//! qu'une case soit marquée, car un seul transpondeur défectueux ne fait pas un brouillage. Un avion brouillé peut aussi
//! cesser d'émettre sa position : les cases très touchées perdent alors des avions au lieu d'en gagner.
//!
//! **Fenêtre glissante** : un avion compte une fois par case dans les `WINDOW_S` dernières secondes, et il est dégradé s'il
//! l'a été à un instant de cette fenêtre. La mémoire reste petite : une entrée (24 octets environ) par avion et par case
//! traversée, élaguées chaque minute (quelques milliers d'entrées en tout).

use std::collections::HashMap;

use serde::Serialize;

/// Côté d'une case, en degrés (de latitude et de longitude : une case fait environ 55 km sur 38 km à 47° N).
pub const CELL_DEG: f64 = 0.5;
/// Durée de la fenêtre glissante, en secondes.
pub const WINDOW_S: u32 = 20 * 60;
/// Sous ce nombre d'avions vus dans la fenêtre, la part d'avions dégradés n'est pas significative.
pub const MIN_AIRCRAFT: u32 = 5;
/// Nombre d'avions dégradés à partir duquel une case est marquée (en dessous : un transpondeur isolé, pas un brouillage).
pub const MIN_DEGRADED: u32 = 2;
/// NIC en dessous duquel la position est dégradée.
pub const NIC_MIN: f64 = 7.0;
/// NACp en dessous duquel la position est dégradée.
pub const NACP_MIN: f64 = 8.0;

/// La position d'un avion est-elle dégradée ? `None` : l'avion ne dit rien qu'on puisse comparer au seuil (aucun indicateur,
/// transpondeur de version 0 ou 1, au sol) et il ne compte pas. `positioned_by_adsb` : faux pour une position MLAT ou TIS-B.
pub fn degraded(nic: Option<f64>, nac_p: Option<f64>, version: Option<f64>, ground: bool, positioned_by_adsb: bool) -> Option<bool> {
    if ground || !positioned_by_adsb || version.is_some_and(|v| v < 2.0) {
        return None;
    }
    if nic.is_none() && nac_p.is_none() {
        return None;
    }
    Some(nic.is_some_and(|n| n < NIC_MIN) || nac_p.is_some_and(|n| n < NACP_MIN))
}

/// Ce qu'on retient d'un avion dans une case : le dernier instant où il y a été vu, et le dernier où sa position était dégradée.
#[derive(Clone, Copy)]
struct Entry {
    seen: u32,
    degraded: Option<u32>,
}

/// Les avions vus récemment, par case.
#[derive(Default)]
pub struct Grid {
    entries: HashMap<(u32, i16, i16), Entry>,
}

/// Une case de la réponse : son coin sud-ouest, le nombre d'avions vus dans la fenêtre, et ceux dont la position est dégradée.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Cell {
    pub lon: f64,
    pub lat: f64,
    pub n: u32,
    pub bad: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Out {
    /// Instant du calcul (secondes UTC).
    updated_at: i64,
    cell_deg: f64,
    window_s: u32,
    /// Durée réellement couverte par les relevés : plus courte que la fenêtre juste après un démarrage du serveur.
    covered_s: u32,
    min_aircraft: u32,
    min_degraded: u32,
    cells: Vec<Cell>,
}

fn cell_of(lon: f64, lat: f64) -> (i16, i16) {
    ((lon / CELL_DEG).floor() as i16, (lat / CELL_DEG).floor() as i16)
}

impl Grid {
    /// Note un avion (`hex` : son code ICAO, 24 bits) à la position donnée, à l'instant `now` (secondes depuis un repère fixe).
    pub fn observe(&mut self, hex: u32, lon: f64, lat: f64, degraded: bool, now: u32) {
        let (ix, iy) = cell_of(lon, lat);
        let entry = self.entries.entry((hex, ix, iy)).or_insert(Entry { seen: now, degraded: None });
        entry.seen = now;
        if degraded {
            entry.degraded = Some(now);
        }
    }

    /// Oublie ce qui est sorti de la fenêtre.
    pub fn prune(&mut self, now: u32) {
        self.entries.retain(|_, e| now.saturating_sub(e.seen) <= WINDOW_S);
    }

    /// Les cases, avec leurs comptes sur la fenêtre qui se termine à `now`. Rangées du sud au nord, de l'ouest à l'est.
    pub fn cells(&self, now: u32) -> Vec<Cell> {
        let mut counts: HashMap<(i16, i16), (u32, u32)> = HashMap::new();
        for (&(_, ix, iy), entry) in &self.entries {
            if now.saturating_sub(entry.seen) > WINDOW_S {
                continue;
            }
            let count = counts.entry((ix, iy)).or_default();
            count.0 += 1;
            if entry.degraded.is_some_and(|d| now.saturating_sub(d) <= WINDOW_S) {
                count.1 += 1;
            }
        }
        let mut cells: Vec<Cell> = counts
            .into_iter()
            .map(|((ix, iy), (n, bad))| Cell { lon: f64::from(ix) * CELL_DEG, lat: f64::from(iy) * CELL_DEG, n, bad })
            .collect();
        cells.sort_by(|a, b| a.lat.total_cmp(&b.lat).then(a.lon.total_cmp(&b.lon)));
        cells
    }

    /// La réponse de l'API. `uptime_s` : secondes écoulées depuis le début des relevés (au plus la fenêtre est couverte).
    pub fn response(&self, now: u32, uptime_s: u32, updated_at: i64) -> serde_json::Result<Vec<u8>> {
        serde_json::to_vec(&Out {
            updated_at,
            cell_deg: CELL_DEG,
            window_s: WINDOW_S,
            covered_s: uptime_s.min(WINDOW_S),
            min_aircraft: MIN_AIRCRAFT,
            min_degraded: MIN_DEGRADED,
            cells: self.cells(now),
        })
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn le_seuil_est_nic_7_et_nacp_8() {
        let d = |nic, nac| degraded(nic, nac, Some(2.0), false, true);
        assert_eq!(d(Some(8.0), Some(9.0)), Some(false), "récepteur sain");
        assert_eq!(d(Some(7.0), Some(8.0)), Some(false), "pile au seuil : sain");
        assert_eq!(d(Some(6.0), Some(9.0)), Some(true), "NIC trop bas");
        assert_eq!(d(Some(8.0), Some(7.0)), Some(true), "NACp trop bas");
        assert_eq!(d(Some(0.0), Some(0.0)), Some(true), "tout à zéro : brouillage typique");
        assert_eq!(d(Some(8.0), None), Some(false), "un seul indicateur suffit");
        assert_eq!(d(None, Some(5.0)), Some(true));
        assert_eq!(d(None, None), None, "rien à comparer");
    }

    #[test]
    fn ne_comptent_ni_le_sol_ni_mlat_ni_les_vieux_transpondeurs() {
        assert_eq!(degraded(Some(0.0), Some(0.0), Some(2.0), true, true), None, "au sol");
        assert_eq!(degraded(Some(0.0), Some(0.0), Some(2.0), false, false), None, "MLAT ou TIS-B");
        assert_eq!(degraded(Some(0.0), Some(0.0), Some(1.0), false, true), None, "version 1");
        assert_eq!(degraded(Some(0.0), None, Some(0.0), false, true), None, "version 0");
        assert_eq!(degraded(Some(0.0), None, None, false, true), Some(true), "version inconnue : on garde");
    }

    #[test]
    fn la_case_est_au_demi_degre() {
        assert_eq!(cell_of(2.3, 48.8), (4, 97));
        assert_eq!(cell_of(-0.1, 48.99), (-1, 97), "ouest du méridien de Greenwich");
        assert_eq!(cell_of(2.5, 49.0), (5, 98), "le bord appartient à la case de droite et du haut");
    }

    #[test]
    fn compte_les_avions_une_fois_par_case() {
        let mut grid = Grid::default();
        // Le même avion relevé trois fois dans la case : un seul avion.
        for t in [0, 5, 10] {
            grid.observe(0xabc, 2.3, 48.8, false, t);
        }
        grid.observe(0xdef, 2.4, 48.7, true, 10);
        let cells = grid.cells(10);
        assert_eq!(cells, vec![Cell { lon: 2.0, lat: 48.5, n: 2, bad: 1 }]);
    }

    #[test]
    fn un_avion_qui_traverse_compte_dans_chaque_case() {
        let mut grid = Grid::default();
        grid.observe(1, 2.1, 48.8, false, 0);
        grid.observe(1, 2.6, 48.8, true, 60);
        let cells = grid.cells(60);
        assert_eq!(cells.len(), 2);
        assert_eq!((cells[0].n, cells[0].bad), (1, 0), "case de départ : sain");
        assert_eq!((cells[1].n, cells[1].bad), (1, 1), "case d'arrivée : dégradé");
    }

    #[test]
    fn la_fenetre_glisse() {
        let mut grid = Grid::default();
        grid.observe(1, 2.3, 48.8, true, 0);
        grid.observe(2, 2.3, 48.8, false, 600);
        // À 10 min : les deux sont dans la fenêtre.
        assert_eq!(grid.cells(600)[0], Cell { lon: 2.0, lat: 48.5, n: 2, bad: 1 });
        // À 21 min : le premier (vu il y a plus de 20 min) a disparu, avec sa dégradation.
        let later = WINDOW_S + 60;
        assert_eq!(grid.cells(later)[0], Cell { lon: 2.0, lat: 48.5, n: 1, bad: 0 });
        grid.prune(later);
        assert_eq!(grid.len(), 1);
        // Plus rien une fois le second sorti de la fenêtre.
        grid.prune(600 + WINDOW_S + 1);
        assert!(grid.cells(600 + WINDOW_S + 1).is_empty());
    }

    #[test]
    fn la_degradation_ancienne_sort_de_la_fenetre_avant_l_avion() {
        // L'avion a été dégradé à t = 0 puis revu sain jusqu'à t = 1 300 : la dégradation date de plus de 20 min.
        let mut grid = Grid::default();
        grid.observe(1, 2.3, 48.8, true, 0);
        for t in (60..=1300).step_by(60) {
            grid.observe(1, 2.3, 48.8, false, t);
        }
        assert_eq!(grid.cells(1300)[0].bad, 0);
        assert_eq!(grid.cells(1300)[0].n, 1);
    }

    #[test]
    fn la_reponse_est_compacte_et_dit_la_duree_couverte() {
        let mut grid = Grid::default();
        grid.observe(1, 2.3, 48.8, true, 30);
        let json: serde_json::Value = serde_json::from_slice(&grid.response(30, 30, 1_794_000_000).unwrap()).unwrap();
        assert_eq!(json["coveredS"], 30, "juste après le démarrage : 30 s de relevés seulement");
        assert_eq!(json["windowS"], WINDOW_S);
        assert_eq!(json["cellDeg"], 0.5);
        assert_eq!(json["cells"][0], serde_json::json!({"lon": 2.0, "lat": 48.5, "n": 1, "bad": 1}));
        let long: serde_json::Value = serde_json::from_slice(&grid.response(30, 90_000, 0).unwrap()).unwrap();
        assert_eq!(long["coveredS"], WINDOW_S);
    }
}
