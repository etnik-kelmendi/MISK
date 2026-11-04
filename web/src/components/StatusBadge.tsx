import { useTranslation } from 'react-i18next';
import type { BookingStatus } from '../api/types';

const TONE: Record<BookingStatus, string> = {
  awaiting_payment: 'grey',
  searching: 'b',
  unassigned: 'r',
  accepted: 'b',
  on_the_way: 'b',
  working: 'a',
  completed: 'g',
  cancelled: 'grey',
};

export function StatusBadge({ status }: { status: BookingStatus }) {
  const { t } = useTranslation();
  return <span className={`badge ${TONE[status]}`}>{t(`status.${status}`)}</span>;
}

export function Stars({ average, count }: { average: number | null; count: number }) {
  const { t } = useTranslation();
  if (average === null || count === 0) {
    return <span className="muted small">{t('common.newPro')}</span>;
  }
  return (
    <span className="stars" role="img" aria-label={t('common.ratingLabel', { average: average.toFixed(1), count })}>
      <span aria-hidden="true">★ {average.toFixed(1)}</span> <span className="muted small" aria-hidden="true">({count})</span>
    </span>
  );
}
