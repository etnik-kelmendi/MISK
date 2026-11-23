import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useParams, useSearchParams } from 'react-router';
import { useMarket } from '../../api/MarketContext';
import type { Service } from '../../api/types';
import { Icon } from '../../components/Icon';
import { AppHeader } from '../../shells/Shells';
import { EMPTY_DETAILS, JobDetailsStep, type Details } from './JobDetailsStep';
import { ChooseTimeStep, type When } from './ChooseTimeStep';
import { ReviewPayStep } from './ReviewPayStep';
import { PickedProChip, PRO_PARAM, usePickedPro } from './PickedPro';

export function BookPage() {
  const { t } = useTranslation();
  const { serviceId } = useParams();
  const [params, setParams] = useSearchParams();
  const market = useMarket();
  const [step, setStep] = useState<'details' | 'time' | 'review'>('details');
  const [details, setDetails] = useState<Details>(EMPTY_DETAILS);
  const [when, setWhen] = useState<When | null>(null);

  // One or more services of one trade (D68): /book?services=a,b, or /book/a from older links.
  const ids = serviceId ? [serviceId] : (params.get('services') ?? '').split(',').filter(Boolean);
  const category = market.categories.find((c) => c.services.some((s) => s.id === ids[0]));
  const services = ids.map((id) => category?.services.find((s) => s.id === id)).filter((s): s is Service => s !== undefined);
  // The pro picked on Home gets the job first (D89).
  const picked = usePickedPro(params.get(PRO_PARAM), category?.id ?? '');

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
      {picked && step !== 'review' && (
        <div className="body picked-pro-bar">
          <PickedProChip
            pro={picked}
            onRemove={() => {
              const next = new URLSearchParams(params);
              next.delete(PRO_PARAM);
              setParams(next, { replace: true });
            }}
          />
        </div>
      )}
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
          picked={picked}
          initial={when}
          onDone={(next) => {
            setWhen(next);
            setStep('review');
          }}
        />
      )}
      {step === 'review' && when && (
        <ReviewPayStep category={category} services={services} details={details} when={when} picked={picked} />
      )}
    </>
  );
}
