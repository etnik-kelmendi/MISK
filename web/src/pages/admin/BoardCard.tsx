import type { TFunction } from 'i18next';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { AdminBookingListItem, AdminListAlert } from '../../api/types';
import { dateTime } from '../../lib/format';

/** Most alert lines a card shows; the rest become "+N more". */
export const MAX_CARD_ALERTS = 2;

/** "1 h 30 min", "45 min" */
function duration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function alertText(t: TFunction, alert: AdminListAlert): string {
  const params = alert.params ?? {};
  switch (alert.key) {
    case 'issue':
      return t('admin.bookings.alert.issue', { reason: t(`issue.reasons.${String(params.reason)}`, { defaultValue: String(params.reason) }) });
    case 'problemWithReason':
      return t('admin.bookings.alert.problemWithReason', { reason: String(params.reason ?? '') });
    case 'searching':
      return t('admin.bookings.alert.searching', { time: duration(Number(params.minutes ?? 0)) });
    default:
      return t(`admin.bookings.alert.${alert.key}`);
  }
}

/**
 * One compact board card (D96): number, service, the problems in red and the warnings in orange,
 * and at the bottom the date and time with the pro's initials. The whole card opens the booking.
 */
export function BoardCard({
  item,
  timezone,
  onOpen,
}: {
  item: AdminBookingListItem;
  timezone: string;
  onOpen: (item: AdminBookingListItem, from: HTMLElement) => void;
}) {
  const { t } = useTranslation();
  const when = dateTime(item.startsAt, timezone);
  const alerts = item.alerts ?? [];
  const shown = alerts.slice(0, MAX_CARD_ALERTS);
  const hidden = alerts.length - shown.length;
  // The label names the booking; the warnings and the pro are its description, so screen readers hear them too.
  const id = useId();
  const alertsId = `${id}-alerts`;
  const proId = `${id}-pro`;
  const proLabel = item.pro ? t('admin.bookings.card.pro', { name: item.pro }) : t('admin.bookings.card.noPro');
  return (
    <button
      type="button"
      className="kcard"
      aria-label={t('admin.bookings.card.name', { number: item.number, service: item.service, when: when.replace(', ', ' ') })}
      aria-describedby={alerts.length > 0 ? `${alertsId} ${proId}` : proId}
      onClick={(event) => onOpen(item, event.currentTarget)}
    >
      <span className="kno">{item.number}</span>
      <span className="ksvc">{item.service}</span>
      {alerts.length > 0 && (
        <span id={alertsId} className="kalerts">
          {shown.map((alert) => {
            const text = alertText(t, alert);
            return (
              <span
                key={`${alert.key}-${String(alert.params?.reason ?? '')}`}
                className={`kalert ${alert.level === 'problem' ? 'red' : 'orange'}`}
                // Long lines are cut to two; the whole text shows on hover.
                title={text}
              >
                {text}
              </span>
            );
          })}
          {hidden > 0 && <span className="kmore">{t('admin.bookings.card.more', { count: hidden })}</span>}
        </span>
      )}
      <span className="kfoot">
        <span className="kwhen">{when.replace(', ', ' · ')}</span>
        {item.pro ? (
          <span id={proId} className="kav" role="img" aria-label={proLabel} title={proLabel}>
            {item.proInitials || item.pro.slice(0, 2).toUpperCase()}
          </span>
        ) : (
          <span id={proId} className="kav empty" role="img" aria-label={proLabel} title={proLabel} />
        )}
      </span>
    </button>
  );
}
