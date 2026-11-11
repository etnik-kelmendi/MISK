import { useCallback, useState } from 'react';

type Problems<F extends string> = Partial<Record<F, string | false | null | undefined>>;

/**
 * Field checks for a form. Nothing is shown until the person first tries to send it; from then on each
 * field shows what is missing or wrong and updates as they type. `check()` returns whether the form can
 * be sent and otherwise moves the cursor to the first field to fix, in the order of `ids`.
 */
export function useValidation<F extends string>(problems: Problems<F>, ids: Record<F, string>) {
  const [tried, setTried] = useState(false);

  const message = (field: F): string | null => (tried && problems[field]) || null;

  const check = (): boolean => {
    setTried(true);
    const first = (Object.keys(ids) as F[]).find((field) => problems[field]);
    if (first) {
      document.getElementById(ids[first])?.focus();
      return false;
    }
    return true;
  };

  /** aria-invalid and aria-describedby for the field's input, pointing at its <FieldError>. */
  const describe = (field: F) => {
    const shown = message(field) !== null;
    return {
      'aria-invalid': shown || undefined,
      'aria-describedby': shown ? `${ids[field]}-error` : undefined,
    } as const;
  };

  const reset = useCallback(() => setTried(false), []);

  return { message, check, describe, reset, tried };
}
