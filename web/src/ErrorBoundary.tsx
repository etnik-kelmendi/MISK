import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

function ErrorFallback() {
  const { t } = useTranslation();

  return (
    <main role="alert">
      <h1>{t('error.title')}</h1>
      <p>{t('error.message')}</p>
      <button type="button" onClick={() => window.location.reload()}>
        {t('error.reload')}
      </button>
    </main>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error', error, info.componentStack);
  }

  override render() {
    return this.state.failed ? <ErrorFallback /> : this.props.children;
  }
}
