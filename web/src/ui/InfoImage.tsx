import { useEffect, useState } from 'react';
import type { InfoImage } from '../core/module';
import { formatTime } from './format';

/** Adresse de l'image avec un paramètre qui change à chaque rechargement (le navigateur ne réutilise pas la précédente). */
function fresh(src: string, stamp: number): string {
  return `${src}${src.includes('?') ? '&' : '?'}_=${stamp}`;
}

/**
 * Image d'une webcam dans la fiche. Elle n'est jamais agrandie : sa largeur est celle de l'image, réduite
 * à celle de la fiche si elle est plus grande. Tant que la fiche est ouverte, elle est rechargée toutes les
 * `refreshMs` ; la nouvelle image est chargée à part et ne remplace l'ancienne qu'une fois arrivée (pas de
 * clignotement), et rien n'est rechargé quand l'onglet est caché.
 */
export function InfoImageView({ image }: { image: InfoImage }) {
  // `src` change quand on passe d'une caméra à l'autre : tout repart de zéro (clé du composant).
  const [shown, setShown] = useState<{ url: string; loadedAt: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const stamp = Date.now();
      const url = fresh(image.src, stamp);
      const probe = new Image();
      probe.onload = () => {
        if (cancelled) return;
        setShown({ url, loadedAt: stamp });
        setFailed(false);
      };
      probe.onerror = () => {
        if (!cancelled) setFailed(true);
      };
      probe.src = url;
    };
    load();
    if (!image.refreshMs) return () => void (cancelled = true);
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, image.refreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [image.src, image.refreshMs]);

  const time = image.time ?? shown?.loadedAt;
  const picture = shown && <img className="info__image-img" src={shown.url} alt={image.alt} decoding="async" referrerPolicy="no-referrer" />;
  return (
    <figure className="info__image">
      {shown ? (
        image.href ? (
          <a href={image.href} target="_blank" rel="noreferrer" title="Ouvrir la page de la webcam">
            {picture}
          </a>
        ) : (
          picture
        )
      ) : (
        <div className="info__image-wait" role="status">
          {failed ? 'Image indisponible pour le moment.' : 'Chargement de l’image…'}
        </div>
      )}
      <figcaption className="info__image-caption">
        {time !== undefined && shown && (
          <span>
            {image.time !== undefined ? 'Image de ' : 'Chargée à '}
            {formatTime(time)}
          </span>
        )}
        {failed && shown && <span>Rechargement impossible, dernière image conservée.</span>}
        {image.credit && <span>{image.credit}</span>}
      </figcaption>
    </figure>
  );
}
