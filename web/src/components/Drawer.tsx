import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

/** A side panel over the list, closed with ×, Esc or a click outside. */
export function Drawer({
  title,
  closeLabel,
  onClose,
  children,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="row between drawer-head">
          <h2 id={titleId}>{title}</h2>
          <button ref={closeButton} type="button" className="icon-btn" aria-label={closeLabel} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-body stack">{children}</div>
      </div>
    </div>
  );
}
