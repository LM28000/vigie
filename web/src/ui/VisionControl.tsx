import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { IControl } from 'maplibre-gl';
import type { ModuleManager } from '../core/moduleManager';
import { currentNight } from '../map/baseMap';
import { VISION_LABELS, VISION_MODES, type VisionMode, useVision, vision } from '../core/vision';
import { useMap } from './ZoneTool';
import './vision.css';

/**
 * Modes de vision (`core/vision.ts`) : un bouton parmi les commandes de la carte (en bas à droite, au-dessus de l'analyse de zone),
 * qui ouvre un petit menu de quatre choix, et le raccourci `V` qui les fait défiler.
 *
 * Le rendu lui-même est un filtre CSS / SVG posé sur le seul canevas de la carte, plus une surcouche sans pointeur (balayage, grain,
 * vignettage) rangée dans le conteneur du canevas : les commandes, les panneaux et la fiche restent nets, les clics passent
 * (voir « Modes de vision » dans docs/rendu-3d.md).
 */

/** Une commande MapLibre vide : le contenu est rendu par React dans son conteneur. */
class VisionHost implements IControl {
  readonly element = document.createElement('div');
  onAdd(): HTMLElement {
    this.element.className = 'maplibregl-ctrl vision-ctrl';
    return this.element;
  }
  onRemove(): void {
    this.element.remove();
  }
}

/** Points de la palette thermique « ironbow » : noir, violet, rouge, jaune, blanc (luminance 0 → 1). */
const THERMAL_STOPS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 0, 0],
  [0.18, 0.2, 0, 0.38],
  [0.38, 0.55, 0.05, 0.5],
  [0.58, 0.88, 0.16, 0.14],
  [0.78, 1, 0.68, 0.06],
  [0.9, 1, 0.93, 0.35],
  [1, 1, 1, 1],
];
/** Les surfaces claires du fond de jour tomberaient toutes dans le jaune : la luminance est redressée avant la palette. */
const THERMAL_DAY = { black: 0.4, white: 1, gamma: 2.4 };
/** La carte de nuit est sombre (luminance de 0,04 à 0,35) : la même palette, étirée sur cette plage. */
const THERMAL_NIGHT = { black: 0.03, white: 0.4, gamma: 1.1 };
const TABLE_SIZE = 33;

/** `tableValues` d'un canal de la palette (0 = rouge, 1 = vert, 2 = bleu), échantillonnée régulièrement. */
function thermalTable(channel: 0 | 1 | 2, { black, white, gamma }: { black: number; white: number; gamma: number }): string {
  const values: string[] = [];
  for (let i = 0; i < TABLE_SIZE; i++) {
    const luminance = Math.min(1, Math.max(0, (i / (TABLE_SIZE - 1) - black) / (white - black))) ** gamma;
    let k = THERMAL_STOPS.findIndex(([stop]) => stop >= luminance);
    if (k < 1) k = 1;
    const [t0, ...c0] = THERMAL_STOPS[k - 1]!;
    const [t1, ...c1] = THERMAL_STOPS[k]!;
    const f = t1 > t0 ? (luminance - t0) / (t1 - t0) : 0;
    values.push((c0[channel]! + (c1[channel]! - c0[channel]!) * f).toFixed(3));
  }
  return values.join(' ');
}

/** Luminance (Rec. 709) recopiée dans les trois canaux. */
const LUMA = '0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0';

/** Les filtres SVG (`filter: url(#vision-…)` dans vision.css) : définis une fois, sans rien afficher. */
function VisionFilters() {
  const palettes = useMemo(
    () =>
      [
        ['vision-thermique', THERMAL_DAY],
        ['vision-thermique-nuit', THERMAL_NIGHT],
      ] as const,
    [],
  );
  return (
    <svg className="vision-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        {/* Vision nocturne : luminance seule, courbe qui relève les ombres (la carte de nuit reste lisible) sans écraser les hautes lumières du jour, vert phosphore. */}
        <filter id="vision-nocturne" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values={LUMA} />
          <feComponentTransfer>
            <feFuncR type="table" tableValues="0 0.05 0.1 0.11 0.12 0.14 0.17 0.22 0.3" />
            <feFuncG type="table" tableValues="0 0.16 0.34 0.38 0.42 0.5 0.62 0.8 1" />
            <feFuncB type="table" tableValues="0 0.03 0.07 0.08 0.09 0.1 0.12 0.16 0.22" />
          </feComponentTransfer>
        </filter>

        {/* Vision nocturne sur le fond de nuit : comme un intensificateur de lumière, la courbe amplifie fortement les
            basses lumières (le fond de nuit tient presque entier sous 35 % de luminance), sinon les bâtiments disparaissent. */}
        <filter id="vision-nocturne-nuit" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values={LUMA} />
          <feComponentTransfer>
            <feFuncR type="table" tableValues="0.01 0.12 0.21 0.26 0.28 0.3 0.3 0.3 0.3" />
            <feFuncG type="table" tableValues="0.03 0.42 0.72 0.88 0.95 1 1 1 1" />
            <feFuncB type="table" tableValues="0.01 0.09 0.16 0.19 0.2 0.22 0.22 0.22 0.22" />
          </feComponentTransfer>
        </filter>

        {/* Thermique : luminance puis palette par canal (tables ci-dessus), une version pour le fond de jour et une pour la nuit. */}
        {palettes.map(([id, range]) => (
          <filter key={id} id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
            <feColorMatrix type="matrix" values={LUMA} />
            <feComponentTransfer>
              <feFuncR type="table" tableValues={thermalTable(0, range)} />
              <feFuncG type="table" tableValues={thermalTable(1, range)} />
              <feFuncB type="table" tableValues={thermalTable(2, range)} />
            </feComponentTransfer>
          </filter>
        ))}

        {/* Écran cathodique : rouge et bleu décalés de part et d'autre du vert (aberration chromatique), teinte ambrée discrète. */}
        <filter id="vision-cathodique" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feColorMatrix in="SourceGraphic" type="matrix" values="1.08 0.08 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
          <feOffset in="r" dx="1.4" dy="0" result="r2" />
          <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0.04 1.02 0.04 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
          <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0.06 0.82 0 0  0 0 0 1 0" result="b" />
          <feOffset in="b" dx="-1.4" dy="0" result="b2" />
          <feBlend in="r2" in2="g" mode="screen" result="rg" />
          <feBlend in="rg" in2="b2" mode="screen" result="rgb" />
          <feComponentTransfer in="rgb">
            <feFuncR type="linear" slope="1.25" intercept="-0.16" />
            <feFuncG type="linear" slope="1.25" intercept="-0.16" />
            <feFuncB type="linear" slope="1.25" intercept="-0.16" />
          </feComponentTransfer>
        </filter>
      </defs>
    </svg>
  );
}

/** Surcouches (balayage, grain, vignettage) et définitions SVG, dans le conteneur du canevas : sous les commandes, sans pointeur. */
function VisionOverlay({ target }: { target: HTMLElement }) {
  return createPortal(
    <>
      <VisionFilters />
      <div className="vision-overlay" aria-hidden="true">
        <div className="vision-grain" />
        <div className="vision-scanlines" />
        <div className="vision-vignette" />
      </div>
    </>,
    target,
  );
}

function EyeIcon({ mode }: { mode: VisionMode }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" fill={mode === 'normal' ? 'none' : 'currentColor'} />
    </svg>
  );
}

function VisionMenu({ host }: { host: HTMLElement }) {
  const mode = useVision();
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  // Le raccourci V fait défiler les modes (sauf dans un champ de saisie, ou avec une touche de modification).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key !== 'v' && event.key !== 'V') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input:not([type="range"]), textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      const next = vision.cycle();
      setAnnouncement(`Mode de vision : ${VISION_LABELS[next].label}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Menu ouvert : le focus va au mode actuel ; un appui ailleurs le referme.
  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const choose = (next: VisionMode) => {
    vision.set(next);
    setAnnouncement(`Mode de vision : ${VISION_LABELS[next].label}`);
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault(); // l'Échap de l'application fermerait aussi la fiche
      close(true);
      return;
    }
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    // On part du choix qui a le focus (et non du mode : deux flèches de suite arrivent avant le rendu suivant).
    const radios = [...(rootRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
    const from = radios.indexOf(document.activeElement as HTMLElement);
    const i = (from < 0 ? VISION_MODES.indexOf(mode) : from + step + VISION_MODES.length) % VISION_MODES.length;
    radios[i]?.focus();
    choose(VISION_MODES[i]!);
  };

  return createPortal(
    <div ref={rootRef}>
      <div className="maplibregl-ctrl-group">
        <button
          ref={buttonRef}
          type="button"
          className={mode === 'normal' ? undefined : 'is-active'}
          title="Mode de vision (V)"
          aria-label={`Mode de vision : ${VISION_LABELS[mode].label}`}
          aria-haspopup="true"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <EyeIcon mode={mode} />
        </button>
      </div>
      {open && (
        <div className="vision-menu panel" role="radiogroup" aria-label="Mode de vision" onKeyDown={onMenuKeyDown}>
          {VISION_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              tabIndex={mode === m ? 0 : -1}
              className={`vision-menu__item${mode === m ? ' is-on' : ''}`}
              onClick={() => {
                choose(m);
                close(true);
              }}
            >
              <span className={`vision-menu__swatch vision-menu__swatch--${m}`} aria-hidden="true" />
              <span className="vision-menu__text">
                <span className="vision-menu__label">{VISION_LABELS[m].label}</span>
                <span className="vision-menu__hint">{VISION_LABELS[m].hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>,
    host,
  );
}

export function VisionControl({ manager }: { manager: ModuleManager }) {
  const map = useMap(manager);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [canvasContainer, setCanvasContainer] = useState<HTMLElement | null>(null);

  // Le fond de carte de nuit est bien plus sombre : le thermique choisit sa palette d'après `data-nuit` (vision.css).
  useEffect(() => {
    const refresh = () => {
      const night = vision.getSnapshot() !== 'normal' && currentNight() > 0.5;
      if (night) document.documentElement.dataset.nuit = '';
      else delete document.documentElement.dataset.nuit;
    };
    refresh();
    const timer = setInterval(refresh, 500);
    return () => {
      clearInterval(timer);
      delete document.documentElement.dataset.nuit;
    };
  }, []);

  useEffect(() => {
    if (!map) return;
    const control = new VisionHost();
    map.addControl(control, 'bottom-right');
    setHost(control.element);
    setCanvasContainer(map.getCanvasContainer());
    return () => {
      map.removeControl(control);
      setHost(null);
      setCanvasContainer(null);
    };
  }, [map]);

  return (
    <>
      {host && <VisionMenu host={host} />}
      {canvasContainer && <VisionOverlay target={canvasContainer} />}
    </>
  );
}
