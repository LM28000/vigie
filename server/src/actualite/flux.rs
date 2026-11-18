//! Les fils : la liste (flux.json), la lecture d'un fil RSS ou Atom, le robots.txt, et ce qu'on écarte d'un titre.
//!
//! On ne retient d'un article que **son titre, son adresse et son heure de publication** : le fil en dit davantage (chapô,
//! image, auteur, catégories), rien de cela n'est gardé ni envoyé au navigateur.

use std::collections::HashSet;

use anyhow::{Context, Result};
use jiff::Timestamp;
use roxmltree::{Document, Node, ParsingOptions};
use serde::Deserialize;

#[derive(Deserialize, Debug, Clone)]
pub struct Feed {
    pub id: String,
    /// Le nom de l'éditeur ou du réseau (« ICI »), puis celui du fil (« ICI Armorique »).
    pub groupe: String,
    pub nom: String,
    pub url: String,
    /// Codes des départements du fil : ils ne servent qu'à départager des communes homonymes.
    #[serde(default)]
    pub depts: Vec<String>,
    /// Ce que l'adresse des articles dit du lieu (voir `lieux.rs`) : `france3`, `ici`, `actufr` ou `aucune`.
    pub geo: String,
}

#[derive(Deserialize)]
struct Config {
    feeds: Vec<Feed>,
}

/// La liste des fils, lue dans le fichier de configuration compilé avec le serveur.
pub fn feeds() -> Result<Vec<Feed>> {
    let config: Config = serde_json::from_str(include_str!("flux.json")).context("flux.json illisible")?;
    let mut seen = HashSet::new();
    for feed in &config.feeds {
        anyhow::ensure!(seen.insert(feed.id.as_str()), "fil en double : {}", feed.id);
        anyhow::ensure!(feed.url.starts_with("https://"), "fil sans https : {}", feed.id);
    }
    Ok(config.feeds)
}

/// Un article d'un fil, réduit à ce qu'on a le droit d'afficher.
#[derive(Debug, PartialEq)]
pub struct Entry {
    pub title: String,
    pub url: String,
    /// Heure de publication (secondes Unix), si le fil la donne.
    pub published: Option<i64>,
}

const MAX_TITLE_CHARS: usize = 200;
const MIN_TITLE_CHARS: usize = 12;
const MAX_URL_CHARS: usize = 400;

fn text_of(node: Node, name: &str) -> Option<String> {
    node.children().find(|c| c.is_element() && c.tag_name().name() == name).and_then(|c| c.text()).map(|t| t.trim().to_string())
}

fn parse_time(text: &str) -> Option<i64> {
    let text = text.trim();
    jiff::fmt::rfc2822::parse(text).ok().map(|z| z.timestamp().as_second()).or_else(|| text.parse::<Timestamp>().ok().map(|t| t.as_second()))
}

/// Lit un fil RSS 2.0 (`item`) ou Atom (`entry`). Les articles sans titre ou sans adresse web sont ignorés.
pub fn parse(xml: &str) -> Result<Vec<Entry>> {
    let document = Document::parse_with_options(xml, ParsingOptions { allow_dtd: true, ..Default::default() }).context("XML invalide")?;
    let mut entries = Vec::new();
    for node in document.descendants().filter(|n| n.is_element() && matches!(n.tag_name().name(), "item" | "entry")) {
        let Some(title) = text_of(node, "title") else { continue };
        let link = text_of(node, "link").filter(|l| !l.is_empty()).or_else(|| {
            // Atom : `<link rel="alternate" href="…"/>`.
            node.children()
                .filter(|c| c.is_element() && c.tag_name().name() == "link")
                .find(|c| c.attribute("rel").is_none_or(|r| r == "alternate"))
                .and_then(|c| c.attribute("href"))
                .map(str::to_string)
        });
        let Some(url) = link else { continue };
        let published = ["pubDate", "published", "updated", "date"].iter().find_map(|name| text_of(node, name)).and_then(|t| parse_time(&t));
        let title = clean_title(&title);
        if title.chars().count() < MIN_TITLE_CHARS || !url.starts_with("http") || url.len() > MAX_URL_CHARS || !allowed(&title, &url) {
            continue;
        }
        entries.push(Entry { title, url, published });
    }
    Ok(entries)
}

/// Espaces normalisés, balises retirées, longueur bornée.
fn clean_title(raw: &str) -> String {
    let mut text = String::with_capacity(raw.len());
    let mut in_tag = false;
    for c in raw.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if in_tag => {}
            _ => text.push(c),
        }
    }
    let mut out = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.chars().count() > MAX_TITLE_CHARS {
        out = out.chars().take(MAX_TITLE_CHARS - 1).collect::<String>() + "…";
    }
    out
}

/// Mots (en minuscules, sans accent) qui font écarter un titre : contenu pour adultes, plateformes de cryptomonnaies, publicité.
/// On préfère perdre un titre légitime (« pédopornographie : un homme condamné ») que d'en afficher un qui ne doit pas l'être.
const REJECTED: &[&str] = &[
    "porno", "x x x", "xxx", "escort", "sexcam", "sex shop", "sexshop", "libertin", "onlyfans", "erotique", "prostitu", "sextape", "sex tape",
    "binance", "coinbase", "kraken", "bitcoin", "cryptomonnaie", "crypto monnaie", "cryptoactif", "crypto actif", "ethereum", "usdt",
    "black friday", "code promo", "bon plan", "bons plans", "soldes", "$content",
];

/// Parties d'adresse des rubriques commerciales de certains fils.
const REJECTED_PATHS: &[&str] = &["/guide-conso/", "/bons-plans", "/shopping", "/jeux-concours", "/horoscope"];

fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = true;
    for c in text.chars() {
        let folded = match c {
            'à' | 'â' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' => 'i',
            'ô' | 'ö' => 'o',
            'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            c => c,
        };
        if folded.is_alphanumeric() || folded == '$' {
            out.extend(folded.to_lowercase());
            space = false;
        } else if !space {
            out.push(' ');
            space = true;
        }
    }
    out
}

pub fn allowed(title: &str, url: &str) -> bool {
    let words = format!(" {} ", plain(title));
    let lowered = url.to_lowercase();
    // « porno » seul est un préfixe (« pornographie »), les autres mots sont cherchés entiers ou en préfixe selon leur forme.
    !REJECTED.iter().any(|bad| words.contains(&format!(" {bad}")) || (bad.len() >= 6 && words.contains(bad))) && !REJECTED_PATHS.iter().any(|p| lowered.contains(p))
}

// --- robots.txt ------------------------------------------------------------------------------------------------------------

/// Les règles d'un robots.txt pour un robot donné (RFC 9309 : le groupe le plus précis, la règle la plus longue, « Allow » à égalité).
#[derive(Debug, Default, Clone)]
pub struct Robots {
    rules: Vec<(bool, String)>,
}

impl Robots {
    /// Aucun fichier (404, 403…) : tout est permis.
    pub fn allow_all() -> Robots {
        Robots::default()
    }

    pub fn parse(text: &str, agent: &str) -> Robots {
        let agent = agent.to_lowercase();
        let mut specific: Vec<(bool, String)> = Vec::new();
        let mut generic: Vec<(bool, String)> = Vec::new();
        // Un groupe = des lignes `User-agent` qui se suivent, puis leurs règles.
        let mut group_agents: Vec<String> = Vec::new();
        let mut in_rules = false;
        for line in text.lines() {
            let line = line.split('#').next().unwrap_or("").trim();
            let Some((field, value)) = line.split_once(':') else { continue };
            let (field, value) = (field.trim().to_lowercase(), value.trim());
            match field.as_str() {
                "user-agent" => {
                    if in_rules {
                        group_agents.clear();
                        in_rules = false;
                    }
                    group_agents.push(value.to_lowercase());
                }
                "allow" | "disallow" => {
                    in_rules = true;
                    let rule = (field == "allow", value.to_string());
                    if group_agents.iter().any(|a| a != "*" && agent.contains(a.as_str())) {
                        specific.push(rule);
                    } else if group_agents.iter().any(|a| a == "*") {
                        generic.push(rule);
                    }
                }
                _ => {}
            }
        }
        Robots { rules: if specific.is_empty() { generic } else { specific } }
    }

    pub fn allows(&self, path: &str) -> bool {
        let mut best: Option<(usize, bool)> = None;
        for (allow, pattern) in &self.rules {
            if pattern.is_empty() || !matches(pattern, path) {
                continue;
            }
            let len = pattern.len();
            if best.is_none_or(|(l, a)| len > l || (len == l && *allow && !a)) {
                best = Some((len, *allow));
            }
        }
        best.is_none_or(|(_, allow)| allow)
    }
}

/// Motif de robots.txt : préfixe, avec `*` (n'importe quoi) et `$` (fin) en fin ou au milieu.
fn matches(pattern: &str, path: &str) -> bool {
    let (pattern, anchored) = pattern.strip_suffix('$').map_or((pattern, false), |p| (p, true));
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut position = 0;
    for (i, part) in parts.iter().enumerate() {
        if i == 0 {
            if !path.starts_with(part) {
                return false;
            }
            position = part.len();
        } else if let Some(found) = path[position..].find(part) {
            position += found + part.len();
        } else {
            return false;
        }
    }
    !anchored || position == path.len() || parts.last().is_some_and(|p| p.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSS: &str = r#"<?xml version="1.0" encoding="utf-8" ?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Fil</title>
<item><guid>1</guid><pubDate>Wed, 18 Nov 2026 08:40:11 +0100</pubDate><title>Disparition inquiétante d&#039;une collégienne à Saint-Brieuc</title>
<link>https://exemple.fr/a/1</link><description>Le chapô ne doit jamais sortir du serveur</description><enclosure url="https://exemple.fr/i.jpg"/></item>
<item><title><![CDATA[Un titre en CDATA avec <b>balises</b>   et   espaces]]></title><link>https://exemple.fr/a/2</link></item>
<item><title>Bon plan : code promo exceptionnel sur ce matelas</title><link>https://exemple.fr/a/3</link></item>
<item><title>Court</title><link>https://exemple.fr/a/4</link></item>
<item><title>Un article sans adresse du tout ici</title></item>
</channel></rss>"#;

    #[test]
    fn reads_titles_urls_and_times_only() {
        let entries = parse(RSS).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].title, "Disparition inquiétante d'une collégienne à Saint-Brieuc");
        assert_eq!(entries[0].url, "https://exemple.fr/a/1");
        assert_eq!(entries[0].published, Some(1_794_987_611));
        assert_eq!(entries[1].title, "Un titre en CDATA avec balises et espaces");
        assert_eq!(entries[1].published, None);
        assert!(!format!("{entries:?}").contains("chapô"));
    }

    #[test]
    fn reads_atom() {
        let atom = r#"<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Un titre Atom assez long</title><link rel="alternate" href="https://exemple.fr/atom/1"/><updated>2026-11-18T07:00:00Z</updated></entry></feed>"#;
        let entries = parse(atom).unwrap();
        assert_eq!(entries, vec![Entry { title: "Un titre Atom assez long".into(), url: "https://exemple.fr/atom/1".into(), published: Some(1_794_985_200) }]);
    }

    #[test]
    fn rejects_adult_crypto_and_shopping_titles() {
        for bad in [
            "Une actrice de films porno condamnée",
            "Un site de pornographie fermé par la justice",
            "Binance mise en examen en France",
            "Le bitcoin s'envole",
            "Black Friday : -30 % sur ce matelas",
            "Vidéo. $content.TitleNoTags",
            "Escort girls : un réseau démantelé",
        ] {
            assert!(!allowed(bad, "https://exemple.fr/x"), "{bad}");
        }
        for good in ["Un incendie à Rennes fait trois blessés", "Les soldats du feu en grève à Nantes", "La cryptographie au programme d'un lycée de Brest"] {
            assert!(allowed(good, "https://exemple.fr/x"), "{good}");
        }
        assert!(!allowed("Un titre banal", "https://exemple.fr/guide-conso/matelas"));
    }

    #[test]
    fn robots_follow_the_most_specific_group_and_longest_rule() {
        let text = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/rss\nCrawl-delay: 10\n";
        let robots = Robots::parse(text, "carte-vivante/0.1.0");
        assert!(robots.allows("/rss"));
        assert!(!robots.allows("/private/x"));
        assert!(robots.allows("/private/rss/une.xml"));
        let closed = Robots::parse("User-agent: *\nDisallow: /\n", "carte-vivante/0.1.0");
        assert!(!closed.allows("/rss/une"));
        let ours = Robots::parse("User-agent: *\nDisallow: /\n\nUser-agent: carte-vivante\nAllow: /rss\nDisallow: /\n", "carte-vivante/0.1.0");
        assert!(ours.allows("/rss") && !ours.allows("/autre"));
        let wild = Robots::parse("User-agent: *\nDisallow: /*.xml$\nDisallow: /a*b\n", "x");
        assert!(!wild.allows("/rss/une.xml") && wild.allows("/rss/une.xml2") && !wild.allows("/axxb/c") && wild.allows("/a/c"));
        assert!(Robots::allow_all().allows("/n-importe"));
    }

    #[test]
    fn the_config_loads() {
        let feeds = feeds().unwrap();
        assert!(feeds.len() > 50);
        assert!(feeds.iter().all(|f| ["france3", "ici", "actufr", "aucune"].contains(&f.geo.as_str())));
    }
}
