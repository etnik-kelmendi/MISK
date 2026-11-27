import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { Icon } from '../components/Icon';
import { isTeamMessage, messageText, useInbox } from './InboxContext';

/** How long the banner takes to slide back under the header when closed; matches `nm-out` in index.css. */
const EXIT_MS = 220;

/** True when the banner should appear and go without moving: the person turned motion off, or no browser styles. */
function withoutMotion(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The banner itself, mounted only while there is a message to announce. */
function Banner({ messagesPath }: { messagesPath: string }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { fresh, dismissFresh } = useInbox();
  const layer = useRef<HTMLDivElement>(null);
  // Closing slides the banner back under the header first, then removes it (D108).
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!leaving) return;
    // In case the animation end never comes (a background tab, styles not loaded), the banner still goes.
    const timer = window.setTimeout(dismissFresh, EXIT_MS + 80);
    return () => window.clearTimeout(timer);
  }, [leaving, dismissFresh]);
  const close = () => {
    if (withoutMotion()) dismissFresh();
    else setLeaving(true);
  };
  // Keeps the banner flush below the page's header as an overlay, so it never pushes the page down; once the
  // header has scrolled away it stays at the top of the screen. The position is written straight to the
  // element's transform, at most once per frame, so scrolling never re-renders React, and the listeners only
  // exist while a banner shows.
  useLayoutEffect(() => {
    const element = layer.current;
    if (!element) return;
    // The header of the page shown, the first in the app's main area; a page without one puts the banner on top.
    const main = element.closest('main');
    const findHeader = () => main?.querySelector('header') ?? null;
    let header = findHeader();
    let frame = 0;
    // A header that grows or shrinks (a wrapped title, a status loading in) moves the banner with it.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
    if (header) observer?.observe(header);
    const place = () => {
      frame = 0;
      // A page that drew its header after the banner (still loading) gets it found on the next move.
      if (!header?.isConnected) {
        header = findHeader();
        if (header) observer?.observe(header);
      }
      const bottom = Math.max(header ? header.getBoundingClientRect().bottom : 0, 0);
      // Flush with the header's bottom edge (D108). A transform moves it on the compositor, without a layout.
      element.style.transform = `translate(-50%, ${Math.round(bottom)}px)`;
      // With the header scrolled away it meets the top of the screen, below a phone's status bar.
      element.classList.toggle('at-top', bottom === 0);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
    // Another page has another header.
  }, [layer, pathname]);
  const newest = fresh[0];
  if (!newest) return null;
  return (
    <div ref={layer} className="new-message-layer">
      <div
        className={`new-message ${leaving ? 'leaving' : ''}`}
        role="status"
        aria-live="polite"
        onAnimationEnd={(event) => {
          if (leaving && event.animationName === 'nm-out') dismissFresh();
        }}
      >
        <Icon name="bell" />
        <div className="grow">
          {/* A message the team wrote is named as such, so it is not mistaken for an automatic one (D87). */}
          <p className="b small">{isTeamMessage(newest) ? t('inbox.newFromTeam') : t('inbox.newTitle')}</p>
          <p className="small pre-line">{messageText(newest)}</p>
          {fresh.length > 1 && <p className="tiny muted">{t('inbox.more', { count: fresh.length - 1 })}</p>}
          <Link to={messagesPath} className="small b">
            {t('inbox.open')}
          </Link>
        </div>
        <button type="button" className="iconbtn" aria-label={t('inbox.dismiss')} onClick={close} disabled={leaving}>
          <Icon name="x" />
        </button>
      </div>
    </div>
  );
}

/**
 * Announces a message that just arrived, such as a job the team gave the pro or a cancelled job, as an overlay
 * below the header of every screen until it is opened or closed, without moving the page. Hidden on the
 * Messages page, which shows it anyway.
 */
export function NewMessageBanner({ messagesPath }: { messagesPath: string }) {
  const { pathname } = useLocation();
  const { fresh } = useInbox();
  if (fresh.length === 0 || pathname === messagesPath) return null;
  return <Banner messagesPath={messagesPath} />;
}
