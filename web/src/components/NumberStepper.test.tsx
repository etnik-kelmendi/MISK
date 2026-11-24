import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NumberStepper } from './NumberStepper';

function Harness({ start = 7, onChange }: { start?: number; onChange?: (value: number) => void }) {
  const [value, setValue] = useState(start);
  return (
    <>
      <label htmlFor="days">Notice</label>
      <span id="days-hint">Help text</span>
      <NumberStepper
        id="days"
        value={value}
        min={1}
        max={30}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
        decreaseLabel="Fewer days"
        increaseLabel="More days"
        valueText={(days) => `${days} ${days === 1 ? 'day' : 'days'}`}
        unit={value === 1 ? 'day' : 'days'}
        aria-describedby="days-hint"
      />
    </>
  );
}

describe('NumberStepper', () => {
  it('is a labelled, described spinbutton with its range and a written-out value', () => {
    render(<Harness />);
    const field = screen.getByRole('spinbutton', { name: 'Notice' });
    expect(field).toHaveValue(7);
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(field).toHaveAttribute('aria-valuemin', '1');
    expect(field).toHaveAttribute('aria-valuemax', '30');
    expect(field).toHaveAttribute('aria-valuenow', '7');
    expect(field).toHaveAttribute('aria-valuetext', '7 days');
    expect(field).toHaveAccessibleDescription('Help text');
  });

  it('steps with the buttons and stops at both ends', async () => {
    const user = userEvent.setup();
    render(<Harness start={2} />);
    const field = screen.getByRole('spinbutton', { name: 'Notice' });
    const fewer = screen.getByRole('button', { name: 'Fewer days' });
    const more = screen.getByRole('button', { name: 'More days' });
    await user.click(fewer);
    expect(field).toHaveValue(1);
    expect(fewer).toBeDisabled();
    expect(more).toBeEnabled();
    await user.click(more);
    expect(field).toHaveValue(2);
    expect(fewer).toBeEnabled();
  });

  it('disables plus at the maximum', () => {
    render(<Harness start={30} />);
    expect(screen.getByRole('button', { name: 'More days' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Fewer days' })).toBeEnabled();
  });

  it('clamps a typed value into 1 to 30 when the field is left', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const field = screen.getByRole('spinbutton', { name: 'Notice' });
    await user.clear(field);
    await user.type(field, '45');
    await user.tab();
    expect(field).toHaveValue(30);
    expect(onChange).toHaveBeenLastCalledWith(30);
    await user.clear(field);
    await user.type(field, '0');
    await user.tab();
    expect(field).toHaveValue(1);
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('goes back to the last value when the field is left empty', async () => {
    const user = userEvent.setup();
    render(<Harness start={12} />);
    const field = screen.getByRole('spinbutton', { name: 'Notice' });
    await user.clear(field);
    expect(field).toHaveValue(null);
    await user.tab();
    expect(field).toHaveValue(12);
  });

  it('steps with Arrow Up and Arrow Down', async () => {
    const user = userEvent.setup();
    render(<Harness start={1} />);
    const field = screen.getByRole('spinbutton', { name: 'Notice' });
    field.focus();
    await user.keyboard('{ArrowDown}');
    expect(field).toHaveValue(1);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(field).toHaveValue(3);
    await user.keyboard('{ArrowDown}');
    expect(field).toHaveValue(2);
  });
});
