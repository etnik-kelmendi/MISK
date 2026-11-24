import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../../api/ApiContext';
import { useResource } from '../../../api/useResource';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { ErrorText } from '../../../components/ErrorText';
import { Icon } from '../../../components/Icon';
import { ResourceState } from '../../../components/ResourceState';
import { Sheet } from '../../../components/Sheet';
import { useAction } from '../../../lib/useAction';
import { CardSetup } from '../../../payments/CardSetup';
import { brandBadge, brandName, type SavedCard } from '../../../payments/PaymentOptions';
import { AppHeader } from '../../../shells/Shells';

/** What `GET /account/cards` answers (D92). */
export interface CardList {
  cards: SavedCard[];
  defaultCardId: string | null;
  /** Cards that pay for a plan: they stay until another card is made the default. */
  planCardIds: string[];
  publishableKey: string | null;
}

/** "08/30" */
export function expiry(card: SavedCard): string {
  return `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`;
}

/** Adding a card: the provider's card form in a pop-up; nothing is charged. */
function AddCardSheet({ onSaved, onClose }: { onSaved: (cardId: string | null) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.post<{ clientSecret: string; publishableKey: string | null }>('/account/cards/setup'), [api]);
  const { state, reload } = useResource(load);
  return (
    <Sheet title={t('cards.addTitle')} closeLabel={t('common.close')} onClose={onClose}>
      <ResourceState state={state} reload={reload}>
        {(setup) =>
          setup.publishableKey ? (
            <CardSetup clientSecret={setup.clientSecret} publishableKey={setup.publishableKey} onSaved={onSaved} />
          ) : (
            <p className="error-text" role="alert">
              {t('errors.payment_unavailable')}
            </p>
          )
        }
      </ResourceState>
    </Sheet>
  );
}

/**
 * Payment methods (D92): the saved cards with their last 4 digits and expiry, the default one marked. Add a card,
 * make one the default (the plans then move to it too) and remove one, except a card paying for a plan.
 */
export function PaymentMethodsPage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<CardList>('/account/cards'), [api]);
  const { state, reload } = useResource(load);
  const action = useAction();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SavedCard | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const title = (card: SavedCard) => t('cards.card', { brand: brandName(card.brand), last4: card.last4 });

  async function run(work: () => Promise<unknown>, done: string) {
    setNotice(null);
    const ok = await action.run(async () => {
      await work();
      return true;
    });
    if (ok) {
      setNotice(done);
      reload();
    }
    return ok;
  }

  return (
    <>
      <AppHeader title={t('profile.payments')} back="/profile" />
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {(list) => (
            <>
              {list.cards.length === 0 ? (
                <p className="card small muted center-text">{t('cards.none')}</p>
              ) : (
                <ul className="stack tight" aria-label={t('cards.listLabel')}>
                  {list.cards.map((card) => {
                    const badge = brandBadge(card.brand);
                    const isDefault = card.id === list.defaultCardId;
                    const paysPlan = list.planCardIds.includes(card.id);
                    const hintId = `card-${card.id}-plan`;
                    return (
                      <li key={card.id} className="paym saved-card">
                        <span className="logo-b" style={{ background: badge.bg }} aria-hidden="true">
                          {badge.label}
                        </span>
                        <span className="grow">
                          <span className="b small block">{title(card)}</span>
                          <span className="tiny muted block">{t('cards.expires', { date: expiry(card) })}</span>
                          {paysPlan && (
                            <span id={hintId} className="tiny muted block">
                              {t('cards.paysPlan')}
                            </span>
                          )}
                        </span>
                        <span className="row gap4 wrap card-actions">
                          {isDefault ? (
                            <span className="badge g">{t('cards.default')}</span>
                          ) : (
                            <button
                              type="button"
                              className="mini-btn"
                              aria-label={t('cards.makeDefaultLabel', { card: title(card) })}
                              disabled={action.busy}
                              onClick={() =>
                                void run(() => api.post(`/account/cards/${card.id}/default`), t('cards.madeDefault', { card: title(card) }))
                              }
                            >
                              {t('cards.makeDefault')}
                            </button>
                          )}
                          <button
                            type="button"
                            className="mini-btn danger"
                            aria-label={t('cards.removeLabel', { card: title(card) })}
                            aria-describedby={paysPlan ? hintId : undefined}
                            disabled={action.busy || paysPlan}
                            onClick={(event) => {
                              opener.current = event.currentTarget;
                              setRemoving(card);
                            }}
                          >
                            {t('cards.remove')}
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {list.planCardIds.length > 0 && <p className="small muted">{t('cards.planHint')}</p>}
              <ErrorText error={action.error} />
              {notice && (
                <p className="small brand-text" role="status">
                  {notice}
                </p>
              )}
              <button
                type="button"
                className="cta ghost"
                aria-haspopup="dialog"
                onClick={() => {
                  setNotice(null);
                  setAdding(true);
                }}
              >
                <Icon name="plus" /> {t('cards.add')}
              </button>
              {adding && (
                <AddCardSheet
                  onClose={() => setAdding(false)}
                  onSaved={(cardId) => {
                    setAdding(false);
                    // The first card becomes the default straight away.
                    if (cardId && !list.defaultCardId) {
                      void run(() => api.post(`/account/cards/${cardId}/default`), t('cards.added'));
                    } else {
                      setNotice(t('cards.added'));
                      reload();
                    }
                  }}
                />
              )}
              {removing && (
                <ConfirmDialog
                  title={t('cards.removeTitle')}
                  cancelLabel={t('cards.keep')}
                  confirmLabel={t('cards.remove')}
                  busy={action.busy}
                  returnFocusTo={opener.current}
                  onCancel={() => setRemoving(null)}
                  onConfirm={() =>
                    void run(() => api.delete(`/account/cards/${removing.id}`), t('cards.removed', { card: title(removing) })).then(() =>
                      setRemoving(null),
                    )
                  }
                >
                  <p>{title(removing)}</p>
                </ConfirmDialog>
              )}
            </>
          )}
        </ResourceState>
        <div className="info">
          <Icon name="lock" />
          <p>{t('cards.safe')}</p>
        </div>
      </div>
    </>
  );
}
