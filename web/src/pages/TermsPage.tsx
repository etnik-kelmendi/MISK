import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { Icon } from '../components/Icon';

/** The sections of the terms, in order; each has a title and a body in the translations. */
export const TERMS_SECTIONS = [
  'about',
  'account',
  'booking',
  'cancelling',
  'problems',
  'tips',
  'plans',
  'pros',
  // For pros (D100): the code of conduct and the cancellation rules, linked from the pro Profile's Terms.
  'conduct',
  'proCancelling',
  'liability',
  'changes',
] as const;

/** The terms and conditions, shown on their own page and in the sign-up form. */
export function TermsContent({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const { t } = useTranslation();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className="terms-text stack">
      <p className="small muted">{t('terms.updated')}</p>
      <p>{t('terms.intro')}</p>
      {TERMS_SECTIONS.map((section) => (
        <section key={section} aria-labelledby={`terms-${section}`}>
          <Heading id={`terms-${section}`}>{t(`terms.sections.${section}.title`)}</Heading>
          <p>{t(`terms.sections.${section}.body`)}</p>
        </section>
      ))}
    </div>
  );
}

export function TermsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { hash } = useLocation();
  // A link to one part, e.g. the subscription terms from Profile (D92), opens at that part.
  useEffect(() => {
    if (hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView?.();
  }, [hash]);
  // Back to where the terms were opened from; a link opened on its own goes to sign-in.
  const back = () => (window.history.length > 1 ? navigate(-1) : navigate('/signin'));
  return (
    // The app's usual header bar and padded body, so the terms read like every other page.
    <div className="app-frame">
      <main className="app-body terms-page">
        <header className="appbar">
          <button type="button" className="iconbtn" aria-label={t('terms.back')} onClick={() => void back()}>
            <Icon name="chevL" />
          </button>
          <h1>{t('terms.title')}</h1>
        </header>
        <div className="body">
          <TermsContent />
        </div>
      </main>
    </div>
  );
}
