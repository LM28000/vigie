import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clock } from '../core/clock';
import { isLiveTime } from '../core/infoStatus';
import type { ModuleManager } from '../core/moduleManager';
import { fetchQuakes, fetchSynthese } from '../core/syntheseData';
import { buildDigest, levelLabel, severityLabel, type Action, type ApiSynthese, type Rubric, type Row, type Severity, type SynthesisQuake } from '../core/syntheseModel';
import { STATUS } from '../design/tokens';
import { goTo, mapOf, openObject, prefersReducedMotion } from '../search/access';
import { formatLongDate, formatRelative } from './format';
import { useNow } from './hooks';
import { Icon } from './icons';

/** La synthèse se relit chaque minute tant que le panneau est ouvert (le serveur garde sa réponse 30 s). */
const REFRESH_MS = 60_000;

interface Loaded {
  api: ApiSynthese;
  quakes: SynthesisQuake[] | null;
}

/** Charge la synthèse à l'ouverture, puis chaque minute (onglet visible). Les dernières données restent affichées si un relevé échoue. */
function useSynthesis(manager: ModuleManager) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const controller = useRef<AbortController | undefined>(undefined);
  const lastLoad = useRef(0);

  const load = useCallback(async () => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    try {
      const [api, quakes] = await Promise.all([fetchSynthese(abort.signal), fetchQuakes(manager, abort.signal)]);
      if (abort.signal.aborted) return;
      lastLoad.current = Date.now();
      setLoaded({ api, quakes });
      setError(null);
    } catch (e) {
      if (abort.signal.aborted) return;
      setError(e instanceof Error ? e.message : 'erreur inconnue');
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  }, [manager]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    // Revenu sur l'onglet après une longue absence : on ne montre pas du périmé.
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastLoad.current > REFRESH_MS) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      controller.current?.abort();
    };
  }, [load]);

  return { loaded, error, loading, reload: load };
}

/** Ce que fait un clic : couche affichée, objet choisi (sa fiche s'ouvre), carte centrée ou cadrée. Toujours au direct : la synthèse parle d'aujourd'hui. */
function run(manager: ModuleManager, action: Action, phone: boolean): void {
  if (!isLiveTime(clock.now())) clock.goLive();
  if (action.kind === 'object') {
    openObject(manager, action.moduleId, action.selection, { fallback: { lon: action.lon, lat: action.lat }, zoom: action.zoom, liveOnly: true });
    return;
  }
  manager.setVisible(action.moduleId, true);
  manager.setSelection(null, null);
  if (action.kind === 'view') {
    goTo(manager, action.lon, action.lat, action.zoom);
    return;
  }
  const map = mapOf(manager);
  if (!map) return;
  // Le panneau recouvre la gauche (ordinateur) ou le bas (téléphone) : on cadre ce qui reste visible.
  const padding = phone ? { top: 90, bottom: 140, left: 24, right: 24 } : { top: 60, bottom: 130, left: 470, right: 40 };
  map.fitBounds(action.bounds, { padding, maxZoom: 7.5, duration: prefersReducedMotion() ? 0 : 1600 });
}

/** Signe de gravité : une forme par cran (cercle creux, rond, triangle, losange), jamais la couleur seule. */
function SeverityMark({ level }: { level: Severity }) {
  const stroke = 'var(--ui-ink)';
  const fill = level === 2 ? STATUS.jaune : level === 3 ? STATUS.orange : level === 4 ? STATUS.rouge : 'none';
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false" className="today__mark">
      {level === 4 ? (
        <path d="M7 1 13 7 7 13 1 7Z" fill={fill} stroke={stroke} strokeWidth="1.2" strokeLinejoin="round" />
      ) : level === 3 ? (
        <path d="M7 1.5 13 12H1Z" fill={fill} stroke={stroke} strokeWidth="1.2" strokeLinejoin="round" />
      ) : (
        <circle cx="7" cy="7" r={level === 2 ? 5 : 4} fill={fill} stroke={stroke} strokeWidth="1.2" strokeDasharray={level === 1 ? '2 2' : undefined} />
      )}
    </svg>
  );
}

function Badge({ level, label }: { level: Severity; label: string }) {
  return (
    <span className="today__badge" data-level={level}>
      <SeverityMark level={level} />
      {label}
    </span>
  );
}

function RowView({ row, onPick }: { row: Row; onPick: (action: Action) => void }) {
  const content = (
    <>
      <span className="today__rowtext">
        <span className="today__rowtitle">
          {row.title}
          {row.level && <Badge level={row.level} label={levelLabel(row.level)} />}
        </span>
        {row.detail && <span className="today__rowdetail">{row.detail}</span>}
      </span>
      {row.action && <Icon name="chevron" size={16} className="today__go" />}
    </>
  );
  return (
    <li>
      {row.action ? (
        <button type="button" className="today__row" onClick={() => onPick(row.action!)}>
          {content}
        </button>
      ) : (
        <div className="today__row today__row--static">{content}</div>
      )}
    </li>
  );
}

function RubricCard({ rubric, onPick }: { rubric: Rubric; onPick: (action: Action) => void }) {
  return (
    <section className="today__card" aria-label={rubric.title}>
      <header className="today__cardhead">
        <Icon name={rubric.icon} size={18} />
        <h3 className="today__cardtitle">{rubric.title}</h3>
        <Badge level={rubric.severity} label={severityLabel(rubric)} />
      </header>
      <p className="today__summary">{rubric.summary}</p>
      {rubric.rows.length > 0 && (
        <ul className="today__rows">
          {rubric.rows.map((row) => (
            <RowView key={row.key} row={row} onPick={onPick} />
          ))}
        </ul>
      )}
      {rubric.more && (
        <button type="button" className="today__more" onClick={() => onPick(rubric.more!.action)}>
          {rubric.more.text}
          <Icon name="chevron" size={14} />
        </button>
      )}
    </section>
  );
}

interface SyntheseViewProps {
  manager: ModuleManager;
  phone: boolean;
  /** Après un clic sur une ligne (sur téléphone, la feuille se réduit pour laisser voir la carte). */
  onPicked: () => void;
  /** Ferme le panneau (absent sur téléphone : la feuille a ses onglets). */
  onClose?: () => void;
}

/** Contenu du panneau « Aujourd'hui en France » : l'en-tête, les rubriques notables par gravité, les lignes calmes. */
export function SyntheseView({ manager, phone, onPicked, onClose }: SyntheseViewProps) {
  const { loaded, error, loading, reload } = useSynthesis(manager);
  const now = useNow(30_000);
  const digest = useMemo(() => (loaded ? buildDigest(loaded.api, loaded.quakes, now) : null), [loaded, now]);

  const pick = (action: Action) => {
    run(manager, action, phone);
    onPicked();
  };

  const updated = loaded ? formatRelative(loaded.api.generatedAt * 1000, now) : null;

  return (
    <div className="today">
      <header className="today__head">
        <div className="today__titles">
          <span className="kicker">Aujourd’hui · {formatLongDate(now)}</span>
          {!phone && <h2 className="today__title">En France, maintenant</h2>}
          <p className="today__stamp" aria-live="polite">
            {loading && !loaded ? 'Chargement…' : error && !loaded ? 'Synthèse indisponible' : `Mis à jour ${updated}`}
            {error && loaded && ' · actualisation impossible, données anciennes'}
          </p>
        </div>
        <button type="button" className="icon-button" onClick={() => void reload()} aria-label="Actualiser la synthèse" title="Actualiser" disabled={loading}>
          <Icon name="refresh" size={16} />
        </button>
        {onClose && (
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fermer la synthèse (Échap)">
            <Icon name="x" size={16} />
          </button>
        )}
      </header>

      {error && !loaded && (
        <div className="today__error" role="alert">
          <p>Le serveur ne répond pas ({error}).</p>
          <button type="button" className="btn btn--small" onClick={() => void reload()}>
            Réessayer
          </button>
        </div>
      )}

      {digest && (
        <div className="today__body">
          {digest.notable.length === 0 && <p className="today__quiet">Rien de notable en ce moment.</p>}
          {digest.notable.map((rubric) => (
            <RubricCard key={rubric.id} rubric={rubric} onPick={pick} />
          ))}
          {digest.calm.length > 0 && (
            <ul className="today__calm" aria-label="Rien à signaler">
              {digest.calm.map((rubric) => (
                <li key={rubric.id} className="today__calmrow">
                  <Icon name="check" size={14} />
                  <span>{rubric.calm}</span>
                </li>
              ))}
            </ul>
          )}
          {digest.unavailable.length > 0 && (
            <p className="today__unavailable">Pas de donnée pour l’instant : {digest.unavailable.join(', ')}.</p>
          )}
        </div>
      )}
    </div>
  );
}
