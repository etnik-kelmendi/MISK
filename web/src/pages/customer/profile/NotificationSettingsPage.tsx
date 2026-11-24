import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../../api/ApiContext';
import { useResource } from '../../../api/useResource';
import { ErrorText } from '../../../components/ErrorText';
import { PushToggle } from '../../../components/PushToggle';
import { ResourceState } from '../../../components/ResourceState';
import { useAction } from '../../../lib/useAction';
import { AppHeader } from '../../../shells/Shells';

/** The switches, in the order shown (D92); the API keeps the same topics. */
export const TOPICS = ['booking_updates', 'pro_on_the_way', 'reminders', 'plan_changes', 'offers'] as const;
export type Topic = (typeof TOPICS)[number];
export type TopicSettings = Record<Topic, boolean>;

/**
 * Notifications (D92): on/off switches for booking updates, pro on the way, reminders, plan changes and offers.
 * A switched-off topic still shows in Messages; payments and safety messages always go out.
 */
export function NotificationSettingsPage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ topics: TopicSettings }>('/account/notifications'), [api]);
  const { state, reload } = useResource(load);
  const action = useAction();
  // The latest saved switches, once one was changed on this page.
  const [saved, setSaved] = useState<TopicSettings | null>(null);

  async function toggle(topic: Topic, on: boolean) {
    const result = await action.run(() => api.patch<{ topics: TopicSettings }>('/account/notifications', { [topic]: on }));
    if (result) setSaved(result.topics);
  }

  return (
    <>
      <AppHeader title={t('profile.notifications')} back="/profile" />
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {(loaded) => {
            const topics = saved ?? loaded.topics;
            return (
              <ul className="lgroup plist" aria-label={t('notify.listLabel')}>
                {TOPICS.map((topic) => (
                  <li key={topic} className="lrow">
                    <span className="grow">
                      <span id={`topic-${topic}`} className="block">
                        {t(`notify.topics.${topic}.title`)}
                      </span>
                      <span id={`topic-${topic}-text`} className="tiny muted block topic-text">
                        {t(`notify.topics.${topic}.text`)}
                      </span>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={topics[topic]}
                      aria-labelledby={`topic-${topic}`}
                      aria-describedby={`topic-${topic}-text`}
                      className={`toggle ${topics[topic] ? 'on' : ''}`}
                      disabled={action.busy}
                      onClick={() => void toggle(topic, !topics[topic])}
                    />
                  </li>
                ))}
              </ul>
            );
          }}
        </ResourceState>
        <ErrorText error={action.error} />
        <p className="tiny muted">{t('notify.always')}</p>
        <p className="tiny muted">{t('notify.inApp')}</p>
        <h2 className="h-sm">{t('notify.device')}</h2>
        <div className="card">
          <PushToggle />
        </div>
      </div>
    </>
  );
}
