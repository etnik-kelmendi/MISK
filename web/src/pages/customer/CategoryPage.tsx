import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useParams } from 'react-router';
import { useMarket } from '../../api/MarketContext';
import { Icon } from '../../components/Icon';
import { euro } from '../../lib/format';
import { AppHeader } from '../../shells/Shells';
import { CATEGORY_COLORS } from './categoryColors';

export function CategoryPage() {
  const { t } = useTranslation();
  const { slug } = useParams();
  const market = useMarket();
  const navigate = useNavigate();
  const category = market.categories.find((c) => c.slug === slug);
  const [serviceId, setServiceId] = useState<string | null>(null);

  if (!category) {
    return <Navigate to="/" replace />;
  }
  const color = CATEGORY_COLORS[category.icon];
  const chosen = category.services.find((s) => s.id === serviceId);

  return (
    <>
      <AppHeader title={category.name} back="/" />
      <div className="body">
        <div className="card row" style={{ background: color.bg, boxShadow: 'none' }}>
          <span className="ci" style={{ background: '#fff', color: color.fg }}>
            <Icon name={category.icon} />
          </span>
          <div>
            <p className="b">{t('category.pros', { count: category.approvedPros })}</p>
            <p className="small muted">{t('category.checked')}</p>
          </div>
        </div>
        <fieldset className="choices">
          <legend className="h-sm">{t('category.choose')}</legend>
          {category.services.length === 0 && <p className="muted">{t('category.noServices')}</p>}
          {category.services.map((service) => (
            <label key={service.id} className={`svc ${serviceId === service.id ? 'on' : ''}`}>
              <input
                type="radio"
                name="service"
                className="visually-hidden"
                checked={serviceId === service.id}
                onChange={() => setServiceId(service.id)}
              />
              <span className="radio" aria-hidden="true" />
              <span className="grow">
                <span className="b block">{service.name}</span>
                {service.description && <span className="small muted block">{service.description}</span>}
                <span className="tiny muted row gap4">
                  <Icon name="clock" /> {t('category.duration', { minutes: service.durationMinutes })}
                </span>
              </span>
              <span className="price">{t('category.from', { price: euro(service.priceCents) })}</span>
            </label>
          ))}
        </fieldset>
      </div>
      <div className="cta-bar">
        <button className="cta" type="button" disabled={!chosen} onClick={() => chosen && navigate(`/book/${chosen.id}`)}>
          {chosen ? t('category.continueFrom', { price: euro(chosen.priceCents) }) : t('category.pickOne')}
        </button>
      </div>
    </>
  );
}
