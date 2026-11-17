import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// "findBy…" and "waitFor" wait up to 3 seconds instead of 1: a busy machine (servers running, the whole suite
// at once) sometimes needs more than a second to re-render, which made the plan editor tests fail at random.
configure({ asyncUtilTimeout: 3000 });

// Node-environment suites have no DOM, so the i18n setup only runs for component tests.
if (typeof document !== 'undefined') {
  const { default: i18n, LANGUAGE } = await import('../i18n');

  beforeEach(async () => {
    await i18n.changeLanguage(LANGUAGE);
    window.localStorage.clear();
    // What one test remembers for the browser tab (an invite link, announced messages) never leaks into the next.
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
}
