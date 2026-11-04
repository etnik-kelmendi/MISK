import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client';
import en from '../i18n/locales/en.json';

type ErrorKey = keyof typeof en.errors;

function isErrorKey(code: string): code is ErrorKey {
  return Object.hasOwn(en.errors, code);
}

/** The translation key for a failed action: the API's code when known, otherwise a general message. */
export function errorKey(error: unknown): ErrorKey {
  if (error instanceof ApiError && error.code && isErrorKey(error.code)) {
    return error.code;
  }
  if (error instanceof ApiError && error.status === 401) {
    return 'unauthenticated';
  }
  return error instanceof ApiError ? 'generic' : 'network';
}

/** An inline error message for a failed action, announced to screen readers. */
export function ErrorText({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) {
    return null;
  }
  return (
    <p className="error-text" role="alert">
      {t(`errors.${errorKey(error)}`)}
    </p>
  );
}
