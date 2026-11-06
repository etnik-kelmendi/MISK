import { csvCell, toCsv } from './csv';
import { zonedParts, zonedToIso } from './format';

describe('csv', () => {
  it('quotes cells with commas, quotes and line breaks', () => {
    expect(csvCell('Linden Street 12, Berlin')).toBe('"Linden Street 12, Berlin"');
    expect(csvCell('Say "hi"')).toBe('"Say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(48.4)).toBe('48.4');
    expect(csvCell(null)).toBe('');
  });

  it('stops spreadsheet apps from running cells as formulas', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+49 151')).toBe("'+49 151");
    expect(csvCell('@sum')).toBe("'@sum");
  });

  it('starts with a byte order mark and ends rows with CRLF', () => {
    expect(toCsv([['a', 'b'], [1, 2]])).toBe('﻿a,b\r\n1,2\r\n');
  });
});

describe('market time inputs', () => {
  it('turns a date and time on the market clock into the right instant, across daylight saving', () => {
    expect(zonedToIso('2026-11-05', '10:00', 'Europe/Berlin')).toBe('2026-11-05T09:00:00.000Z');
    expect(zonedToIso('2026-07-05', '10:00', 'Europe/Berlin')).toBe('2026-07-05T08:00:00.000Z');
    expect(zonedParts('2026-07-05T08:00:00.000Z', 'Europe/Berlin')).toEqual({ date: '2026-07-05', time: '10:00' });
  });

  it('refuses times that do not exist', () => {
    expect(zonedToIso('2026-02-30', '10:00', 'Europe/Berlin')).toBeNull();
    expect(zonedToIso('2026-03-29', '02:30', 'Europe/Berlin')).toBeNull();
    expect(zonedToIso('tomorrow', '10:00', 'Europe/Berlin')).toBeNull();
  });
});
