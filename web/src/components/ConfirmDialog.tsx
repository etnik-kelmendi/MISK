import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A centred confirmation pop-up with two buttons. Focus moves into it (to the cancel button, the safe
 * choice), stays inside while it is open, and goes back to `returnFocusTo` when it closes. Esc and the
 * cancel button close it, and Esc does not reach panels underneath, such as the booking drawer.
 */
export function ConfirmDialog({
  title,
  cancelLabel,
  confirmLabel,
  busy = false,
  returnFocusTo,
  onCancel,
  onConfirm,
  children,
}: {
  title: string;
  cancelLabel: string;
  confirmLabel: string;
  /** While the request is on its way both buttons are off and Esc does nothing. */
  busy?: boolean;
  /** What had the focus when the pop-up was opened. */
  returnFocusTo: HTMLElement | null;
  onCancel: () => void;
  onConfirm: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const latest = useRef({ onCancel, busy });
  useLayoutEffect(() => {
    latest.current = { onCancel, busy };
  }, [onCancel, busy]);

  useEffect(() => {
    cancelButton.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        // Before anything else listening on the page, so the panel underneath stays open.
        event.stopPropagation();
        event.preventDefault();
        if (!latest.current.busy) latest.current.onCancel();
        return;
      }
      if (event.key !== 'Tab' || !root.current) return;
      const items = Array.from(root.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (!root.current.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);

  useEffect(
    () => () => {
      if (returnFocusTo?.isConnected) returnFocusTo.focus();
    },
    [returnFocusTo],
  );

  return createPortal(
    <div className="modal-backdrop" role="presentation">
      <div ref={root} className="modal stack" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        {children}
        <div className="row gap8 modal-actions">
          <button ref={cancelButton} type="button" className="abtn ghost" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="abtn" disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
