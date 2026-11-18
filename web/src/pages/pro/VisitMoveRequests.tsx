import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { ProVisitMove } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { dateTime } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { usePolling } from '../../lib/usePolling';

/** One customer's request to move a plan visit to another day of the same week (D77). */
function MoveCard({ move, onAnswered }: { move: ProVisitMove; onAnswered: (moves: ProVisitMove[]) => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const { timezone } = useMarket();
  const { run, busy, error } = useAction();

  async function answer(action: 'accept' | 'decline') {
    const result = await run(() => api.post<{ moves: ProVisitMove[] }>(`/pro/visit-moves/${move.id}/${action}`));
    if (result) onAnswered(result.moves);
  }

  const notFree = error instanceof ApiError && error.code === 'pro_not_free';
  return (
    <article className="req" aria-labelledby={`move-${move.id}`}>
      <div className="req-body">
        <p id={`move-${move.id}`} className="b">
          {t('visitMove.asks', {
            customer: move.customerName ?? t('visitMove.customer'),
            plan: move.planName,
            from: dateTime(move.fromStartsAt, timezone),
            to: dateTime(move.toStartsAt, timezone),
          })}
        </p>
        <p className="small muted row gap4">
          <Icon name="pin" /> {t('visitMove.where', { address: move.address, postcode: move.postcode })}
        </p>
        <p className="small muted row gap4">
          <Icon name="clock" /> {t('visitMove.answerBy', { date: dateTime(move.respondBy, timezone) })}
        </p>
        {notFree ? (
          <p className="error-text" role="alert">
            {t('visitMove.notFree')}
          </p>
        ) : (
          <ErrorText error={error} />
        )}
        <div className="row gap8">
          <button type="button" className="btn2 no" disabled={busy} onClick={() => void answer('decline')}>
            {t('visitMove.decline')}
          </button>
          <button type="button" className="btn2 yes" disabled={busy || notFree} onClick={() => void answer('accept')}>
            {t('visitMove.accept')}
          </button>
        </div>
      </div>
    </article>
  );
}

/**
 * The move requests waiting for this pro, shown above their upcoming work. Nothing is shown while there are
 * none, or when the list cannot be loaded (the rest of the page still works).
 */
export function VisitMoveRequests({ onAnswered }: { onAnswered: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ moves: ProVisitMove[] }>('/pro/visit-moves'), [api]);
  const { state, reload, update } = useResource(load);
  usePolling(reload, 30_000);

  if (state.status !== 'ready' || state.data.moves.length === 0) {
    return null;
  }
  return (
    <section className="stack" aria-labelledby="visit-moves-heading">
      <h2 id="visit-moves-heading" className="h-sm">
        {t('visitMove.title')}
      </h2>
      {state.data.moves.map((move) => (
        <MoveCard
          key={move.id}
          move={move}
          onAnswered={(moves) => {
            update(() => ({ moves }));
            onAnswered();
          }}
        />
      ))}
    </section>
  );
}
