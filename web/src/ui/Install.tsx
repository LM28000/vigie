import { useState } from 'react';
import { applyUpdate, promptInstall, usePwa } from '../core/pwa';
import { Icon } from './icons';

/**
 * Entrée « Installer l'application » du catalogue : Chrome et Android ouvrent l'invite du navigateur ;
 * sur iPhone et iPad (pas d'invite) l'entrée déplie la marche à suivre. Rien quand l'application est
 * déjà installée, ou quand le navigateur ne sait pas installer (HTTP sur le réseau local, Firefox…).
 */
export function InstallEntry() {
  const { canInstall, iosHelp } = usePwa();
  const [helpOpen, setHelpOpen] = useState(false);
  if (!canInstall && !iosHelp) return null;
  return (
    <div className="install">
      <button
        type="button"
        className="install__button"
        aria-expanded={canInstall ? undefined : helpOpen}
        onClick={() => (canInstall ? void promptInstall() : setHelpOpen((open) => !open))}
        title="Ouvre Vigie dans sa propre fenêtre, depuis l'écran d'accueil ou le bureau"
      >
        <Icon name="installer" size={18} />
        <span className="install__text">
          <b>Installer l’application</b>
          <span>{canInstall ? 'Vigie en plein écran, comme une application' : 'Sur l’écran d’accueil de l’iPhone ou de l’iPad'}</span>
        </span>
      </button>
      {!canInstall && helpOpen && (
        <p className="install__help">
          Touchez le bouton <b>Partager</b> <Icon name="share" size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> de Safari, puis{' '}
          <b>Sur l’écran d’accueil</b>.
        </p>
      )}
    </div>
  );
}

/**
 * Avis discrets de l'application : une nouvelle version est prête (jamais de rechargement forcé en pleine
 * utilisation) et le téléphone n'a plus de réseau (la coque s'affiche, les données en direct ne se renouvellent plus).
 */
export function PwaNotices({ phone }: { phone: boolean }) {
  const { updateReady, offline } = usePwa();
  if (!updateReady && !offline) return null;
  return (
    <div className={`pwa-notices${phone ? ' pwa-notices--phone' : ''}`} role="region" aria-label="État de l’application" aria-live="polite">
      {offline && (
        <div className="pwa-notice panel" role="status">
          <span>Hors ligne : les données en direct ne se renouvellent plus.</span>
        </div>
      )}
      {updateReady && (
        <div className="pwa-notice panel" role="status">
          <span>Nouvelle version disponible.</span>
          <button type="button" className="pwa-notice__action" onClick={applyUpdate}>
            Recharger
          </button>
        </div>
      )}
    </div>
  );
}
