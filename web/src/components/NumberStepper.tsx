import { useState, type KeyboardEvent } from 'react';

type Props = {
  /** Id of the number input; the field's <label htmlFor> points at it. */
  id: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** Accessible names of the two buttons, for example "Fewer days" and "More days". */
  decreaseLabel: string;
  increaseLabel: string;
  /** The value written out for assistive technology, for example "7 days". */
  valueText: (value: number) => string;
  /** The short unit shown next to the number, for example "days". */
  unit?: string;
  'aria-describedby'?: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * A compact whole-number field with a minus and a plus button. The number can also be typed (it is a native
 * number input, so it is a spinbutton for screen readers); a typed value is clamped to min..max when the field is left,
 * and Arrow Up / Arrow Down step it.
 */
export function NumberStepper({ id, value, min, max, onChange, decreaseLabel, increaseLabel, valueText, unit, ...rest }: Props) {
  // What is typed right now; it can be empty or out of range until the field is left.
  const [text, setText] = useState(String(value));
  const [shownValue, setShownValue] = useState(value);
  if (shownValue !== value) {
    // The value changed from outside (or a button): show it, dropping whatever was half typed.
    setShownValue(value);
    setText(String(value));
  }

  function commit(next: number) {
    const bounded = clamp(next, min, max);
    setText(String(bounded));
    if (bounded !== value) onChange(bounded);
  }

  function onType(raw: string) {
    setText(raw);
    const typed = Number(raw);
    // Valid whole numbers in range are applied straight away; anything else waits for the blur.
    if (raw !== '' && Number.isInteger(typed) && typed >= min && typed <= max && typed !== value) onChange(typed);
  }

  function onBlur() {
    const typed = Number(text);
    // Empty or not a number: go back to the last good value. Otherwise round and clamp.
    commit(text.trim() === '' || !Number.isFinite(typed) ? value : Math.round(typed));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const current = Number.isFinite(Number(text)) && text.trim() !== '' ? Math.round(Number(text)) : value;
      commit(current + (e.key === 'ArrowUp' ? 1 : -1));
    }
  }

  return (
    <div className="stepper">
      <button type="button" className="stepper-btn" aria-label={decreaseLabel} disabled={value <= min} onClick={() => commit(value - 1)}>
        <span aria-hidden="true">−</span>
      </button>
      <input
        id={id}
        className="stepper-input"
        type="number"
        role="spinbutton"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={text}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={valueText(value)}
        aria-describedby={rest['aria-describedby']}
        onChange={(e) => onType(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
      {unit && (
        <span className="stepper-unit" aria-hidden="true">
          {unit}
        </span>
      )}
      <button type="button" className="stepper-btn" aria-label={increaseLabel} disabled={value >= max} onClick={() => commit(value + 1)}>
        <span aria-hidden="true">+</span>
      </button>
    </div>
  );
}
