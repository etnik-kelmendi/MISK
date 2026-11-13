import { cleanNumberInput, parseNumberField, stepNumber } from './PlansPage';

describe('plan number fields', () => {
  it.each([
    ['03', '3'],
    ['0', '0'],
    ['00', '0'],
    ['045', '45'],
    ['', ''],
    ['4a5', '45'],
    [' 60 ', '60'],
    ['-15', '15'],
    ['1.5', '15'],
  ])('keeps %j as %j', (typed, kept) => {
    expect(cleanNumberInput(typed)).toBe(kept);
  });

  it('never leaves a zero in front after the first digit is deleted', () => {
    // "60" with the 6 deleted leaves "0"; typing 4 and 5 then gives 45, not 045.
    expect(cleanNumberInput('0' + '4')).toBe('4');
    expect(cleanNumberInput('4' + '5')).toBe('45');
    expect(parseNumberField('visitMinutes', cleanNumberInput('045'))).toBe(45);
  });

  it('steps with the arrow keys within the limits, in the field’s steps', () => {
    expect(stepNumber('visitMinutes', '60', 1)).toBe(75);
    expect(stepNumber('visitMinutes', '60', -1)).toBe(45);
    expect(stepNumber('visitMinutes', '50', 1)).toBe(60);
    expect(stepNumber('visitMinutes', '50', -1)).toBe(45);
    expect(stepNumber('visitMinutes', '15', -1)).toBe(15);
    expect(stepNumber('visitMinutes', '600', 1)).toBe(600);
    expect(stepNumber('visitMinutes', '', 1)).toBe(15);
    expect(stepNumber('minTermMonths', '0', -1)).toBe(0);
    expect(stepNumber('minTermMonths', '', -1)).toBe(12);
    expect(stepNumber('skipsPerMonth', '2', 1)).toBe(3);
    expect(stepNumber('skipsPerMonth', '8', 1)).toBe(8);
  });
});
