import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadConfig } from './config';
import { ErrorBoundary } from './ErrorBoundary';
import './i18n';
import './index.css';

// Validates inside the error boundary, so bad configuration shows the recovery page, not a blank one.
function ConfiguredApp() {
  return <App config={loadConfig(import.meta.env)} />;
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <ConfiguredApp />
    </ErrorBoundary>
  </StrictMode>,
);
