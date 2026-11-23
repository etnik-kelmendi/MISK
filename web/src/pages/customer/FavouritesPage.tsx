import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/ApiContext';
import type { FavouritePro } from '../../api/types';
import { useResource } from '../../api/useResource';
import { Avatar } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { AppHeader } from '../../shells/Shells';
import { ProCard } from './HomePage';

/** Favourite pros (D83), reached from "Favourites" on Home (D89): tap one to book them directly. */
export function FavouritesPage() {
  const { t } = useTranslation();
  const api = useApi();
  const load = useCallback(() => api.get<{ pros: FavouritePro[] }>('/favourites/pros'), [api]);
  const { state, reload } = useResource(load);

  return (
    <>
      <AppHeader title={t('favourites.title')} back="/" />
      <div className="body">
        <ResourceState state={state} reload={reload}>
          {({ pros }) =>
            pros.length === 0 ? (
              <p className="card small muted">{t('favourites.none')}</p>
            ) : (
              <>
                <p className="small muted">{t('home.tapPro')}</p>
                <ul className="fav-grid" aria-label={t('favourites.title')}>
                  {pros.map((pro) => (
                    <li key={pro.id}>
                      {pro.trades.length > 0 ? (
                        <ProCard pro={{ ...pro, isFavourite: true }} />
                      ) : (
                        // A favourite who is not taking jobs right now cannot be booked.
                        <div className="procard">
                          <Avatar name={pro.firstName ?? '?'} photoId={pro.photoId} />
                          <span className="b block procard-name">{pro.firstName}</span>
                          <span className="tiny muted block">{t('favourites.unavailable')}</span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )
          }
        </ResourceState>
      </div>
    </>
  );
}
