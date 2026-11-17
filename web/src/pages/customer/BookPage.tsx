import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { useMarket } from '../../api/MarketContext';
import type { CustomerBooking, PaymentStep, Service } from '../../api/types';
import { ErrorText } from '../../components/ErrorText';
import { Icon } from '../../components/Icon';
import { dateTime, dayParts, euro, packagePrice, sizePrice } from '../../lib/format';
import { useAction } from '../../lib/useAction';
import { CardPayment } from '../../payments/CardPayment';
import { AppHeader } from '../../shells/Shells';
import { EMPTY_DETAILS, JobDetailsStep, type Details } from './JobDetailsStep';
import { ChooseTimeStep, type When } from './ChooseTimeStep';

function ReviewStep({ services, details, when }: { services: Service[]; details: Details; when: When }) {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const { timezone, feeCents } = useMarket();
  const { run, busy, error } = useAction();
  const [created, setCreated] = useState<{
    booking: CustomerBooking;
    payment: PaymentStep;
  } | null>(null);
  const price = packagePrice(services, details.size);
  const total = price.jobCents + feeCents;
  const name = services.map((service) => service.name).join(' + ');

  async function book() {
    const result = await run(() =>
      api.post<{ booking: CustomerBooking; payment: PaymentStep | null }>('/bookings', {
        serviceIds: services.map((service) => service.id),
        size: details.size,
        address: details.address,
        postcode: details.postcode,
        notes: details.notes,
        ...(when.kind === 'slot' ? { startsAt: when.slot.startsAt } : { flexibleWindow: when.window, day: when.day }),
      }),
    );
    if (!result) {
      return;
    }
    // The booking is made; its photos follow. One that fails can be added again on the booking page.
    for (const photo of details.photos) {
      try {
        await api.upload(`/bookings/${result.booking.id}/photos`, photo);
      } catch (caught) {
        console.warn('A booking photo could not be sent', caught);
      }
    }
    if (result.payment) {
      setCreated({ booking: result.booking, payment: result.payment });
    } else {
      navigate(`/bookings/${result.booking.id}`, { replace: true });
    }
  }

  return (
    <>
      <div className="body">
        <section className="card" aria-label={t('book.summary')}>
          <p className="b">{name}</p>
          <p className="small muted">{t(`book.size.${details.size}`)}</p>
          <hr />
          <p className="row small">
            <Icon name="calendar" />{' '}
            {when.kind === 'slot'
              ? dateTime(when.slot.startsAt, timezone)
              : t('time.flexibleSummary', {
                  day: `${dayParts(when.anyIso, timezone).weekday} ${dayParts(when.anyIso, timezone).day} ${dayParts(when.anyIso, timezone).month}`,
                  window: t(`time.window.${when.window}`).toLowerCase(),
                })}
          </p>
          <p className="row small">
            <Icon name="pin" /> {details.address}, {details.postcode}
          </p>
          {details.photos.length > 0 && (
            <p className="row small">
              <Icon name="camera" /> {t('details.photosAttached', { count: details.photos.length })}
            </p>
          )}
        </section>
        <section className="card" aria-label={t('book.price')}>
          {services.map((service, index) => (
            <p key={service.id} className="line">
              <span>{service.name}</span>
              <span>{euro(price.lines[index] ?? sizePrice(service, details.size))}</span>
            </p>
          ))}
          {price.discountCents > 0 && (
            <p className="line">
              <span className="muted">{t('book.packageDiscount')}</span>
              <span>-{euro(price.discountCents)}</span>
            </p>
          )}
          <p className="line">
            <span className="muted">{t('book.fee')}</span>
            <span>{euro(feeCents)}</span>
          </p>
          <p className="line total">
            <span>{t('book.total')}</span>
            <span>{euro(total)}</span>
          </p>
        </section>
        {created ? (
          <section aria-label={t('pay.title')}>
            <h2 className="h-sm">{t('pay.title')}</h2>
            <CardPayment
              payment={created.payment}
              amountLabel={euro(created.booking.totalCents)}
              onConfirmed={() => navigate(`/bookings/${created.booking.id}`, { replace: true })}
            />
          </section>
        ) : (
          <div className="info">
            <Icon name="shield" />
            <p>{t('book.holdExplained')}</p>
          </div>
        )}
        <ErrorText error={error} />
      </div>
      {!created && (
        <div className="cta-bar">
          <button className="cta" type="button" disabled={busy} onClick={() => void book()}>
            <Icon name="lock" /> {busy ? t('book.booking') : t('book.bookAndPay', { amount: euro(total) })}
          </button>
        </div>
      )}
    </>
  );
}

export function BookPage() {
  const { t } = useTranslation();
  const { serviceId } = useParams();
  const [params] = useSearchParams();
  const market = useMarket();
  const [step, setStep] = useState<'details' | 'time' | 'review'>('details');
  const [details, setDetails] = useState<Details>(EMPTY_DETAILS);
  const [when, setWhen] = useState<When | null>(null);

  // One or more services of one trade (D68): /book?services=a,b, or /book/a from older links.
  const ids = serviceId ? [serviceId] : (params.get('services') ?? '').split(',').filter(Boolean);
  const category = market.categories.find((c) => c.services.some((s) => s.id === ids[0]));
  const services = ids.map((id) => category?.services.find((s) => s.id === id)).filter((s): s is Service => s !== undefined);

  if (!category || services.length === 0 || services.length !== new Set(ids).size) {
    return <Navigate to={category ? `/category/${category.slug}` : '/'} replace />;
  }
  const titles = {
    details: services.map((s) => s.name).join(' + '),
    time: t('book.chooseTime'),
    review: t('book.reviewTitle'),
  };

  return (
    <>
      {step === 'details' ? (
        <AppHeader title={titles.details} back={`/category/${category.slug}`} />
      ) : (
        <header className="appbar">
          <button
            type="button"
            className="iconbtn"
            aria-label={t('common.back')}
            onClick={() => setStep(step === 'review' ? 'time' : 'details')}
          >
            <Icon name="chevL" />
          </button>
          <h1>{titles[step]}</h1>
        </header>
      )}
      <ol className="progress-steps" aria-label={t('book.progress')}>
        {(['details', 'time', 'review'] as const).map((s) => (
          <li key={s} className={s === step ? 'on' : ''} aria-current={s === step ? 'step' : undefined}>
            {t(`book.steps.${s}`)}
          </li>
        ))}
      </ol>
      {step === 'details' && (
        <JobDetailsStep
          category={category}
          services={services}
          details={details}
          onPrefill={(address, postcode) =>
            setDetails((current) => (current.address || current.postcode ? current : { ...current, address, postcode }))
          }
          onChange={(next) => {
            if (next.postcode !== details.postcode) {
              setWhen(null);
            }
            setDetails(next);
          }}
          onNext={() => setStep('time')}
        />
      )}
      {step === 'time' && (
        <ChooseTimeStep
          services={services}
          postcode={details.postcode}
          address={details.address}
          initial={when}
          onDone={(next) => {
            setWhen(next);
            setStep('review');
          }}
        />
      )}
      {step === 'review' && when && <ReviewStep services={services} details={details} when={when} />}
    </>
  );
}
