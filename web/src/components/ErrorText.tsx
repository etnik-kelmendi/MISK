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

type FieldKey = keyof typeof en.fieldNames;

/** The name of a field the API refused, as people know it, or null for a field without one. */
export function fieldName(error: unknown): FieldKey | null {
  if (error instanceof ApiError && error.code === 'validation_failed' && error.field && Object.hasOwn(en.fieldNames, error.field)) {
    return error.field as FieldKey;
  }
  return null;
}

/** An inline error message for a failed action, announced to screen readers. */
export function ErrorText({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) {
    return null;
  }
  const field = fieldName(error);
  return (
    <p className="error-text" role="alert">
      {field ? t('errors.validation_field', { field: t(`fieldNames.${field}`) }) : t(`errors.${errorKey(error)}`)}
    </p>
  );
}
