import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import { ApiError } from '../../api/client';
import type { HomePro } from '../../api/types';
import { Icon } from '../../components/Icon';

/** The query parameter that carries the pro picked on Home through Services and the booking (D89). */
export const PRO_PARAM = 'pro';

/**
 * The pro picked on Home, when they can be booked in this trade; null while loading, when nobody was picked,
 * or when the pro is no longer bookable here (the booking then simply goes to normal dispatch).
 */
export function usePickedPro(proId: string | null, categoryId: string): HomePro | null {
  const api = useApi();
  const [pro, setPro] = useState<HomePro | null>(null);
  useEffect(() => {
    if (!proId) return;
    let live = true;
    api.get<{ pro: HomePro }>(`/home/pros/${encodeURIComponent(proId)}`).then(
      (result) => live && setPro(result.pro.trades.some((trade) => trade.id === categoryId) ? result.pro : null),
      (error: unknown) => {
        // A pro who is gone is no choice; anything else is logged, and the booking still works without them.
        if (!(error instanceof ApiError && error.status === 404)) console.warn('Could not load the chosen pro', error);
        if (live) setPro(null);
      },
    );
    return () => {
      live = false;
    };
  }, [api, proId, categoryId]);
  return proId && pro?.id === proId ? pro : null;
}

/** "Booking with Daniel": the picked pro gets the job first; the customer can remove the choice. */
export function PickedProChip({ pro, onRemove }: { pro: HomePro; onRemove?: () => void }) {
  const { t } = useTranslation();
  const name = pro.firstName ?? t('home.yourPro');
  return (
    <div className="info picked-pro" role="status">
      <Icon name="heart" />
      <span className="grow">
        <b>{t('picked.title', { name })}</b> {t('picked.text', { name })}
      </span>
      {onRemove && (
        <button type="button" className="mini-btn picked-pro-remove" aria-label={t('picked.remove', { name })} onClick={onRemove}>
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}
