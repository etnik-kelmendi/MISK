import { useEffect, useId, useRef, useState, type ChangeEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../api/ApiContext';
import { Icon } from './Icon';

export const IMAGE_TYPES = 'image/jpeg,image/png';
export const DOCUMENT_TYPES = 'image/jpeg,image/png,application/pdf';
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** A horizontal swipe at least this long (in CSS pixels) moves to the next or previous photo. */
export const SWIPE_PX = 50;
/** The empty alt text of a picture that only repeats what the text next to it says. */
const DECORATIVE = '';

/**
 * A full-screen photo viewer (D83): previous and next with the buttons, the arrow keys or a swipe; closes
 * with ×, Esc or a tap outside the photo. Focus stays inside while it is open; the caller puts it back.
 */
export function Lightbox({
  ids,
  index,
  label,
  onIndex,
  onClose,
}: {
  ids: string[];
  index: number;
  /** What the photos are, e.g. "Photos from your pro". */
  label: string;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const id = ids[index];
  const hasPrevious = index > 0;
  const hasNext = index < ids.length - 1;
  const counter = t('photos.counter', { n: index + 1, total: ids.length });

  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  // Esc and the arrow keys work wherever the focus is while the viewer is open.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Tab') {
        // Keeps the keyboard inside the viewer.
        const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      } else if (step !== 0) {
        event.preventDefault();
        const next = index + step;
        if (next >= 0 && next < ids.length) onIndex(next);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, ids.length, onClose, onIndex]);

  function go(step: -1 | 1) {
    const next = index + step;
    if (next >= 0 && next < ids.length) onIndex(next);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    swipeStart.current = { x: event.clientX, y: event.clientY };
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
      go(dx < 0 ? 1 : -1);
    }
  }

  if (!id) return null;
  return (
    <div
      ref={dialog}
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={counter}
    >
      <button ref={closeButton} type="button" className="iconbtn lightbox-close" aria-label={t('photos.close')} onClick={onClose}>
        <Icon name="x" />
      </button>
      <div
        className="lightbox-stage"
        role="presentation"
        data-testid="lightbox-stage"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          swipeStart.current = null;
        }}
        // A tap on the dark area around the photo closes it.
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <img src={api.fileUrl(id)} alt={`${label} ${index + 1}`} draggable={false} />
      </div>
      <p className="lightbox-count" aria-hidden="true">
        {counter}
      </p>
      {ids.length > 1 && (
        <>
          <button
            type="button"
            className="iconbtn lightbox-nav prev"
            aria-label={t('photos.previous')}
            // Not disabled, so the focus stays on it at the first photo.
            aria-disabled={!hasPrevious}
            onClick={() => go(-1)}
          >
            <Icon name="chevL" />
          </button>
          <button type="button" className="iconbtn lightbox-nav next" aria-label={t('photos.next')} aria-disabled={!hasNext} onClick={() => go(1)}>
            <Icon name="chevR" />
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Opens a lightbox over a set of photos and gives focus back to the thumbnail that opened it (D83).
 * `register` gives each thumbnail button its ref.
 */
export function useLightbox(ids: string[], label: string) {
  const [open, setOpen] = useState<{ from: number; index: number } | null>(null);
  const thumbs = useRef(new Map<number, HTMLButtonElement>());
  const close = () => {
    const from = open?.from;
    setOpen(null);
    if (from !== undefined) {
      // After the viewer is gone from the page.
      requestAnimationFrame(() => thumbs.current.get(from)?.focus());
    }
  };
  return {
    openAt: (index: number) => setOpen({ from: index, index }),
    register: (index: number) => (element: HTMLButtonElement | null) => {
      if (element) thumbs.current.set(index, element);
      else thumbs.current.delete(index);
    },
    viewer: open ? (
      <Lightbox ids={ids} index={open.index} label={label} onIndex={(index) => setOpen({ ...open, index })} onClose={close} />
    ) : null,
  };
}

export function PhotoGrid({ ids, label }: { ids: string[]; label: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const lightbox = useLightbox(ids, label);
  if (!ids.length) {
    return null;
  }
  return (
    <>
      <ul className="photos" aria-label={label}>
        {ids.map((id, index) => (
          <li key={id} className="ph">
            <button
              ref={lightbox.register(index)}
              type="button"
              className="ph-open"
              aria-label={t('photos.open', { n: index + 1, total: ids.length })}
              onClick={() => lightbox.openAt(index)}
            >
              <img src={api.fileUrl(id)} alt={`${label} ${index + 1}`} loading="lazy" />
            </button>
          </li>
        ))}
      </ul>
      {lightbox.viewer}
    </>
  );
}

/**
 * A round picture of a person: their photo when there is one, else the first letter of their name. A photo
 * that cannot be loaded falls back to the letter too (D83).
 */
export function Avatar({ name, photoId, size }: { name: string; photoId?: string | null; size?: 'sm' | 'lg' }) {
  const api = useApi();
  const [failed, setFailed] = useState<string | null>(null);
  const showPhoto = Boolean(photoId) && failed !== photoId;
  return (
    <span className={`av ${size ? `av-${size}` : ''} ${showPhoto ? 'av-photo' : ''}`} aria-hidden="true">
      {showPhoto && photoId ? (
        <img src={api.fileUrl(photoId)} alt={DECORATIVE} onError={() => setFailed(photoId)} />
      ) : (
        (name.trim().slice(0, 1) || '?').toUpperCase()
      )}
    </span>
  );
}

/**
 * A button that opens the file picker. Files over 8 MB are refused here already, so nobody waits for an
 * upload the API would refuse anyway.
 */
export function FileButton({
  label,
  accept,
  onFile,
  disabled,
  className = 'mini-btn',
  icon = 'upload',
  target,
}: {
  label: string;
  /** What the file is for, read out after the label, e.g. "Upload" + "Liability insurance". */
  target?: string;
  accept: string;
  onFile: (file: File) => Promise<void>;
  disabled?: boolean;
  className?: string;
  icon?: 'upload' | 'camera';
}) {
  const { t } = useTranslation();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [tooBig, setTooBig] = useState(false);

  async function onChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    setTooBig(file.size > MAX_FILE_BYTES);
    if (file.size > MAX_FILE_BYTES) {
      return;
    }
    setBusy(true);
    try {
      await onFile(file);
    } catch (error) {
      // Callers show their own error; this only keeps a missed one from going unhandled.
      console.error('Upload failed', error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="file-button">
      <input id={id} type="file" accept={accept} className="visually-hidden" onChange={onChange} disabled={disabled || busy} />
      <label htmlFor={id} className={`${className} ${disabled || busy ? 'disabled' : ''}`}>
        <Icon name={icon} /> {busy ? t('common.uploading') : label}
        {target && <span className="visually-hidden"> {target}</span>}
      </label>
      {tooBig && (
        <span className="error-text" role="alert">
          {t('errors.file_too_large')}
        </span>
      )}
    </span>
  );
}
