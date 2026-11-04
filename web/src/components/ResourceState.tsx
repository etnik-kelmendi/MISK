import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

type State<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error' };

/** Shows a loading line, an error with a retry button, or the loaded content. */
export function ResourceState<T>({
  state,
  reload,
  children,
}: {
  state: State<T>;
  reload: () => void;
  children: (data: T) => ReactNode;
}) {
  const { t } = useTranslation();
  if (state.status === 'loading') {
    return (
      <p className="muted center pad" role="status">
        {t('common.loading')}
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="card center pad" role="alert">
        <p>{t('common.loadFailed')}</p>
        <button type="button" className="btn btn-ghost" onClick={reload}>
          {t('common.retry')}
        </button>
      </div>
    );
  }
  return <>{children(state.data)}</>;
}
