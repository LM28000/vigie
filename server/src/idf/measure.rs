//! Mesures sur le vrai GTFS d'Île-de-France (ignorées par défaut : elles demandent le zip de 114 Mo et du temps).
//!
//! ```text
//! IDFM_ZIP=/chemin/IDFM-gtfs.zip IDFM_MODES=metro,tram,train,cable,bus \
//!   cargo test --release --no-run   # puis lancer le binaire de test avec : mesure_gtfs_idfm --ignored --nocapture
//! ```
//!
//! Chaque lancement est un processus à part, pour que `ps` et `/usr/bin/time -l` donnent la mémoire de ce mode seul.
//! La mesure de rapprochement n'a pas besoin de la clé PRIM : elle fabrique, d'après le GTFS lui-même, ce que le SIRI annoncerait
//! (les prochains arrêts de chaque course en cours, avec des retards pseudo-aléatoires), en cachant l'identifiant de la course, puis
//! vérifie que `match_journeys` la retrouve. La vérité est connue : on mesure donc le taux de bonnes attributions et de mauvaises.

use std::time::Instant;

use super::*;
use crate::gtfs_compact;

/// Mémoire résidente de ce processus, en Mo (`ps`, macOS et Linux).
fn rss_mb() -> f64 {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().expect("ps");
    String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().unwrap_or(0.0) / 1024.0
}

/// Un allocateur qui compte les octets vivants et leur plus haut niveau : la mesure du tas, exacte et indépendante de ce que
/// l'allocateur du système rend ou non au système (le `ps` ci-dessus y est sensible, surtout sous macOS).
mod tas {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

    pub struct Compteur;
    static VIVANT: AtomicUsize = AtomicUsize::new(0);
    static PIC: AtomicUsize = AtomicUsize::new(0);

    unsafe impl GlobalAlloc for Compteur {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let p = unsafe { System.alloc(layout) };
            if !p.is_null() {
                let now = VIVANT.fetch_add(layout.size(), Relaxed) + layout.size();
                PIC.fetch_max(now, Relaxed);
            }
            p
        }
        unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
            unsafe { System.dealloc(p, layout) };
            VIVANT.fetch_sub(layout.size(), Relaxed);
        }
        unsafe fn realloc(&self, p: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            let q = unsafe { System.realloc(p, layout, new_size) };
            if !q.is_null() {
                if new_size >= layout.size() {
                    let now = VIVANT.fetch_add(new_size - layout.size(), Relaxed) + new_size - layout.size();
                    PIC.fetch_max(now, Relaxed);
                } else {
                    VIVANT.fetch_sub(layout.size() - new_size, Relaxed);
                }
            }
            q
        }
    }

    /// Octets vivants maintenant, en Mo.
    pub fn vivant_mo() -> f64 {
        VIVANT.load(Relaxed) as f64 / 1_048_576.0
    }
    /// Plus haut niveau depuis le dernier `repartir_pic`, en Mo.
    pub fn pic_mo() -> f64 {
        PIC.load(Relaxed) as f64 / 1_048_576.0
    }
    pub fn repartir_pic() {
        PIC.store(VIVANT.load(Relaxed), Relaxed);
    }
}

#[global_allocator]
static ALLOCATEUR: tas::Compteur = tas::Compteur;

/// Pseudo-hasard déterministe (xorshift) : les mesures se rejouent à l'identique.
fn next(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

#[test]
#[ignore = "mesure sur le vrai GTFS d'IDFM (IDFM_ZIP) : voir l'en-tête du fichier"]
fn mesure_gtfs_idfm() {
    let zip = std::path::PathBuf::from(std::env::var("IDFM_ZIP").expect("IDFM_ZIP : chemin du zip d'IDFM"));
    let modes: Vec<String> = std::env::var("IDFM_MODES").unwrap_or_else(|_| "metro,tram,train,cable".into()).split(',').map(|m| m.trim().to_string()).collect();
    let now = Timestamp::now().as_second();
    let config = Config { key: "mesure".into(), modes: modes.clone(), every: Duration::from_secs(180), memory_limit: 100 << 20, gtfs_url: DEFAULT_GTFS_URL.into(), replay: Vec::new() };

    let before = rss_mb();
    let heap_before = tas::vivant_mo();
    tas::repartir_pic();
    let started = Instant::now();
    let mut schedule = gtfs_compact::build_days(&zip, now, &|info| config.keeps(info), &|info| if std::env::var_os("IDFM_TOUS_LES_JOURS").is_some() { gtfs_compact::ALL_DAYS } else { config.service_days(info) }, None).expect("GTFS illisible");
    decorate(&mut schedule);
    let build_s = started.elapsed().as_secs_f32();
    let after = rss_mb();
    println!("MODES {modes:?}");
    println!(
        "HORAIRES courses={} motifs={} arrêts={} points_de_tracé={} lignes={} estimé_Mo={:.1} construction_s={build_s:.1}",
        schedule.trip_count(),
        schedule.patterns.len(),
        schedule.stops.len(),
        schedule.shape_points(),
        schedule.routes.len(),
        schedule.approx_bytes() as f64 / 1_048_576.0
    );
    println!("MEMOIRE avant={before:.0} Mo, après construction={after:.0} Mo (rss de ce processus, y compris ce que l'allocateur n'a pas rendu)");
    println!("TAS construction : repos={:.1} Mo, pic={:.1} Mo au-dessus du départ", tas::vivant_mo() - heap_before, tas::pic_mo() - heap_before);

    // Relecture du GTFS : l'ancien modèle est gardé pendant la construction du nouveau (le cas du changement de jour).
    if std::env::var_os("IDFM_RELECTURE").is_some() {
        let base = tas::vivant_mo();
        tas::repartir_pic();
        let rss_start = rss_mb();
        let mut second = gtfs_compact::build_days(&zip, now, &|info| config.keeps(info), &|info| config.service_days(info), None).expect("GTFS illisible");
        decorate(&mut second);
        println!("TAS relecture (deux modèles) : pic={:.1} Mo au-dessus de l'ancien modèle seul, repos des deux={:.1} Mo ; rss {rss_start:.0} -> {:.0} Mo", tas::pic_mo() - base, tas::vivant_mo() - base, rss_mb());
        drop(second);
    }

    // Rejeu de vraies réponses SIRI (IDFM_SIRI=1.json.gz,2.json.gz ; l'instant du relevé est dans `1.at` à côté).
    for file in std::env::var("IDFM_SIRI").unwrap_or_default().split(',').filter(|f| !f.is_empty()) {
        let body = std::fs::read(file).expect("SIRI illisible");
        let fetched_at: i64 = std::fs::read_to_string(std::path::Path::new(file).with_extension("").with_extension("at")).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(now);
        let accepted: HashSet<String> = schedule.route_ids.iter().map(|id| id.to_string()).collect();
        let base = tas::vivant_mo();
        tas::repartir_pic();
        let started = Instant::now();
        let journeys = parse_siri(&body[..], &|route| accepted.contains(route)).expect("SIRI invalide");
        let parse_ms = started.elapsed().as_millis();
        println!("SIRI {file} : {} circulations gardées, décodage {parse_ms} ms, tas : pic={:.1} Mo, après={:.1} Mo (corps compressé {:.1} Mo inclus dans la base)", journeys.len(), tas::pic_mo() - base, tas::vivant_mo() - base, body.len() as f64 / 1_048_576.0);
        let before_match = tas::vivant_mo();
        tas::repartir_pic();
        let started = Instant::now();
        let (realtime, stats) = match_journeys(&schedule, &journeys, fetched_at);
        println!("SIRI rapprochement {} ms : {stats:?}, tas : pic={:.1} Mo, après={:.1} Mo", started.elapsed().as_millis(), tas::pic_mo() - before_match, tas::vivant_mo() - before_match);
        drop((journeys, realtime));
        println!("SIRI rss={:.0} Mo", rss_mb());
    }

    let per_day: Vec<usize> = (0..3).map(|d| schedule.trips.iter().filter(|t| t.days & (1 << d) != 0).count()).collect();
    println!("COURSES_PAR_JOUR hier={} aujourd'hui={} demain={}", per_day[0], per_day[1], per_day[2]);
    if std::env::var_os("IDFM_SANS_RAPPROCHEMENT").is_some() {
        return;
    }

    // ── Rapprochement : toutes les courses en cours à 8 h 30 (heure locale d'aujourd'hui).
    let at = schedule.day_starts[1] + 8 * 3600 + 1800;
    let index = Index::new(&schedule, &[]);
    let mut state = 0x9E37_79B9_7F4A_7C15u64;
    for (label, with_aimed) in [("avec heure théorique", true), ("sans heure théorique", false)] {
        let mut journeys: Vec<Journey> = Vec::new();
        let mut truth: Vec<String> = Vec::new();
        for (t, trip) in schedule.trips.iter().enumerate() {
            let day = 1;
            if trip.days & (1 << day) == 0 {
                continue;
            }
            let pattern = &schedule.patterns[trip.pattern as usize];
            let times: Vec<i64> = (0..pattern.stop.len()).map(|i| schedule.day_starts[day] + i64::from(schedule.times_of(trip, i).0)).collect();
            let Some(first) = times.iter().position(|&x| x >= at) else { continue };
            if first > 0 && times[0] > at || times[times.len() - 1] < at {
                continue;
            }
            // Le retard du véhicule : de -1 à +5 minutes, le même à tous ses arrêts.
            let delay = (next(&mut state) % 360) as i64 - 60;
            let calls: Vec<Call> = (first..pattern.stop.len().min(first + 6))
                .filter_map(|i| {
                    let code = index.code_of_stop[pattern.stop[i] as usize]?;
                    let aimed = times[i];
                    Some(Call::new(code, None, with_aimed.then_some(aimed), with_aimed.then_some(aimed), Some(aimed + delay), Some(aimed + delay)))
                })
                .collect();
            if calls.is_empty() {
                continue;
            }
            let last = index.code_of_stop[*pattern.stop.last().unwrap() as usize];
            // L'identifiant de circulation est volontairement faux : seul le rapprochement par arrêts et heures est mesuré.
            journeys.push(Journey { route: schedule.route_ids[trip.route as usize].clone(), short_ref: format!("inconnu-{t}").into(), destination: last, calls: calls.into() });
            truth.push(trip.id.to_string());
        }
        let started = Instant::now();
        let (realtime, stats) = match_journeys(&schedule, &journeys, now);
        let ms = started.elapsed().as_millis();
        // Une circulation est bien attribuée quand sa course attendue reçoit une mise à jour ; les mises à jour d'autres courses sont des erreurs.
        let truth_set: HashSet<&String> = truth.iter().collect();
        let right = truth.iter().filter(|id| realtime.trips.contains_key(*id)).count();
        let wrong = realtime.trips.keys().filter(|id| !truth_set.contains(id)).count();
        println!(
            "RAPPROCHEMENT ({label}) circulations={} attribuées={} bonnes={right} ({:.1} %) mauvaises={wrong} sans_course={} ms={ms}",
            journeys.len(),
            stats.by_stops + stats.by_id,
            100.0 * right as f64 / journeys.len().max(1) as f64,
            stats.unmatched
        );
    }
    println!("MEMOIRE fin={:.0} Mo", rss_mb());
}

// ───────────────────────── Qualité du rapprochement sur de vraies réponses ─────────────────────────
//
// ```text
// IDFM_ZIP=… IDFM_SIRI=1.json.gz,2.json.gz IDFM_NON_RAPPROCHES=non-rapproches.tsv \
//   ./binaire-de-test qualite_siri_idfm --ignored --nocapture
// ```
// Les réponses SIRI se téléchargent une fois (une requête chacune) ; l'instant de chacune est dans `N.at` à côté (`replay_time`).

fn haversine_m(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = ((b.0 - a.0) * 111_320.0 * ((a.1 + b.1) / 2.0).to_radians().cos(), (b.1 - a.1) * 110_540.0);
    dx.hypot(dy)
}

/// Compte, pour une liste d'écarts, ceux qui tombent dans chaque tranche.
fn buckets(values: &[f64], limits: &[f64]) -> String {
    let mut counts = vec![0usize; limits.len() + 1];
    for v in values {
        counts[limits.iter().position(|l| v <= l).unwrap_or(limits.len())] += 1;
    }
    let mut out = String::new();
    for (i, c) in counts.iter().enumerate() {
        let label = if i < limits.len() { format!("≤{}", limits[i]) } else { format!(">{}", limits[limits.len() - 1]) };
        out += &format!(" {label}:{c}");
    }
    out
}

#[test]
#[ignore = "qualité sur de vraies réponses PRIM enregistrées (IDFM_ZIP, IDFM_SIRI) : voir l'en-tête de cette partie"]
fn qualite_siri_idfm() {
    let zip = std::path::PathBuf::from(std::env::var("IDFM_ZIP").expect("IDFM_ZIP"));
    let modes: Vec<String> = std::env::var("IDFM_MODES").unwrap_or_else(|_| "metro,tram,train,cable,bus".into()).split(',').map(|m| m.trim().to_string()).collect();
    let files: Vec<String> = std::env::var("IDFM_SIRI").expect("IDFM_SIRI").split(',').map(str::to_string).collect();
    let config = Config { key: "mesure".into(), modes, every: Duration::from_secs(180), memory_limit: 100 << 20, gtfs_url: DEFAULT_GTFS_URL.into(), replay: Vec::new() };
    let first_at = replay_time(std::path::Path::new(&files[0]));
    let mut schedule = gtfs_compact::build_days(&zip, first_at, &|info| config.keeps(info), &|info| config.service_days(info), None).expect("GTFS illisible");
    decorate(&mut schedule);
    println!("HORAIRES courses={} lignes={}", schedule.trip_count(), schedule.routes.len());
    let accepted: HashSet<String> = schedule.route_ids.iter().map(|id| id.to_string()).collect();
    let tsv = std::env::var("IDFM_NON_RAPPROCHES").ok();
    let mut tsv_out = String::new();
    let mode_of = |index: &Index, journey: &Journey| index.route_of.get(&*journey.route).and_then(|r| schedule.routes[*r as usize].mode).unwrap_or("?");

    for file in &files {
        let path = std::path::Path::new(file);
        let at = replay_time(path);
        let decoded = decode_siri(std::fs::File::open(path).unwrap(), &|route| accepted.contains(route)).unwrap();
        let journeys = decoded.journeys;
        let (realtime, stats, verdicts) = match_detailed(&schedule, &journeys, at);
        let index = Index::new(&schedule, &journeys);
        println!("\n=== {file} (instant {at}) : {} circulations lues, {} sur des lignes du modèle", decoded.seen, journeys.len());
        println!("STATS {stats:?}");

        // Positions estimées avec ce temps réel.
        let vehicles = crate::estimates::estimate(&schedule, Some(&realtime), at);
        let position: HashMap<&str, (f64, f64, bool)> = vehicles.iter().map(|v| (v.out.id.as_str(), (v.out.lon, v.out.lat, v.out.est.as_ref().is_some_and(|e| e.theoretical)))).collect();
        println!("VEHICULES estimés={} dont à l'horaire théorique={}", vehicles.len(), position.values().filter(|p| p.2).count());

        // Par mode GTFS de la ligne.
        let mut by_mode: std::collections::BTreeMap<&str, Vec<usize>> = Default::default();
        for (j, journey) in journeys.iter().enumerate() {
            by_mode.entry(mode_of(&index, journey)).or_default().push(j);
        }
        for (mode, list) in &by_mode {
            let n = list.len();
            let count = |f: &dyn Fn(&Verdict) -> bool| list.iter().filter(|j| f(&verdicts[**j])).count();
            let by_id = count(&|v| matches!(v, Verdict::ById { .. }));
            let by_stops = count(&|v| matches!(v, Verdict::ByStops { .. }));
            let with_aimed = list.iter().filter(|j| journeys[**j].calls.iter().any(|c| c.aimed().is_some())).count();
            let aimed_matched = list.iter().filter(|j| journeys[**j].calls.iter().any(|c| c.aimed().is_some()) && matches!(verdicts[**j], Verdict::ById { .. } | Verdict::ByStops { .. })).count();
            println!(
                "MODE {mode:6} circulations={n:6} par_identifiant={by_id:5} ({:.1} %) par_arrêts={by_stops:5} ({:.1} %) rapprochées={:.1} % ; avec heure théorique={with_aimed} ({:.1} %) dont rapprochées {:.1} %",
                100.0 * by_id as f64 / n as f64,
                100.0 * by_stops as f64 / n as f64,
                100.0 * (by_id + by_stops) as f64 / n as f64,
                100.0 * with_aimed as f64 / n as f64,
                100.0 * aimed_matched as f64 / with_aimed.max(1) as f64
            );
            println!(
                "     refus : ligne_inconnue={} arrêts_inconnus={} aucune_course_à_l'heure={} aucune_ne_convient={} prise_par_un_autre={}",
                count(&|v| matches!(v, Verdict::UnknownRoute)),
                count(&|v| matches!(v, Verdict::NoKnownStop)),
                count(&|v| matches!(v, Verdict::NoTripInWindow)),
                count(&|v| matches!(v, Verdict::NoCandidate { .. })),
                count(&|v| matches!(v, Verdict::Taken))
            );
            let bests: Vec<f64> = list.iter().filter_map(|j| if let Verdict::NoCandidate { best: Some(b) } = verdicts[*j] { Some(f64::from(b)) } else { None }).collect();
            if !bests.is_empty() {
                println!("     meilleur écart des « aucune ne convient » (s) :{}", buckets(&bests, &[120.0, 240.0, 600.0, 1800.0]));
            }
        }

        // Cohérence physique : le véhicule estimé doit être à une distance plausible du prochain arrêt annoncé par le SIRI.
        for scope in ["bus", "autres"] {
            let (mut checked, mut implausible, mut theoretical_only) = (0usize, 0usize, 0usize);
            let mut worst: Vec<(f64, String)> = Vec::new();
            for (j, journey) in journeys.iter().enumerate() {
                if (scope == "bus") != (mode_of(&index, journey) == "bus") {
                    continue;
                }
                let trip_index = match verdicts[j] {
                    Verdict::ById { trip } | Verdict::ByStops { trip, .. } => trip,
                    _ => continue,
                };
                let trip = &schedule.trips[trip_index as usize];
                let Some(&(lon, lat, theoretical)) = position.get(&*trip.id) else { continue };
                if theoretical {
                    theoretical_only += 1;
                    continue;
                }
                // Prochain arrêt annoncé (le plus proche dans le futur).
                let Some(call) = journey.calls.iter().filter(|c| c.expected().is_some_and(|t| t >= at)).min_by_key(|c| c.expected()) else { continue };
                let target = call.aimed().or(call.expected()).unwrap_or(0);
                let day = (0..3).filter(|d| trip.days & (1 << d) != 0).min_by_key(|&d| index.position(trip, call, schedule.day_starts[d]).map_or(i64::MAX, |i| (schedule.day_starts[d] + i64::from(schedule.times_of(trip, i).0) - target).abs()));
                let Some(day) = day else { continue };
                let Some(i) = index.position(trip, call, schedule.day_starts[day]) else { continue };
                let stop = &schedule.stops[schedule.patterns[trip.pattern as usize].stop[i] as usize];
                let dt = (call.expected().unwrap() - at).max(0) as f64;
                let distance = haversine_m((lon, lat), (stop.lon, stop.lat));
                checked += 1;
                if distance > 25.0 * dt + 300.0 {
                    implausible += 1;
                    worst.push((distance - 25.0 * dt, format!("{} ligne={} course={} dt={dt:.0}s distance={distance:.0} m", journey.short_ref, journey.route, trip.id)));
                }
            }
            worst.sort_by(|a, b| b.0.total_cmp(&a.0));
            println!("COHERENCE {scope} : vérifiés={checked} invraisemblables={implausible} ({:.2} %) ; rapprochés mais restés à l'horaire théorique={theoretical_only}", 100.0 * implausible as f64 / checked.max(1) as f64);
            for (_, line) in worst.iter().take(4) {
                println!("     {line}");
            }
        }

        // Vérité terrain : pour les circulations dont l'identifiant désigne une course, on le cache et on regarde si les arrêts et les heures la retrouvent.
        let truth: Vec<(usize, u32)> = verdicts.iter().enumerate().filter_map(|(j, v)| if let Verdict::ById { trip } = v { Some((j, *trip)) } else { None }).collect();
        let mut hidden = decode_siri(std::fs::File::open(path).unwrap(), &|route| accepted.contains(route)).unwrap().journeys;
        for journey in &mut hidden {
            journey.short_ref = "masqué".into();
        }
        let (_, _, hidden_verdicts) = match_detailed(&schedule, &hidden, at);
        for scope in ["bus", "autres"] {
            let (mut right, mut wrong, mut none, mut total) = (0, 0, 0, 0);
            for &(j, trip) in &truth {
                if (scope == "bus") != (mode_of(&index, &journeys[j]) == "bus") {
                    continue;
                }
                total += 1;
                match hidden_verdicts[j] {
                    Verdict::ByStops { trip: found, .. } if found == trip => right += 1,
                    Verdict::ByStops { .. } => wrong += 1,
                    _ => none += 1,
                }
            }
            println!(
                "VERITE_TERRAIN {scope} (identifiant masqué, {total} circulations dont la course est connue) : bonne={right} ({:.1} %) mauvaise={wrong} ({:.2} %) sans_course={none} ({:.1} %)",
                100.0 * right as f64 / total.max(1) as f64,
                100.0 * wrong as f64 / total.max(1) as f64,
                100.0 * none as f64 / total.max(1) as f64
            );
        }

        // Écart entre les heures du SIRI et celles du GTFS pour la course retenue.
        let (mut gaps_id, mut gaps_stops): (Vec<f64>, Vec<f64>) = (Vec::new(), Vec::new());
        for (j, journey) in journeys.iter().enumerate() {
            let (trip_index, by_id) = match verdicts[j] {
                Verdict::ById { trip } => (trip, true),
                Verdict::ByStops { trip, .. } => (trip, false),
                _ => continue,
            };
            let trip = &schedule.trips[trip_index as usize];
            if let Some(score) = (0..3).filter(|d| trip.days & (1 << d) != 0).filter_map(|d| index.score(journey, trip, d)).min_by(f64::total_cmp) {
                if by_id { gaps_id.push(score) } else { gaps_stops.push(score) }
            }
        }
        println!("ECART_ID (médiane des écarts, course trouvée par identifiant) :{}", buckets(&gaps_id, &[30.0, 60.0, 120.0, 240.0, 600.0]));
        println!("ECART_ARRETS (course trouvée par arrêts) :{}", buckets(&gaps_stops, &[30.0, 60.0, 120.0, 240.0]));

        // Détail de quelques circulations (IDFM_DEBUG_REF=ref1,ref2) : appels du SIRI et horaire de la course retenue.
        for wanted in std::env::var("IDFM_DEBUG_REF").unwrap_or_default().split(',').filter(|r| !r.is_empty()) {
            for (j, journey) in journeys.iter().enumerate().filter(|(_, j)| &*j.short_ref == wanted) {
                println!("DEBUG {} ligne={} verdict={:?} destination={:?}", journey.short_ref, journey.route, verdicts[j], journey.destination);
                for c in journey.calls.iter() {
                    println!("   SIRI arrêt={:?} quai={:?} prévu={:?} théorique={:?}", c.stop, c.quay, c.expected().map(|t| t - at), c.aimed().map(|t| t - at));
                }
                if let Verdict::ById { trip } | Verdict::ByStops { trip, .. } = verdicts[j] {
                    let trip = &schedule.trips[trip as usize];
                    let pattern = &schedule.patterns[trip.pattern as usize];
                    println!("   COURSE {} jours={:03b} début={} fin={}", trip.id, trip.days, trip.start, trip.end);
                    for (i, &stop) in pattern.stop.iter().enumerate() {
                        let day = 1;
                        println!("      #{i} {:?} {} horaire={}", index.code_of_stop[stop as usize], schedule.stops[stop as usize].name, schedule.day_starts[day] + i64::from(schedule.times_of(trip, i).0) - at);
                    }
                    if let Some(&(lon, lat, th)) = position.get(&*trip.id) {
                        println!("   POSITION ({lon:.5}, {lat:.5}) théorique={th}");
                    }
                }
                if !matches!(verdicts[j], Verdict::ById { .. } | Verdict::ByStops { .. })
                    && let Some(&route) = index.route_of.get(&*journey.route)
                {
                    let times: Vec<i64> = journey.calls.iter().filter_map(|c| c.aimed().or(c.expected())).collect();
                    let (first, last) = (times.iter().min().copied().unwrap_or(0), times.iter().max().copied().unwrap_or(0));
                    println!("   LIGNE {} : {} courses ; fenêtre [{}, {}]", journey.route, index.trips_of_route[route as usize].len(), first - at, last - at);
                    let mut shown = 0;
                    for &t in &index.trips_of_route[route as usize] {
                        let trip = &schedule.trips[t as usize];
                        for day in 0..3 {
                            if trip.days & (1 << day) == 0 {
                                continue;
                            }
                            let (start, end) = (schedule.day_starts[day] + i64::from(trip.start) - at, schedule.day_starts[day] + i64::from(trip.end) - at);
                            if end < first - at - WINDOW_S || start > last - at + WINDOW_S || shown >= 6 {
                                continue;
                            }
                            shown += 1;
                            let pattern = &schedule.patterns[trip.pattern as usize];
                            let served = journey.calls.iter().filter(|c| index.position(trip, c, schedule.day_starts[day]).is_some()).count();
                            let known = journey.calls.iter().filter(|c| index.stop_is_known(c)).count();
                            println!(
                                "   COURSE? {} jour={day} [{start}, {end}] arrêts={} desservis_parmi_annoncés={served}/{} (connus {known}) score={:?} premier={:?} dernier={:?}",
                                trip.id,
                                pattern.stop.len(),
                                journey.calls.len(),
                                index.score(journey, trip, day),
                                index.code_of_stop[pattern.stop[0] as usize],
                                index.code_of_stop[*pattern.stop.last().unwrap() as usize]
                            );
                        }
                    }
                }
            }
        }
        if tsv.is_some() {
            for (j, journey) in journeys.iter().enumerate() {
                if matches!(verdicts[j], Verdict::ById { .. } | Verdict::ByStops { .. }) {
                    continue;
                }
                let times: Vec<i64> = journey.calls.iter().filter_map(|c| c.aimed().or(c.expected())).collect();
                tsv_out += &format!(
                    "{}\t{}\t{}\t{:?}\t{}\t{}\t{}\t{}\n",
                    mode_of(&index, journey),
                    journey.route,
                    journey.short_ref,
                    verdicts[j],
                    journey.calls.len(),
                    journey.calls.iter().any(|c| c.aimed().is_some()),
                    times.iter().min().map_or(0, |t| t - at),
                    times.iter().max().map_or(0, |t| t - at)
                );
            }
        }
    }
    if let Some(path) = tsv {
        std::fs::write(path, tsv_out).unwrap();
    }
}
