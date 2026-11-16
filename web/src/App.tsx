import { useCallback, useEffect, useState } from 'react';
import { clock } from './core/clock';
import { ModuleManager } from './core/moduleManager';
import { applySharedState, clearTourFlag, hasSharedState, hasTourFlag, startSharedStateSync } from './core/shareState';
import { synthese, useSyntheseOpen } from './core/synthese';
import { tour } from './core/tour';
import { MapView } from './map/MapView';
import { MODULES } from './modules';
import { SearchBox } from './search/SearchBox';
import { InfoPanel } from './ui/InfoPanel';
import { LayerChips } from './ui/LayerChips';
import { LayerDrawer } from './ui/LayerDrawer';
import { MobileSheet, type Snap } from './ui/MobileSheet';
import { SyntheseView } from './ui/Synthese';
import { TimeBar } from './ui/TimeBar';
import { VisionControl } from './ui/VisionControl';
import { ZoneTool } from './ui/ZoneTool';
import { TourPanel, useTour } from './ui/Tour';
import { Welcome, shouldShowWelcome } from './ui/Welcome';
import { PHONE_QUERY, useMediaQuery } from './ui/hooks';

/** Un seul gestionnaire pour toute l'application : il survit aux remontages de React. */
const manager = new ModuleManager(MODULES);
/** L'adresse prime sur les préférences du navigateur : elle est appliquée avant le premier affichage. */
const openedFromSharedLink = hasSharedState();
applySharedState(manager);
/** Calculé une fois : le drapeau de première visite est posé ici, le double rendu de React ne doit pas l'annuler. */
/** `#visite` : le lien lance la visite guidée (et l'accueil de la première visite lui cède la place). */
let tourAtLaunch = hasTourFlag();
const showWelcomeAtStart = shouldShowWelcome(openedFromSharedLink || tourAtLaunch);

const HOUR = 3_600_000;

export function App() {
  const phone = useMediaQuery(PHONE_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const todayOpen = useSyntheseOpen();
  // Une adresse `#synthese=1` rouvre la synthèse : sur téléphone, la feuille démarre à moitié ouverte pour la montrer.
  const [snap, setSnap] = useState<Snap>(() => (phone && synthese.getSnapshot() ? 'half' : 'peek'));
  const [welcome, setWelcome] = useState(showWelcomeAtStart);

  useEffect(() => startSharedStateSync(manager), []);

  const tourState = useTour();
  // Lien `#visite` : le drapeau est retiré tout de suite (recharger ne relance pas la visite), la visite attend la carte.
  useEffect(() => {
    if (!tourAtLaunch) return;
    tourAtLaunch = false;
    clearTourFlag();
    void tour.start(manager);
  }, []);
  // La visite prend la place : accueil, catalogue et feuille se referment.
  useEffect(() => {
    if (!tourState.active) return;
    setWelcome(false);
    setDrawerOpen(false);
    setSnap('peek');
    synthese.set(false);
  }, [tourState.active]);

  // Sur téléphone la synthèse vit dans la feuille : feuille réduite, synthèse fermée (l'adresse ne la dirait pas ouverte pour rien).
  useEffect(() => {
    if (phone && snap === 'peek') synthese.set(false);
  }, [phone, snap]);

  /** « Couches » : le tiroir sur ordinateur, la moitié de la feuille sur téléphone. */
  const openLayers = useCallback(
    (layerId?: string) => {
      if (layerId) setExpandedId(layerId);
      synthese.set(false);
      if (phone) setSnap((current) => (current === 'peek' ? 'half' : current));
      else setDrawerOpen(true);
    },
    [phone],
  );
  const toggleLayers = useCallback(() => {
    synthese.set(false);
    if (phone) setSnap((current) => (current === 'peek' ? 'half' : 'peek'));
    else setDrawerOpen((open) => !open);
  }, [phone]);
  /** « Aujourd'hui » : un panneau à la place du catalogue sur ordinateur, un onglet de la feuille sur téléphone. */
  const toggleToday = useCallback(() => {
    if (synthese.getSnapshot() && !(phone && snap === 'peek')) return synthese.set(false);
    synthese.set(true);
    setDrawerOpen(false);
    if (phone) setSnap((current) => (current === 'peek' ? 'half' : current));
  }, [phone, snap]);

  useShortcuts({
    toggleLayers,
    toggleToday,
    // Échap ferme ce qui est ouvert, du plus récent au plus ancien : accueil, couches, fiche.
    close: () => {
      if (tour.isActive()) return tour.quit();
      if (welcome) return setWelcome(false);
      if (phone && snap !== 'peek') return setSnap(snap === 'full' ? 'half' : 'peek');
      if (!phone && todayOpen) return synthese.set(false);
      if (!phone && drawerOpen) return setDrawerOpen(false);
      manager.setSelection(null, null);
    },
  });

  // Toucher la carte referme ce qui la recouvre (« tout s'ouvre à la demande et se referme seul »).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.map') || target.closest('.maplibregl-ctrl')) return;
      setDrawerOpen(false);
      setSnap((current) => (current === 'peek' ? current : 'peek'));
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, []);

  return (
    <div className="app" data-sheet={phone ? snap : undefined}>
      <MapView manager={manager} />

      <div className="zone-tl">
        <div className="zone-tl__search">
          <SearchBox manager={manager} />
        </div>
        <LayerChips
          manager={manager}
          onOpenLayer={(id) => openLayers(id)}
          onOpenCatalog={phone ? toggleLayers : () => (drawerOpen ? setDrawerOpen(false) : openLayers())}
          catalogOpen={phone ? snap !== 'peek' : drawerOpen}
          onToggleToday={phone ? undefined : toggleToday}
          todayOpen={todayOpen}
        />
        {!phone && todayOpen && (
          <aside className="panel drawer today-panel" aria-label="Aujourd’hui en France">
            <SyntheseView manager={manager} phone={false} onPicked={() => undefined} onClose={() => synthese.set(false)} />
          </aside>
        )}
        {!phone && drawerOpen && !todayOpen && (
          <LayerDrawer manager={manager} expandedId={expandedId} onExpand={setExpandedId} onClose={() => setDrawerOpen(false)} />
        )}
      </div>

      {phone && tourState.active ? (
        <TourPanel manager={manager} phone />
      ) : phone ? (
        <MobileSheet
          manager={manager}
          snap={snap}
          onSnap={setSnap}
          expandedId={expandedId}
          onExpand={setExpandedId}
          todayOpen={todayOpen}
          onToday={(open) => synthese.set(open)}
          onTodayPicked={() => setSnap('peek')}
        />
      ) : (
        <>
          <InfoPanel manager={manager} />
          <TimeBar />
          {tourState.active && <TourPanel manager={manager} phone={false} />}
        </>
      )}

      <ZoneTool manager={manager} phone={phone} />
      <VisionControl manager={manager} />

      {welcome && <Welcome manager={manager} onClose={() => setWelcome(false)} />}
    </div>
  );
}

/**
 * Raccourcis : Espace lecture/pause · ← → −1 h/+1 h · L couches · A aujourd'hui en France · Échap fermer. Pendant la visite guidée : Espace pause, ← → étape, Échap quitte.
 * (⌘K et / appartiennent à la recherche ; V, les modes de vision, est géré par `ui/VisionControl.tsx`.) Ils n'agissent pas quand un champ de saisie a le focus.
 */
function useShortcuts({ toggleLayers, toggleToday, close }: { toggleLayers: () => void; toggleToday: () => void; close: () => void }) {
  useEffect(() => {
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement && !!target.closest('input:not([type="range"]), textarea, select, [contenteditable="true"]');
    const plain = (event: KeyboardEvent) => !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;

    // Les flèches sont prises avant MapLibre, qui s'en sert pour déplacer la carte quand elle a le focus.
    const onArrow = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.target as HTMLElement | null;
      if (!plain(event) || typing(event.target) || target?.matches('input[type="range"], [role="radio"], [role="tab"]')) return;
      event.preventDefault();
      event.stopPropagation();
      // Pendant la visite, les flèches changent d'étape (la frise reste à la souris).
      if (tour.isActive()) {
        if (event.key === 'ArrowRight') tour.next();
        else tour.prev();
        return;
      }
      clock.seek(clock.now() + (event.key === 'ArrowRight' ? HOUR : -HOUR));
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !plain(event) || typing(event.target)) return;
      const target = event.target as HTMLElement | null;
      if (event.key === 'Escape') {
        close();
      } else if (event.code === 'Space') {
        // Sur un bouton atteint au clavier, Espace l'active comme d'habitude ; après un clic à la souris, il lit ou met en pause.
        if (target?.matches('button:focus-visible, a:focus-visible, summary:focus-visible')) return;
        event.preventDefault();
        if (tour.isActive()) tour.toggle();
        else clock.toggle();
      } else if (event.key === 'l' || event.key === 'L') {
        event.preventDefault(); // sinon la lettre atterrit dans le filtre qui prend le focus à l'ouverture
        toggleLayers();
      } else if (event.key === 'a' || event.key === 'A') {
        event.preventDefault();
        toggleToday();
      }
    };

    window.addEventListener('keydown', onArrow, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onArrow, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [toggleLayers, toggleToday, close]);
}
