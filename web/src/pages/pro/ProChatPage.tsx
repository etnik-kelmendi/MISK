import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { ProJob } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ResourceState } from '../../components/ResourceState';
import { ChatNote, ChatView, type ChatEvent } from '../../chat/ChatView';
import { dateTime, euro } from '../../lib/format';
import { usePolling } from '../../lib/usePolling';
import { statusEvents } from '../customer/ChatPage';

/** The pro's side of the chat with the customer of a job (D67). */
export function ProChatPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const api = useApi();
  const { timezone } = useMarket();
  const load = useCallback(() => api.get<{ job: ProJob }>(`/pro/jobs/${encodeURIComponent(id)}`), [api, id]);
  const { state, reload } = useResource(load);
  usePolling(reload, 15_000, state.status === 'ready' && state.data.job.status !== 'completed' && state.data.job.status !== 'cancelled');

  return (
    <ResourceState state={state} reload={reload}>
      {({ job }) => {
        const name = job.customer.firstName ?? t('chat.yourCustomer');
        const events: ChatEvent[] = [
          ...statusEvents(job, 'pro', name, t),
          ...job.extras.map((extra) => ({
            key: `x-${extra.id}`,
            at: extra.createdAt,
            node: (
              <ChatNote>
                {t('chat.extraAsked', { description: extra.description, price: euro(extra.priceCents) })} · {t(`extra.status.${extra.status}`)}
              </ChatNote>
            ),
          })),
        ];
        return (
          <ChatView
            side="pro"
            path={`/pro/jobs/${encodeURIComponent(job.id)}/messages`}
            otherName={name}
            statusLine={t(`status.${job.status}`)}
            subtitle={`${job.serviceName} · ${dateTime(job.startsAt, timezone)}`}
            back={`/pro/jobs/${encodeURIComponent(job.id)}`}
            events={events}
            quickReplies={[t('chat.quick.onMyWay'), t('chat.quick.arrived'), t('chat.quick.done')]}
          />
        );
      }}
    </ResourceState>
  );
}
