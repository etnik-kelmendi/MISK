import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// Node-environment suites have no DOM, so the i18n setup only runs for component tests.
if (typeof document !== 'undefined') {
  const { default: i18n, LANGUAGE } = await import('../i18n');

  beforeEach(async () => {
    await i18n.changeLanguage(LANGUAGE);
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
}
