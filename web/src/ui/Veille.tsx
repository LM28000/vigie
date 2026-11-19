import { useEffect, useState } from 'react';
import { ringBounds } from '../core/geo';
import { position, usePosition } from '../core/position';
import { WATCH_RADII_KM, type WatchRadiusKm } from '../core/positionLogic';
import type { ModuleManager } from '../core/moduleManager';
import { allDepartments, levelLabel, type Action } from '../core/syntheseModel';
import {
  searchCommunes,
  useVeille,
  veille,
  zoneFromCircle,
  zoneFromCommune,
  zoneFromDepartment,
  zoneAroundMe,
  zoneFromPolygon,
  type CommuneHit,
  type EventType,
  type Toast,
  type VeilleAlert,
  type VeilleEvent,
  type VeilleZone,
} from '../core/veille';
import { DEFAULT_TYPES, EVENT_TYPES, MAX_ZONES, TYPE_LABELS } from '../core/veilleLogic';
import { zoneStore, type ZoneShape } from '../core/zone';
import { mapOf, prefersReducedMotion } from '../search/access';
import { formatRelative } from './format';
import { useNow } from './hooks';
import { Icon } from './icons';
import { Badge, runAction } from './Synthese';

/** L'icône de chaque type d'événement : celle de la couche qu'il ouvre. */
const TYPE_ICONS: Record<EventType, string> = {
  vigilance: 'vigilance-meteo',
  crue: 'vigicrues',
  montee: 'rivieres',
  incendie: 'feux',
  seisme: 'seismes',
  brouillage: 'brouillage-gps',
  avion: 'avions',
  train: 'trains',
  avalanche: 'neige',
  evenement: 'evenements',
  actualite: 'actualite',
};

/** Vigilance et crues disent leur gravité par une couleur officielle ; le reste, par un mot. */
function severityName(event: VeilleEvent): string {
  if ((event.type === 'vigilance' || event.type === 'crue') && event.severity >= 2) return levelLabel(event.severity as 2 | 3 | 4);
  return ({ 1: 'À noter', 2: 'Notable', 3: 'Important', 4: 'Critique' } as Record<number, string>)[event.severity] ?? '';
}

/** Un clic sur une alerte : on vole vers l'objet et sa fiche s'ouvre (comme une ligne de « Aujourd'hui »). */
function actionOf(event: VeilleEvent): Action | null {
  if (event.lon === undefined || event.lat === undefined) return null;
  return { kind: 'object', moduleId: event.module, selection: event.selection, lon: event.lon, lat: event.lat, zoom: event.zoom };
}

function flyToEvent(manager: ModuleManager, event: VeilleEvent, phone: boolean): void {
  const action = actionOf(event);
  if (action) runAction(manager, action, phone);
}

/** Cadre la carte sur une zone, dans ce que le panneau laisse voir. */
function flyToZone(manager: ModuleManager, zone: VeilleZone, phone: boolean): void {
  const map = mapOf(manager);
  if (!map) return;
  const [west, south, east, north] = ringBounds(zone.ring);
  const padding = phone ? { top: 90, bottom: 140, left: 24, right: 24 } : { top: 60, bottom: 130, left: 470, right: 40 };
  map.fitBounds([[west, south], [east, north]], { padding, maxZoom: 13, duration: prefersReducedMotion() ? 0 : 1400 });
}

// --- Les alertes --------------------------------------------------------------------------------------------------------------

function AlertRow({ alert, isNew, now, onPick }: { alert: VeilleAlert; isNew: boolean; now: number; onPick: (alert: VeilleAlert) => void }) {
  const { event } = alert;
  const content = (
    <>
      <span className="veille__type" aria-hidden="true">
        <Icon name={TYPE_ICONS[event.type]} size={18} />
      </span>
      <span className="today__rowtext">
        <span className="today__rowtitle">
          {event.title}
          <Badge level={event.severity} label={severityName(event)} />
          {isNew && (
            <span className="veille__new">
              <span className="veille__dot" aria-hidden="true" />
              Nouveau
            </span>
          )}
        </span>
        <span className="today__rowdetail">{[event.detail, alert.zoneName].filter((part, i, all) => part && all.indexOf(part) === i).join(' · ')}</span>
        <span className="today__rowdetail veille__when">{formatRelative(alert.at, now)}</span>
      </span>
      {actionOf(event) && <Icon name="chevron" size={16} className="today__go" />}
    </>
  );
  return (
    <li>
      {actionOf(event) ? (
        <button type="button" className="today__row" onClick={() => onPick(alert)}>
          {content}
        </button>
      ) : (
        <div className="today__row today__row--static">{content}</div>
      )}
    </li>
  );
}

// --- Les zones ------------------------------------------------------------------------------------------------------------------

function ZoneCard({ zone, active, manager, phone, onPicked }: { zone: VeilleZone; active: VeilleEvent[] | undefined; manager: ModuleManager; phone: boolean; onPicked: () => void }) {
  const { display } = useVeille();
  const showOnMap = display.showOnMap;
  const shown = !display.hidden.includes(zone.id);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(zone.name);
  const worst = active && active.length > 0 ? (Math.max(...active.map((e) => e.severity)) as 1 | 2 | 3 | 4) : null;
  const toggle = (type: EventType) => {
    const next = zone.types.includes(type) ? zone.types.filter((t) => t !== type) : EVENT_TYPES.filter((t) => t === type || zone.types.includes(t));
    if (next.length > 0) veille.setTypes(zone.id, next);
  };
  const waiting = active === undefined;
  return (
    <section className="today__card veille__zone" aria-label={zone.name}>
      <header className="today__cardhead">
        <button
          type="button"
          className="veille__zonename"
          onClick={() => {
            flyToZone(manager, zone, phone);
            onPicked();
          }}
          title="Cadrer la carte sur cette zone"
        >
          {zone.name}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => veille.setZoneShown(zone.id, !shown)}
          aria-pressed={shown}
          aria-label={`Afficher la zone ${zone.name} sur la carte`}
          title={!showOnMap ? 'Zones cachées : réglage général' : shown ? 'Zone affichée sur la carte' : 'Zone cachée (toujours surveillée)'}
          disabled={!showOnMap}
        >
          <Icon name={shown && showOnMap ? 'oeil' : 'oeil-barre'} size={16} />
        </button>
        <button type="button" className="icon-button" onClick={() => setEditing((v) => !v)} aria-expanded={editing} aria-label={`Réglages de la zone ${zone.name}`} title="Réglages">
          <Icon name="chevronDown" size={16} className={editing ? 'veille__flip' : undefined} />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            if (window.confirm(`Ne plus surveiller « ${zone.name} » ?`)) veille.removeZone(zone.id);
          }}
          aria-label={`Supprimer la zone ${zone.name}`}
          title="Supprimer la zone"
        >
          <Icon name="corbeille" size={16} />
        </button>
      </header>
      <p className="today__summary veille__status">
        {waiting ? (
          'En attente du premier relevé…'
        ) : worst ? (
          <>
            <Badge level={worst} label={`${active!.length} en cours`} />
            <span>le plus grave : {severityName(active!.reduce((a, b) => (b.severity > a.severity ? b : a)))}</span>
          </>
        ) : (
          <>
            <Icon name="check" size={14} />
            Rien à signaler en ce moment
          </>
        )}
      </p>
      {active && active.length > 0 && (
        <ul className="today__rows">
          {active.slice(0, 4).map((event) => (
            <li key={event.id}>
              <button
                type="button"
                className="today__row"
                disabled={!actionOf(event)}
                onClick={() => {
                  flyToEvent(manager, event, phone);
                  onPicked();
                }}
              >
                <span className="veille__type" aria-hidden="true">
                  <Icon name={TYPE_ICONS[event.type]} size={16} />
                </span>
                <span className="today__rowtext">
                  <span className="today__rowtitle">
                    {event.title}
                    <Badge level={event.severity} label={severityName(event)} />
                  </span>
                  {event.detail && <span className="today__rowdetail">{event.detail}</span>}
                </span>
                <Icon name="chevron" size={16} className="today__go" />
              </button>
            </li>
          ))}
          {active.length > 4 && <li className="today__rowdetail veille__more">et {active.length - 4} autre{active.length - 4 > 1 ? 's' : ''}</li>}
        </ul>
      )}
      {editing && (
        <div className="veille__editor">
          <label className="veille__field">
            <span className="kicker">Nom</span>
            <input
              className="veille__input"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => (name.trim() ? veille.rename(zone.id, name) : setName(zone.name))}
              onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
            />
          </label>
          <fieldset className="veille__types">
            <legend className="kicker">Prévenir pour</legend>
            {EVENT_TYPES.map((type) => (
              <label key={type} className="veille__check">
                <input type="checkbox" checked={zone.types.includes(type)} disabled={zone.types.length === 1 && zone.types.includes(type)} onChange={() => toggle(type)} />
                <Icon name={TYPE_ICONS[type]} size={16} />
                <span>{TYPE_LABELS[type]}</span>
              </label>
            ))}
          </fieldset>
        </div>
      )}
    </section>
  );
}

// --- Surveiller autour de moi ------------------------------------------------------------------------------------------------

/**
 * Crée une zone circulaire (10, 25 ou 50 km) autour de la position de la personne. La localisation est demandée au clic
 * (jamais avant) ; seule la position arrondie à environ 1 km entre dans la zone, comme dit sous le bouton.
 */
export function WatchAroundMe({ onAdded }: { onAdded?: (zone: VeilleZone) => void }) {
  const here = usePosition();
  const [radius, setRadius] = useState<WatchRadiusKm>(25);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const reason = position.unavailableReason();

  const run = async () => {
    setMessage(null);
    setDone(false);
    const found = await position.locate();
    if (!found) {
      setMessage(position.getSnapshot().error ?? 'Localisation impossible.');
      return;
    }
    const zone = zoneAroundMe(found.lon, found.lat, radius);
    if (!veille.addZone(zone)) {
      setMessage(`${MAX_ZONES} zones au plus : en supprimer une d’abord.`);
      return;
    }
    setDone(true);
    setMessage(`Zone « ${zone.name} » ajoutée.`);
    onAdded?.(zone);
  };

  return (
    <div className="veille__around">
      <div className="segmented" role="radiogroup" aria-label="Rayon de la zone">
        {WATCH_RADII_KM.map((km) => (
          <button key={km} type="button" role="radio" aria-checked={radius === km} className="segmented__option" onClick={() => setRadius(km)}>
            {km} km
          </button>
        ))}
      </div>
      <button type="button" className="btn" onClick={() => void run()} disabled={!!reason || here.status === 'locating'}>
        <Icon name="veille" size={16} /> {here.status === 'locating' ? 'Localisation…' : 'Surveiller autour de moi'}
      </button>
      <p className="today__unavailable">
        {reason ?? 'Un cercle centré sur votre position arrondie à environ 1 km, gardé dans ce navigateur ; le serveur ne reçoit que ce contour, comme pour toute zone.'}
      </p>
      {message && (
        <p className={done ? 'veille__ok' : 'veille__message'} role="status">
          {message}
        </p>
      )}
    </div>
  );
}

// --- Ajouter une zone ---------------------------------------------------------------------------------------------------------

function ZoneAdder({ manager, onAdded, onDrawStart }: { manager: ModuleManager; onAdded: (zone: VeilleZone) => void; onDrawStart: () => void }) {
  const [mode, setMode] = useState<'menu' | 'commune' | 'departement' | 'moi'>('menu');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<CommuneHit[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Recherche de communes : un peu après la dernière frappe, la précédente abandonnée.
  useEffect(() => {
    if (mode !== 'commune' || query.trim().length < 2) {
      setHits([]);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      searchCommunes(query, abort.signal)
        .then((rows) => {
          setHits(rows);
          setMessage(rows.length === 0 ? 'Aucune commune de ce nom.' : null);
        })
        .catch((error: unknown) => {
          if (!abort.signal.aborted) setMessage(`Recherche impossible (${error instanceof Error ? error.message : 'réseau'}).`);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [mode, query]);

  const add = (zone: VeilleZone) => {
    if (!veille.addZone(zone)) {
      setMessage(`${MAX_ZONES} zones au plus : en supprimer une d’abord.`);
      return;
    }
    setMessage(null);
    setMode('menu');
    setQuery('');
    onAdded(zone);
  };

  const draw = (kind: 'circle' | 'polygon') => {
    zoneStore.drawFor(kind, (shape: ZoneShape) => add(shape.kind === 'circle' ? zoneFromCircle(shape.center, shape.radius) : zoneFromPolygon(shape.points)));
    // Sur téléphone la feuille se réduit : la carte est libre pour dessiner.
    onDrawStart();
  };

  const aroundCenter = () => {
    const center = mapOf(manager)?.getCenter();
    if (!center) return;
    add(zoneFromCircle([center.lng, center.lat], 10_000));
  };

  const pickCommune = async (hit: CommuneHit) => {
    setBusy(true);
    setMessage(null);
    try {
      add(await zoneFromCommune(hit.code));
    } catch (error) {
      setMessage(`Commune indisponible (${error instanceof Error ? error.message : 'réseau'}).`);
    } finally {
      setBusy(false);
    }
  };

  const pickDepartment = (code: string) => {
    const zone = zoneFromDepartment(code);
    if (zone) add(zone);
    else setMessage('Département introuvable.');
  };

  return (
    <section className="today__card veille__adder" aria-label="Ajouter une zone à surveiller">
      <h3 className="today__cardtitle">Ajouter une zone</h3>
      {mode === 'menu' && (
        <div className="veille__choices">
          <button type="button" className="btn" onClick={() => draw('circle')}>
            <Icon name="plus" size={16} /> Cercle
          </button>
          <button type="button" className="btn" onClick={() => draw('polygon')}>
            <Icon name="plus" size={16} /> Polygone
          </button>
          <button type="button" className="btn" onClick={() => setMode('commune')}>
            Commune
          </button>
          <button type="button" className="btn" onClick={() => setMode('departement')}>
            Département
          </button>
          <button type="button" className="btn veille__wide" onClick={aroundCenter} title="Un cercle de 10 km autour du centre de la carte">
            Cercle de 10 km autour du centre de la carte
          </button>
          <button type="button" className="btn veille__wide" onClick={() => setMode('moi')} title="Un cercle centré sur votre position (demandée au clic)">
            Autour de moi (ma position)
          </button>
        </div>
      )}
      {mode === 'moi' && (
        <WatchAroundMe
          onAdded={(zone) => {
            setMode('menu');
            onAdded(zone);
          }}
        />
      )}
      {mode === 'commune' && (
        <div className="veille__search">
          <label className="veille__field">
            <span className="kicker">Nom ou code postal</span>
            <input className="veille__input" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Bordeaux, 33000…" inputMode="search" />
          </label>
          {hits.length > 0 && (
            <ul className="today__rows">
              {hits.map((hit) => (
                <li key={hit.code}>
                  <button type="button" className="today__row" disabled={busy} onClick={() => void pickCommune(hit)}>
                    <span className="today__rowtext">
                      <span className="today__rowtitle">{hit.name}</span>
                      <span className="today__rowdetail">
                        Département {hit.department}
                        {hit.population ? ` · ${hit.population.toLocaleString('fr-FR')} habitants` : ''}
                      </span>
                    </span>
                    <Icon name="plus" size={16} className="today__go" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {mode === 'departement' && (
        <label className="veille__field">
          <span className="kicker">Département</span>
          <select className="veille__input" autoFocus defaultValue="" onChange={(e) => e.target.value && pickDepartment(e.target.value)}>
            <option value="" disabled>
              Choisir…
            </option>
            {allDepartments().map((department) => (
              <option key={department.code} value={department.code}>
                {department.code} · {department.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {message && (
        <p className="veille__message" role="status">
          {message}
        </p>
      )}
      {mode !== 'menu' && (
        <button type="button" className="btn btn--small veille__back" onClick={() => (setMode('menu'), setMessage(null), setQuery(''))}>
          Retour
        </button>
      )}
    </section>
  );
}

// --- Le panneau ----------------------------------------------------------------------------------------------------------------

interface VeilleViewProps {
  manager: ModuleManager;
  phone: boolean;
  /** Après un clic qui mène à la carte (sur téléphone, la feuille se réduit pour la laisser voir). */
  onPicked: () => void;
  /** Ferme le panneau (absent sur téléphone : la feuille a ses onglets). */
  onClose?: () => void;
}

/** Contenu du panneau « Veille » : état du relevé, alertes récentes, zones, ajout d'une zone. */
export function VeilleView({ manager, phone, onPicked, onClose }: VeilleViewProps) {
  const state = useVeille();
  const now = useNow(30_000);
  const [adding, setAdding] = useState(false);
  const newKeys = new Set(state.newKeys);
  const secure = veille.notificationsAvailable();
  const [notifyMessage, setNotifyMessage] = useState<string | null>(null);

  const pick = (alert: VeilleAlert) => {
    flyToEvent(manager, alert.event, phone);
    onPicked();
  };

  const stamp = state.error
    ? `Surveillance interrompue : ${state.error}`
    : state.zones.length === 0
      ? 'Aucune zone surveillée'
      : state.checkedAt
        ? `Dernier relevé ${formatRelative(state.checkedAt, now)}`
        : 'Premier relevé en cours…';

  return (
    <div className="today veille">
      <header className="today__head">
        <div className="today__titles">
          <span className="kicker">Veille</span>
          {!phone && <h2 className="today__title">Mes zones surveillées</h2>}
          <p className="today__stamp" aria-live="polite">
            {stamp}
          </p>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => veille.setSound(!state.prefs.sound)}
          aria-pressed={state.prefs.sound}
          aria-label={state.prefs.sound ? 'Couper le signal sonore des alertes' : 'Activer un signal sonore pour les nouvelles alertes'}
          title={state.prefs.sound ? 'Signal sonore activé' : 'Signal sonore désactivé'}
        >
          <Icon name={state.prefs.sound ? 'son' : 'son-coupe'} size={16} />
        </button>
        <button type="button" className="icon-button" onClick={() => void veille.poll()} aria-label="Relever maintenant" title="Relever maintenant" disabled={state.checking || state.zones.length === 0}>
          <Icon name="refresh" size={16} />
        </button>
        {onClose && (
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fermer la veille (Échap)">
            <Icon name="x" size={16} />
          </button>
        )}
      </header>

      <div className="today__body">
        {state.error && (
          <p className="veille__alert" role="alert">
            <Icon name="vigilance-meteo" size={16} />
            <span>Les zones ne sont plus relevées : le serveur ne répond pas. Aucune alerte ne peut arriver tant que ça dure.</span>
          </p>
        )}
        {!state.error && state.unavailable.length > 0 && (
          <p className="today__unavailable">
            Sources muettes au dernier relevé : {state.unavailable.map((type) => TYPE_LABELS[type as EventType]?.toLowerCase() ?? type).join(', ')}. Ce n’est pas « rien à signaler ».
          </p>
        )}

        {state.zones.length === 0 && !adding && (
          <p className="veille__intro">
            Choisissez un lieu (commune, département, cercle ou contour dessiné) : Vigie vous prévient ici quand il s’y passe quelque chose, vigilance orange ou rouge, crue, rivière en forte montée,
            incendie, séisme ressenti, risque d’avalanche fort, brouillage GPS, train supprimé ou très en retard.
          </p>
        )}

        {state.zones.length > 0 && (
          <section className="today__card" aria-label="Alertes récentes">
            <header className="today__cardhead">
              <Icon name="veille" size={18} />
              <h3 className="today__cardtitle">Alertes récentes</h3>
              {state.alerts.length > 0 && (
                <button type="button" className="btn btn--small" onClick={() => veille.clearAlerts()}>
                  Tout effacer
                </button>
              )}
            </header>
            {state.alerts.length === 0 ? (
              <p className="today__summary veille__status">
                <Icon name="check" size={14} />
                Aucune alerte pour l’instant. Elles apparaîtront ici et dans une pastille discrète.
              </p>
            ) : (
              <ul className="today__rows">
                {state.alerts.slice(0, 20).map((alert) => (
                  <AlertRow key={alert.key} alert={alert} isNew={newKeys.has(alert.key)} now={now} onPick={pick} />
                ))}
              </ul>
            )}
          </section>
        )}

        {state.zones.length > 0 && (
          <label className="veille__check">
            <input type="checkbox" checked={state.display.showOnMap} onChange={(e) => veille.setShowOnMap(e.target.checked)} />
            <span>Afficher les zones sur la carte</span>
          </label>
        )}

        {state.zones.map((zone) => (
          <ZoneCard key={zone.id} zone={zone} active={state.active[zone.id]} manager={manager} phone={phone} onPicked={onPicked} />
        ))}

        {adding || state.zones.length === 0 ? (
          <ZoneAdder
            manager={manager}
            onDrawStart={() => {
              setAdding(false);
              onPicked();
            }}
            onAdded={(zone) => {
              setAdding(false);
              flyToZone(manager, zone, phone);
              onPicked();
            }}
          />
        ) : (
          <button type="button" className="btn veille__add" onClick={() => setAdding(true)} disabled={state.zones.length >= MAX_ZONES}>
            <Icon name="plus" size={16} /> Ajouter une zone
          </button>
        )}

        <section className="veille__foot" aria-label="Notifications">
          <p className="today__unavailable">
            {secure
              ? 'Ce site est en connexion sécurisée : les notifications du navigateur sont possibles.'
              : 'Ce site est servi en HTTP sur le réseau local : le navigateur n’autorise pas les notifications. Les alertes restent dans l’application (avis, liste, pastille, titre de l’onglet).'}
          </p>
          {secure && (
            <label className="veille__check">
              <input
                type="checkbox"
                checked={state.prefs.notify}
                onChange={(e) => {
                  setNotifyMessage(null);
                  void veille.setNotify(e.target.checked).then((result) => {
                    if (result === 'refusee') setNotifyMessage('Notifications non autorisées : elles se réactivent dans les réglages du navigateur (cadenas de la barre d’adresse).');
                  });
                }}
              />
              <span>Notifier aussi quand l’onglet est masqué</span>
            </label>
          )}
          {secure && notifyMessage && (
            <p className="veille__message" role="status">
              {notifyMessage}
            </p>
          )}
          <p className="today__unavailable">Zones et alertes sont gardées dans ce navigateur seulement. Défaut : {DEFAULT_TYPES.map((t) => TYPE_LABELS[t].toLowerCase()).join(', ')}.</p>
        </section>
      </div>
    </div>
  );
}

// --- Les avis (toasts) -----------------------------------------------------------------------------------------------------------

/** Avis discrets, en haut de la carte (au-dessus de la feuille sur téléphone) : un clic mène à l'objet. Jamais bloquants. */
export function VeilleToasts({ manager, phone }: { manager: ModuleManager; phone: boolean }) {
  const { toasts } = useVeille();
  if (toasts.length === 0) return null;
  return (
    <div className={`veille-toasts${phone ? ' veille-toasts--phone' : ''}`} role="region" aria-label="Nouvelles alertes" aria-live="polite">
      {toasts.map((toast) => (
        <ToastView key={toast.key} toast={toast} manager={manager} phone={phone} />
      ))}
    </div>
  );
}

function ToastView({ toast, manager, phone }: { toast: Toast; manager: ModuleManager; phone: boolean }) {
  const alert = toast.alert;
  return (
    <div className="veille-toast panel" role={toast.severity >= 4 ? 'alert' : 'status'}>
      <button
        type="button"
        className="veille-toast__main"
        onClick={() => {
          if (alert) flyToEvent(manager, alert.event, phone);
          else window.dispatchEvent(new Event('veille:ouvrir'));
          veille.dismissToast(toast.key);
        }}
      >
        <span className="veille__type" aria-hidden="true">
          <Icon name={alert ? TYPE_ICONS[alert.event.type] : 'veille'} size={18} />
        </span>
        <span className="today__rowtext">
          <span className="today__rowtitle">
            {toast.title}
            <Badge level={toast.severity} label={alert ? severityName(alert.event) : ({ 1: 'À noter', 2: 'Notable', 3: 'Important', 4: 'Critique' } as Record<number, string>)[toast.severity]!} />
          </span>
          <span className="today__rowdetail">{toast.zoneName}</span>
        </span>
      </button>
      <button type="button" className="icon-button" onClick={() => veille.dismissToast(toast.key)} aria-label="Fermer cet avis">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
