import { cleanNumberInput, numberProblem, parseNumberField, stepNumber } from './PlansPage';

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
    expect(stepNumber('pauseNoticeDays', '1', -1)).toBe(1);
    expect(stepNumber('pauseNoticeDays', '', -1)).toBe(60);
    expect(stepNumber('pauseNoticeDays', '7', 1)).toBe(8);
    expect(stepNumber('pauseNoticeDays', '60', 1)).toBe(60);
  });
});

describe('what is wrong with a visit length (D62)', () => {
  it.each([
    ['', 'empty'],
    ['0', 'tooSmall'],
    ['10', 'tooSmall'],
    ['14', 'tooSmall'],
    ['20', 'step'],
    ['50', 'step'],
    ['601', 'tooBig'],
    ['700', 'tooBig'],
    ['15', null],
    ['45', null],
    ['600', null],
  ] as const)('%j is %j', (value, problem) => {
    expect(numberProblem('visitMinutes', value)).toBe(problem);
  });
});
