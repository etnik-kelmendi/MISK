import { useTranslation } from 'react-i18next';

/** Below these, a number is shown in red (the story's thresholds). */
export const LOW_ACCEPTANCE_PCT = 85;
export const LOW_ON_TIME_PCT = 90;

export function fullName(pro: { firstName: string | null; lastName: string | null }) {
  return [pro.firstName, pro.lastName].filter(Boolean).join(' ') || '–';
}

export function Pct({ value, low }: { value: number | null; low: number }) {
  const { t } = useTranslation();
  if (value === null) {
    return <span className="muted">{t('admin.pros.none')}</span>;
  }
  return <span className={value < low ? 'low' : undefined}>{t('admin.pros.pct', { value })}</span>;
}
