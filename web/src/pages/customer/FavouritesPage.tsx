import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { useApi } from '../../api/ApiContext';
import type { FavouritePro } from '../../api/types';
import { useResource } from '../../api/useResource';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { Avatar } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { useAction } from '../../lib/useAction';
import { AppHeader } from '../../shells/Shells';
import { bookProPath } from './HomePage';

/** Where the back arrow goes: Profile when opened from there, else Home (D89). */
function backPath(state: unknown): string {
  const back = (state as { back?: unknown } | null)?.back;
  return back === '/profile' ? '/profile' : '/';
}

/**
 * Favourite pros (D83, D92): each with photo, name, trade and rating. "Book" opens the Services page of their
 * first trade with the pro chosen (D89); the heart removes them.
 */
export function FavouritesPage() {
  const { t } = useTranslation();
  const api = useApi();
  const location = useLocation();
  const load = useCallback(() => api.get<{ pros: FavouritePro[] }>('/favourites/pros'), [api]);
  const { state, reload } = useResource(load);
  const remove = useAction();
  const [removed, setRemoved] = useState<string | null>(null);

  async function unfavourite(pro: FavouritePro, name: string) {
    setRemoved(null);
    const done = await remove.run(async () => {
      await api.delete(`/favourites/pros/${pro.id}`);
      return true;
    });
    if (done) {
      setRemoved(t('favourites.removed', { name }));
      reload();
    }
  }

  return (
    <>
      <AppHeader title={t('favourites.title')} back={backPath(location.state)} />
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {({ pros }) =>
            pros.length === 0 ? (
              <p className="card small muted center-text">{t('favourites.none')}</p>
            ) : (
              <ul className="stack tight" aria-label={t('favourites.title')}>
                {pros.map((pro) => {
                  const name = pro.firstName ?? t('home.yourPro');
                  const to = bookProPath({ ...pro, isFavourite: true });
                  return (
                    <li key={pro.id} className="card row fav-row">
                      <Avatar name={name} photoId={pro.photoId} />
                      <span className="grow">
                        <span className="b small block">{name}</span>
                        <span className="tiny muted block">
                          {pro.trades.length > 0 ? pro.trades.map((trade) => trade.name).join(' · ') : t('favourites.unavailable')}
                          {pro.ratingAverage !== null && pro.ratingCount > 0 && (
                            <>
                              {' · '}
                              <span className="stars" role="img" aria-label={t('home.rating', { average: pro.ratingAverage.toFixed(1) })}>
                                <Icon name="star" /> {pro.ratingAverage.toFixed(1)}
                              </span>
                            </>
                          )}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="iconbtn fav-remove"
                        aria-label={t('favourites.remove', { name })}
                        disabled={remove.busy}
                        onClick={() => void unfavourite(pro, name)}
                      >
                        <Icon name="heart" />
                      </button>
                      {to && (
                        <Link to={to} className="mini-btn green" aria-label={t('favourites.bookLabel', { name })}>
                          {t('favourites.book')}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            )
          }
        </ResourceState>
        <ErrorText error={remove.error} />
        {removed && (
          <p className="small brand-text" role="status">
            {removed}
          </p>
        )}
        <p className="tiny muted">{t('favourites.hint')}</p>
      </div>
    </>
  );
}
