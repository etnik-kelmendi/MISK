import { initials } from './TeamPage';

describe('initials', () => {
  it.each([
    ['Elion Thaqi', 'ET'],
    ['Sam', 'S'],
    ['sam@misk.app', 'S'],
    ['dren.morina', 'DM'],
    ['Anna Maria Berisha', 'AM'],
    ['', ''],
  ])('turns %j into %j', (text, expected) => {
    expect(initials(text)).toBe(expected);
  });
});
