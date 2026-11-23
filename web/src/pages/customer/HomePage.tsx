import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { HomeData, HomePro, SavedAddress } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useUser } from '../../auth/AuthContext';
import { Icon } from '../../components/Icon';
import { Avatar } from '../../components/Photos';
import { ResourceState } from '../../components/ResourceState';
import { useInbox } from '../../inbox/InboxContext';
import { euro } from '../../lib/format';
import { AddressSheet, useAddresses } from './Addresses';
import { CATEGORY_COLORS } from './categoryColors';
import { HomeSearch } from './HomeSearch';

/** "morning", "afternoon" or "evening" at this moment in the market's time zone. */
export function partOfDay(timeZone: string, now = new Date()): 'morning' | 'afternoon' | 'evening' {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
}

/** The Services page of the pro's first trade, with the pro already chosen (D89). */
export function bookProPath(pro: HomePro): string | null {
  const trade = pro.trades[0];
  return trade ? `/category/${trade.slug}?pro=${encodeURIComponent(pro.id)}` : null;
}

/** A pro card as Home and Favourites show it: photo, name, trade, stars, jobs and a red heart for favourites. */
export function ProCard({ pro }: { pro: HomePro }) {
  const { t } = useTranslation();
  const to = bookProPath(pro);
  const name = pro.firstName ?? t('home.yourPro');
  if (!to) return null;
  return (
    <Link to={to} className="procard">
      <span className="row between">
        <Avatar name={name} photoId={pro.photoId} />
        {pro.isFavourite && (
          <span className="fav-heart">
            <Icon name="heart" label={t('home.favourite')} />
          </span>
        )}
      </span>
      <span className="b block procard-name">{name}</span>
      <span className="muted small block">{pro.trades.map((trade) => trade.name).join(' · ')}</span>
      <span className="row gap6 procard-stats">
        {pro.ratingAverage !== null && pro.ratingCount > 0 ? (
          <span className="stars" role="img" aria-label={t('home.rating', { average: pro.ratingAverage.toFixed(1) })}>
            <Icon name="star" /> {pro.ratingAverage.toFixed(1)}
          </span>
        ) : (
          <span className="tiny muted">{t('common.newPro')}</span>
        )}
        <span className="muted tiny">{t('home.jobs', { count: pro.jobsDone })}</span>
      </span>
      <span className="tiny b row gap4 brand-text procard-book">
        {t('home.book', { name })} <Icon name="arrowR" />
      </span>
    </Link>
  );
}

/** The selected address under the greeting; tapping it opens the address pop-up. */
function AddressPill({ selected, onOpen }: { selected: SavedAddress | null; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="pill address-pill" aria-haspopup="dialog" onClick={onOpen}>
      <Icon name="pin" />
      <span className="address-pill-text">{selected ? selected.address : t('home.addAddress')}</span>
      <span className="visually-hidden">{t('home.changeAddress')}</span>
      <Icon name="chevD" />
    </button>
  );
}

/** The bell in the header: Messages, with the number of unread ones (D87). */
function MessagesButton() {
  const { t } = useTranslation();
  const { inbox } = useInbox();
  const unread = inbox?.unread ?? 0;
  return (
    <Link to="/messages" className="iconbtn bell-btn" aria-label={unread ? t('home.messagesUnread', { count: unread }) : t('nav.messages')}>
      <Icon name="bell" />
      {unread > 0 && (
        <span className="tab-badge" aria-hidden="true">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </Link>
  );
}

/**
 * Home (D89), as in the design from top to bottom: greeting, the selected address, search, the plans banner,
 * the trades and the top-rated pros near the selected address. The menu is the shell's.
 */
export function HomePage() {
  const { t } = useTranslation();
  const api = useApi();
  const user = useUser();
  const market = useMarket();
  const addresses = useAddresses();
  const loadHome = useCallback(() => api.get<HomeData>('/home'), [api]);
  const home = useResource(loadHome);
  const [sheetOpen, setSheetOpen] = useState(false);
  const list = addresses.state.status === 'ready' ? addresses.state.data : null;
  const selected = list?.addresses.find((address) => address.selected) ?? null;
  const plan = home.state.status === 'ready' ? home.state.data.plan : null;

  function addressChanged() {
    addresses.reload();
    home.reload();
  }

  return (
    <div className="body home">
      <header className="row between home-head">
        <div className="greeting">
          <p className="muted small">{t(`home.greeting.${partOfDay(market.timezone)}`)}</p>
          <h1>
            {user.firstName ?? ''} <span aria-hidden="true">👋</span>
          </h1>
        </div>
        <MessagesButton />
      </header>

      <div>
        {list && <AddressPill selected={selected} onOpen={() => setSheetOpen(true)} />}
        {addresses.state.status === 'error' && (
          <button type="button" className="pill address-pill" onClick={addresses.reload}>
            <Icon name="pin" /> {t('home.addressFailed')}
          </button>
        )}
      </div>
      {sheetOpen && list && <AddressSheet list={list} onChanged={addressChanged} onClose={() => setSheetOpen(false)} />}

      <HomeSearch categories={market.categories} />

      {plan && (
        <Link to="/plans" className="promo">
          <span className="t">{t('home.planBanner', { name: plan.name, price: euro(plan.fromCents) })}</span>
          <span className="s">{t('home.planBannerText')}</span>
          <span className="go">
            {t('home.seeAllPlans')} <Icon name="arrowR" />
          </span>
        </Link>
      )}

      <section aria-labelledby="categories-heading">
        <h2 id="categories-heading" className="h-sm">
          {t('home.categories')}
        </h2>
        {market.categories.length === 0 ? (
          <p className="card muted">{t('home.noCategories')}</p>
        ) : (
          <ul className="cats">
            {market.categories.map((category) => {
              const color = CATEGORY_COLORS[category.icon];
              return (
                <li key={category.id}>
                  <Link to={`/category/${category.slug}`} className="cat">
                    <span className="ci" style={{ background: color.bg, color: color.fg }}>
                      <Icon name={category.icon} />
                    </span>
                    {category.name}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="top-pros-heading">
        <div className="row between">
          <h2 id="top-pros-heading" className="h-sm">
            {t('home.topRated')}
          </h2>
          <Link to="/favourites" className="linkbtn small">
            {t('home.favourites')}
          </Link>
        </div>
        <p className="small muted top-pros-hint">{t('home.tapPro')}</p>
        <ResourceState state={home.state} reload={home.reload}>
          {({ pros }) =>
            pros.length === 0 ? (
              <p className="card small muted">{selected ? t('home.noPros') : t('home.noProsNoAddress')}</p>
            ) : (
              <ul className="hscroll" aria-label={t('home.topRated')}>
                {pros.map((pro) => (
                  <li key={pro.id}>
                    <ProCard pro={pro} />
                  </li>
                ))}
              </ul>
            )
          }
        </ResourceState>
      </section>
    </div>
  );
}
