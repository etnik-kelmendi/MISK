import type { TFunction } from 'i18next';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { BookingBase, CustomerBooking } from '../../api/types';
import { useResource } from '../../api/useResource';
import { Icon } from '../../components/Icon';
import { ResourceState } from '../../components/ResourceState';
import { ChatNote, ChatView, type ChatEvent } from '../../chat/ChatView';
import { dateTime } from '../../lib/format';
import { usePolling } from '../../lib/usePolling';
import { ExtraCard, LIVE, proName } from './BookingPage';

/** Booking steps that show up in the conversation. */
const NOTED = new Set(['accepted', 'on_the_way', 'working', 'completed']);

/** The booking's status changes as notes in the conversation, written for the customer or the pro. */
export function statusEvents(booking: BookingBase, side: 'customer' | 'pro', name: string, t: TFunction): ChatEvent[] {
  return booking.events
    .filter((event) => NOTED.has(event.status))
    .map((event) => ({
      key: `e-${event.status}-${event.at}`,
      at: event.at,
      node: <ChatNote>{t(`chat.events.${side}.${event.status as 'accepted'}`, { name })}</ChatNote>,
    }));
}

/** Chat with the pro of a booking (D67), with extra work requests to approve right in the conversation. */
export function ChatPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const api = useApi();
  const { timezone } = useMarket();
  const load = useCallback(() => api.get<{ booking: CustomerBooking }>(`/bookings/${encodeURIComponent(id)}`), [api, id]);
  const { state, reload, update } = useResource(load);
  // Extra work requests and status changes arrive with the booking.
  usePolling(reload, 15_000, state.status === 'ready' && LIVE.has(state.data.booking.status));

  return (
    <ResourceState state={state} reload={reload}>
      {({ booking }) => {
        const name = proName(booking, t('problem.yourPro'));
        const events: ChatEvent[] = [
          ...statusEvents(booking, 'customer', name, t),
          ...booking.extras.map((extra) => ({
            key: `x-${extra.id}`,
            at: extra.createdAt,
            node: <ExtraCard booking={booking} extra={extra} onChanged={(next) => update(() => ({ booking: next }))} />,
          })),
        ];
        return (
          <ChatView
            side="customer"
            path={`/bookings/${encodeURIComponent(booking.id)}/messages`}
            otherName={name}
            statusLine={t(`chat.status.${booking.status}`, { name })}
            subtitle={`${booking.serviceName} · ${dateTime(booking.startsAt, timezone)}`}
            back={`/bookings/${encodeURIComponent(booking.id)}`}
            events={events}
            quickReplies={[t('chat.quick.thanks'), t('chat.quick.home'), t('chat.quick.gate')]}
            closedFooter={
              (booking.canRate || booking.canTip) && (
                <Link to={`/bookings/${encodeURIComponent(booking.id)}/rate`} className="cta">
                  <Icon name="star" /> {booking.canRate ? t('booking.rate', { name }) : t('booking.addTip', { name })}
                </Link>
              )
            }
          />
        );
      }}
    </ResourceState>
  );
}
