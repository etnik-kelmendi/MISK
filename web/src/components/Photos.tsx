import { useId, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../api/ApiContext';
import { Icon } from './Icon';

export const IMAGE_TYPES = 'image/jpeg,image/png';
export const DOCUMENT_TYPES = 'image/jpeg,image/png,application/pdf';
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function PhotoGrid({ ids, label }: { ids: string[]; label: string }) {
  const api = useApi();
  if (!ids.length) {
    return null;
  }
  return (
    <ul className="photos" aria-label={label}>
      {ids.map((id, index) => (
        <li key={id} className="ph">
          <a href={api.fileUrl(id)} target="_blank" rel="noreferrer">
            <img src={api.fileUrl(id)} alt={`${label} ${index + 1}`} loading="lazy" />
          </a>
        </li>
      ))}
    </ul>
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
}: {
  label: string;
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
      </label>
      {tooBig && (
        <span className="error-text" role="alert">
          {t('errors.file_too_large')}
        </span>
      )}
    </span>
  );
}
