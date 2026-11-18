import { useEffect, useMemo, useRef, useState } from 'react';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { IControl } from 'maplibre-gl';
import { clock } from '../core/clock';
import { distanceM } from '../core/geo';
import type { ModuleManager } from '../core/moduleManager';
import { position, usePosition, type UserPosition } from '../core/position';
import { accuracyText, distanceText, roundPosition, within, type Found, type LonLat } from '../core/positionLogic';
import { zoneStore } from '../core/zone';
import { FUELS, recentPrice, type FuelData, type FuelId } from '../modules/fuel';
import type { BikesData } from '../modules/bikes';
import type { ChargersData } from '../modules/chargers';
import type { Station as TrainStation, TrainsData, TrainsSelection } from '../modules/trains';
import { dataOf, openObject } from '../search/access';
import { formatTime } from './format';
import { useModuleStates } from './hooks';
import { Icon } from './icons';
import { useMap } from './ZoneTool';
import { WatchAroundMe } from './Veille';

/**
 * « Autour de moi » : un bouton parmi les commandes de la carte (en bas à droite, avec l'analyse de zone), qui demande la position
 * (au clic seulement, voir `core/position.ts`), centre la carte, pose un point « vous êtes ici » avec son cercle de précision et
 * ouvre un petit panneau : la gare la plus proche et ses prochains départs, les stations de vélos, les bornes et les stations-service
 * les moins chères à moins de 10 km. Seules les données **déjà chargées** par les couches servent ; pour les autres, un bouton les
 * charge (`ModuleManager.prefetch`), jamais de lui-même. Chaque ligne ouvre l'objet comme un résultat de la recherche.
 */

const AROUND_M = 10_000;
const TRAIN_RADIUS_M = 30_000;
const SHOWN = 3;
const BLUE: [number, number, number] = [26, 115, 232];

/** Le bouton des commandes de la carte (même famille que l'analyse de zone). */
class PositionControl implements IControl {
  private container = document.createElement('div');
  readonly button = document.createElement('button');

  constructor(private readonly onClick: () => void) {}

  onAdd(): HTMLElement {
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group maplibregl-ctrl-position';
    this.button.type = 'button';
    this.button.title = 'Autour de moi : se localiser (la position reste dans ce navigateur)';
    this.button.setAttribute('aria-label', 'Autour de moi');
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/></svg>';
    this.button.addEventListener('click', () => this.onClick());
    this.container.append(this.button);
    return this.container;
  }

  onRemove(): void {
    this.container.remove();
  }
}

/** Zoom qui montre la précision : un point précis se regarde de près, une position à 2 km de large se regarde de loin. */
const zoomFor = (accuracy: number): number => (accuracy <= 150 ? 14.5 : accuracy <= 1500 ? 12.5 : 10.5);

export function PositionTool({ manager, phone }: { manager: ModuleManager; phone: boolean }) {
  const map = useMap(manager);
  const here = usePosition();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(() => manager.getSelection() != null);
  const control = useRef<PositionControl | null>(null);
  const lastFlown = useRef<number>(0);

  useEffect(() => {
    const refresh = () => setSelected(manager.getSelection() != null);
    return manager.subscribe(refresh);
  }, [manager]);

  /** Cadre la position ; sur téléphone, le panneau couvre le bas : le point est remonté dans la partie visible. */
  const fly = (found: UserPosition) => {
    if (!map) return;
    const height = map.getContainer().clientHeight;
    // Centrée sur la position arrondie (≈ 1 km) : la vue s'écrit dans l'adresse de la page, qui ne doit pas porter la position exacte.
    // Le point, lui, est posé à l'endroit exact (zoom assez large pour qu'il reste dans l'écran).
    const [clon, clat] = roundPosition(found.lon, found.lat);
    map.flyTo({ center: [clon, clat], zoom: Math.min(13.5, Math.max(map.getZoom(), zoomFor(found.accuracy))), offset: [0, phone ? -height * 0.28 : 0], essential: false });
    lastFlown.current = found.at;
  };

  const activate = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    zoneStore.setPanelOpen(false);
    void position.locate().then((found) => found && fly(found));
  };

  // Le bouton : un seul, la dernière version du geste lui est donnée par la référence.
  const activateRef = useRef(activate);
  activateRef.current = activate;
  useEffect(() => {
    if (!map) return;
    const ctrl = new PositionControl(() => activateRef.current());
    control.current = ctrl;
    map.addControl(ctrl, 'bottom-right');
    return () => {
      control.current = null;
      map.removeControl(ctrl);
    };
  }, [map]);
  useEffect(() => {
    const button = control.current?.button;
    if (!button) return;
    button.classList.toggle('is-active', !!here.position);
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-pressed', String(open));
  }, [here.position, open, map]);

  // Le point « vous êtes ici » : une surcouche deck.gl à part, au-dessus de tout (comme le contour de l'analyse de zone).
  const overlay = useRef<MapboxOverlay | null>(null);
  useEffect(() => {
    if (!map) return;
    const deck = new MapboxOverlay({ interleaved: false, layers: [] });
    map.addControl(deck);
    overlay.current = deck;
    return () => {
      overlay.current = null;
      map.removeControl(deck);
    };
  }, [map]);
  useEffect(() => {
    const p = here.position;
    overlay.current?.setProps({
      layers: p
        ? [
            new ScatterplotLayer<UserPosition>({
              id: 'position-precision',
              data: [p],
              getPosition: (d) => [d.lon, d.lat],
              getRadius: (d) => d.accuracy,
              radiusUnits: 'meters',
              radiusMinPixels: 14,
              getFillColor: [...BLUE, 36],
              getLineColor: [...BLUE, 160],
              getLineWidth: 1.5,
              lineWidthUnits: 'pixels',
              stroked: true,
              pickable: false,
              parameters: { depthCompare: 'always' },
            }),
            new ScatterplotLayer<UserPosition>({
              id: 'position-point',
              data: [p],
              getPosition: (d) => [d.lon, d.lat],
              getRadius: 8,
              radiusUnits: 'pixels',
              getFillColor: [...BLUE, 255],
              getLineColor: [255, 255, 255, 255],
              getLineWidth: 3,
              lineWidthUnits: 'pixels',
              stroked: true,
              pickable: false,
              parameters: { depthCompare: 'always' },
            }),
          ]
        : [],
    });
  }, [map, here.position]);

  // Suivi actif : la carte suit le point seulement s'il sort de la partie centrale de l'écran.
  useEffect(() => {
    const p = here.position;
    if (!map || !here.watching || !p || p.at === lastFlown.current) return;
    const { x, y } = map.project([p.lon, p.lat]);
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    if (x < w * 0.2 || x > w * 0.8 || y < h * 0.15 || y > h * (phone ? 0.4 : 0.8)) fly(p);
    // seule une nouvelle mesure déclenche le cadrage
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, here.position, here.watching]);

  // La fermeture du panneau coupe le suivi (la batterie et la vie privée d'abord).
  useEffect(() => {
    if (!open) position.watch(false);
  }, [open]);

  // Échap ferme le panneau (la fiche d'un objet, si elle est ouverte, est fermée d'abord par l'application).
  useEffect(() => {
    if (!open || selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if ((event.target as HTMLElement | null)?.closest('input:not([type="range"]), textarea, [contenteditable="true"]')) return;
      setOpen(false);
      control.current?.button.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, selected]);

  // Pendant le dessin d'une zone, le panneau s'efface.
  useEffect(
    () =>
      zoneStore.subscribe(() => {
        if (zoneStore.getSnapshot().mode !== 'off') setOpen(false);
      }),
    [],
  );

  return (
    <>
      {open && !selected && <AroundPanel manager={manager} phone={phone} onClose={() => (setOpen(false), control.current?.button.focus())} onRelocate={() => void position.locate().then((found) => found && fly(found))} />}
      {open && selected && (
        <button type="button" className="zone-chip zone-chip--position" onClick={() => manager.setSelection(null, null)}>
          <Icon name="x" size={14} /> Revenir à « Autour de moi »
        </button>
      )}
    </>
  );
}

// --- Les données autour de la position -----------------------------------------------------------------------------------------

type Loading = Record<string, 'loading' | 'error'>;

function AroundPanel({ manager, phone, onClose, onRelocate }: { manager: ModuleManager; phone: boolean; onClose: () => void; onRelocate: () => void }) {
  const here = usePosition();
  const states = useModuleStates(manager);
  const [loading, setLoading] = useState<Loading>({});
  const panel = useRef<HTMLElement>(null);
  const found = here.position;
  const origin = useMemo<LonLat | null>(() => (found ? [found.lon, found.lat] : null), [found]);

  // Le focus entre dans le panneau à l'ouverture (clavier et lecteurs d'écran).
  useEffect(() => panel.current?.focus(), []);

  const load = (id: string) => {
    setLoading((now) => ({ ...now, [id]: 'loading' }));
    manager
      .prefetch(id)
      .then(() => setLoading(({ [id]: _done, ...rest }) => (dataOf(manager, id) === undefined ? { ...rest, [id]: 'error' } : rest)))
      .catch(() => setLoading((now) => ({ ...now, [id]: 'error' })));
  };

  const fuelId = (states.carburants?.settings.carburant as FuelId | undefined) ?? 'gazole';

  return (
    <aside ref={panel} tabIndex={-1} className={`zone-panel position-panel panel${phone ? ' zone-panel--phone' : ''}`} aria-label="Autour de moi">
      <header className="info__head">
        <div className="info__titles">
          <span className="kicker">Autour de moi</span>
          <h2 className="info__title">{found ? 'Vous êtes ici' : here.status === 'locating' ? 'Localisation…' : 'Position inconnue'}</h2>
          {found && <p className="info__subtitle mono">{accuracyText(found.accuracy)}</p>}
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Fermer le panneau" title="Fermer le panneau">
          <Icon name="x" size={16} />
        </button>
      </header>

      {here.error && (
        <p className="zone-error" role="alert">
          {here.error}
        </p>
      )}

      {!found && here.status !== 'locating' && (
        <div className="actions">
          <button type="button" className="btn" onClick={onRelocate} disabled={!!position.unavailableReason()}>
            <Icon name="position" size={16} /> {here.accepted ? 'Me localiser à nouveau' : 'Me localiser'}
          </button>
        </div>
      )}

      {origin && (
        <>
          <TrainsBlock manager={manager} origin={origin} loading={loading['trains']} onLoad={() => load('trains')} />
          <BikesBlock manager={manager} origin={origin} loading={loading['velos']} onLoad={() => load('velos')} />
          <ChargersBlock manager={manager} origin={origin} loading={loading['bornes']} onLoad={() => load('bornes')} />
          <FuelBlock manager={manager} origin={origin} fuelId={fuelId} loading={loading['carburants']} onLoad={() => load('carburants')} />

          <section className="zone-section">
            <h3 className="kicker zone-section__title">Veille</h3>
            <WatchAroundMe />
          </section>

          <section className="zone-section position-controls">
            <label className="veille__check">
              <input type="checkbox" checked={here.watching} onChange={(e) => position.watch(e.target.checked)} />
              <span>Suivre ma position (tant que ce panneau est ouvert)</span>
            </label>
            <div className="actions zone-actions">
              <button type="button" className="btn" onClick={onRelocate}>
                <Icon name="position" size={16} /> Actualiser
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  position.clear();
                  onClose();
                }}
              >
                Effacer ma position
              </button>
            </div>
            <p className="today__unavailable">La position reste dans ce navigateur : elle n’est ni envoyée ni écrite dans l’adresse. Elle sert aussi à classer les résultats de la recherche.</p>
          </section>
        </>
      )}
    </aside>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="zone-section">
      <h3 className="kicker zone-section__title">{title}</h3>
      {children}
    </section>
  );
}

/** Ce que montre un bloc dont la couche n'est pas chargée : un bouton, jamais un chargement d'office. */
function LoadButton({ label, loading, onLoad }: { label: string; loading: 'loading' | 'error' | undefined; onLoad: () => void }) {
  return (
    <div className="position-load">
      <button type="button" className="btn btn--small" onClick={onLoad} disabled={loading === 'loading'}>
        {loading === 'loading' ? 'Chargement…' : `Charger ${label}`}
      </button>
      {loading === 'error' && (
        <span className="veille__message" role="status">
          Indisponible pour l’instant.
        </span>
      )}
    </div>
  );
}

interface RowProps {
  title: string;
  detail: string;
  value?: string;
  onClick: () => void;
}

function Rows({ rows }: { rows: RowProps[] }) {
  return (
    <ul className="today__rows">
      {rows.map((row, i) => (
        <li key={`${row.title}:${i}`}>
          <button type="button" className="today__row" onClick={row.onClick}>
            <span className="today__rowtext">
              <span className="today__rowtitle">{row.title}</span>
              <span className="today__rowdetail">{row.detail}</span>
            </span>
            {row.value && <span className="mono position-value">{row.value}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

const Empty = ({ text }: { text: string }) => <p className="today__unavailable">{text}</p>;

// --- Gare ---

function TrainsBlock({ manager, origin, loading, onLoad }: { manager: ModuleManager; origin: LonLat; loading: 'loading' | 'error' | undefined; onLoad: () => void }) {
  const data = dataOf<TrainsData>(manager, 'trains');
  const nearest = useMemo(() => {
    if (!data) return null;
    // Plus proche gare, parmi celles à moins de 30 km (au-delà, « la plus proche » n'aide plus).
    return within(data.stations, origin, TRAIN_RADIUS_M, (s) => [s.lon, s.lat], (a, b) => distanceM(a, b))[0] ?? null;
  }, [data, origin]);

  return (
    <Block title="Gare la plus proche">
      {!data ? (
        <LoadButton label="les gares et les trains" loading={loading} onLoad={onLoad} />
      ) : !nearest ? (
        <Empty text="Aucune gare à moins de 30 km." />
      ) : (
        <StationBlock manager={manager} found={nearest} />
      )}
    </Block>
  );
}

function StationBlock({ manager, found }: { manager: ModuleManager; found: Found<TrainStation> }) {
  const { item: station, distance } = found;
  const now = clock.now() / 1000;
  const departures = station.visits
    .filter(({ run, stop }) => !run.canceled && stop < run.stations.length - 1 && (run.dep[stop] ?? 0) >= now - 60)
    .sort((a, b) => (a.run.dep[a.stop] ?? 0) - (b.run.dep[b.stop] ?? 0))
    .slice(0, SHOWN);
  return (
    <>
      <Rows
        rows={[
          {
            title: station.name,
            detail: `Gare · ${distanceText(distance)}`,
            onClick: () => openObject(manager, 'trains', { type: 'gare', key: station.key } satisfies TrainsSelection, { fallback: station, zoom: 14 }),
          },
        ]}
      />
      {departures.length === 0 ? (
        <Empty text="Pas de départ dans la période chargée." />
      ) : (
        <ul className="position-departures">
          {departures.map(({ run, stop }) => {
            const delay = run.realtime ? (run.dep[stop] ?? 0) - (run.plannedDep[stop] ?? 0) : 0;
            return (
              <li key={`${run.id}:${stop}`} className="position-departure">
                <span className="mono">{formatTime((run.dep[stop] ?? 0) * 1000)}</span>
                <span className="position-departure__to">
                  {run.category.replace(/^Train /, '')} {run.number} → {run.stations[run.stations.length - 1]?.name ?? '?'}
                </span>
                {delay >= 120 && <span className="mono position-departure__late">+{Math.round(delay / 60)} min</span>}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// --- Vélos ---

function BikesBlock({ manager, origin, loading, onLoad }: { manager: ModuleManager; origin: LonLat; loading: 'loading' | 'error' | undefined; onLoad: () => void }) {
  const data = dataOf<BikesData>(manager, 'velos');
  const rows = useMemo(() => {
    if (!data) return null;
    return within(data.stations, origin, AROUND_M, (s) => [s.lon, s.lat], (a, b) => distanceM(a, b))
      .filter(({ item }) => item.renting && item.bikes > 0)
      .slice(0, SHOWN);
  }, [data, origin]);
  return (
    <Block title="Vélos disponibles">
      {!rows ? (
        <LoadButton label="les vélos en libre-service" loading={loading} onLoad={onLoad} />
      ) : rows.length === 0 ? (
        <Empty text="Aucune station avec un vélo à moins de 10 km." />
      ) : (
        <Rows
          rows={rows.map(({ item: s, distance }) => ({
            title: s.name || 'Station',
            detail: `${s.network} · ${distanceText(distance)}`,
            value: `${s.bikes} vélo${s.bikes > 1 ? 's' : ''}`,
            onClick: () => openObject(manager, 'velos', { key: s.key }, { fallback: s, zoom: 16 }),
          }))}
        />
      )}
    </Block>
  );
}

// --- Bornes ---

function ChargersBlock({ manager, origin, loading, onLoad }: { manager: ModuleManager; origin: LonLat; loading: 'loading' | 'error' | undefined; onLoad: () => void }) {
  const data = dataOf<ChargersData>(manager, 'bornes');
  const rows = useMemo(() => {
    if (!data) return null;
    return within(data.stations, origin, AROUND_M, (s) => [s.lon, s.lat], (a, b) => distanceM(a, b))
      .filter(({ item }) => !item.restricted)
      .slice(0, SHOWN);
  }, [data, origin]);
  return (
    <Block title="Bornes de recharge">
      {!rows ? (
        <LoadButton label="les bornes de recharge" loading={loading} onLoad={onLoad} />
      ) : rows.length === 0 ? (
        <Empty text="Aucune borne à moins de 10 km." />
      ) : (
        <Rows
          rows={rows.map(({ item: s, distance }) => ({
            title: s.name || 'Station de recharge',
            detail: [s.operator, distanceText(distance)].filter(Boolean).join(' · '),
            value: s.kw > 0 ? `${Math.round(s.kw)} kW` : undefined,
            onClick: () => openObject(manager, 'bornes', { id: s.id }, { fallback: s, zoom: 16 }),
          }))}
        />
      )}
    </Block>
  );
}

// --- Carburant ---

const euros = (price: number) => `${price.toFixed(3).replace('.', ',')} €/L`;

function FuelBlock({ manager, origin, fuelId, loading, onLoad }: { manager: ModuleManager; origin: LonLat; fuelId: FuelId; loading: 'loading' | 'error' | undefined; onLoad: () => void }) {
  const data = dataOf<FuelData>(manager, 'carburants');
  const rows = useMemo(() => {
    if (!data) return null;
    const near = within(data.stations, origin, AROUND_M, (s) => [s.lon, s.lat], (a, b) => distanceM(a, b));
    // Les moins chères d'abord ; à prix égal, la plus proche (`within` les range déjà par distance : le tri est stable).
    return near
      .flatMap((f) => {
        const price = recentPrice(f.item, fuelId);
        return price === undefined ? [] : [{ ...f, price }];
      })
      .sort((a, b) => a.price - b.price)
      .slice(0, SHOWN);
  }, [data, origin, fuelId]);
  return (
    <Block title="Carburant le moins cher">
      {!rows ? (
        <LoadButton label="les prix des carburants" loading={loading} onLoad={onLoad} />
      ) : (
        <>
          <label className="zone-select position-fuel">
            <span className="setting__label">Carburant</span>
            <select value={fuelId} onChange={(e) => manager.setSetting('carburants', 'carburant', e.target.value)}>
              {FUELS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          {rows.length === 0 ? (
            <Empty text="Aucun prix récent à moins de 10 km." />
          ) : (
            <Rows
              rows={rows.map(({ item: s, distance, price }) => ({
                title: s.city || 'Station-service',
                detail: [s.address, distanceText(distance)].filter(Boolean).join(' · '),
                value: euros(price),
                onClick: () => {
                  manager.setSetting('carburants', 'carburant', fuelId);
                  openObject(manager, 'carburants', { id: s.id }, { fallback: s, zoom: 15 });
                },
              }))}
            />
          )}
        </>
      )}
    </Block>
  );
}
