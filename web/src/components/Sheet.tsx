import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Icon } from './Icon';

/**
 * A pop-up that slides up from the bottom of the app (D67), closed with ×, Esc or a tap outside. Focus moves
 * into it on opening and back to whatever opened it on closing.
 */
export function Sheet({
  title,
  closeLabel,
  onClose,
  footer,
  bodyClassName,
  initialFocus,
  children,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  /** Buttons along the bottom edge. */
  footer?: ReactNode;
  /** Extra classes for the scrolling body, e.g. "flush" for a chat that brings its own spacing. */
  bodyClassName?: string;
  /** What gets the focus on opening, e.g. the chosen day of a calendar; the × button when left out. */
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  const firstFocus = useRef(initialFocus);
  useLayoutEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (firstFocus.current?.current ?? closeButton.current)?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') close.current();
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, []);

  return (
    <div
      className="sheet-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close.current();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <span className="sheet-grab" aria-hidden="true" />
        <div className="sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button ref={closeButton} type="button" className="iconbtn" aria-label={closeLabel} onClick={() => close.current()}>
            <Icon name="x" />
          </button>
        </div>
        <div className={`sheet-body ${bodyClassName ?? ''}`}>{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}
