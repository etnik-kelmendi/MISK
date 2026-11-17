import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
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
  children,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  /** Buttons along the bottom edge. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
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
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}
