import { distanceKm, parseCoordinate, splitPair, zoneProblems } from './zoneForm';

const berlin = [
  { code: '10115', lat: 52.5323, lng: 13.3846 },
  { code: '14167', lat: 52.418, lng: 13.26 },
];
const keys = (input: { code?: string; name?: string; lat?: string; lng?: string }, zones = berlin) =>
  zoneProblems({ code: '10178', name: 'Alexanderplatz', lat: '52.5219', lng: '13.4132', ...input }, zones).map((p) => p.key);

describe('parseCoordinate', () => {
  it.each([
    ['52.5219', 52.5219],
    [' 52,5219 ', 52.5219],
    ['-0.1276', -0.1276],
    ['+13', 13],
  ])('reads %j as %d', (text, value) => {
    expect(parseCoordinate(text)).toBe(value);
  });

  it.each(['', 'abc', '52.52.1', '1e2', '52.', '.5', '0x10', '1234', '52.5 13.4', 'Infinity'])('refuses %j', (text) => {
    expect(parseCoordinate(text)).toBeNull();
  });
});

describe('splitPair', () => {
  it('splits coordinates copied from a map', () => {
    expect(splitPair('52.5219, 13.4132')).toEqual({ lat: '52.5219', lng: '13.4132' });
    expect(splitPair('52.5219 13.4132')).toEqual({ lat: '52.5219', lng: '13.4132' });
    expect(splitPair('-33.86;151.21')).toEqual({ lat: '-33.86', lng: '151.21' });
  });

  it('leaves one number, including a comma decimal, alone', () => {
    expect(splitPair('52.5219')).toBeNull();
    expect(splitPair('52,5219')).toBeNull();
  });
});

describe('zoneProblems', () => {
  it('finds nothing wrong with a real point near the other zones', () => {
    expect(keys({})).toEqual([]);
  });

  it('names what is missing in each field', () => {
    expect(keys({ code: '', name: ' ', lat: '', lng: '' })).toEqual(['codeRequired', 'nameRequired', 'latRequired', 'lngRequired']);
  });

  it('refuses text, out-of-range values and a bad postcode', () => {
    expect(keys({ code: '1', lat: 'north', lng: '13,4,1' })).toEqual(['codeInvalid', 'latFormat', 'lngFormat']);
    expect(keys({ lat: '90.5', lng: '-180.01' })).toEqual(['latRange', 'lngRange']);
    expect(keys({ lat: '-90', lng: '180' }, [])).toEqual([]);
  });

  it('refuses the same number in both fields, however it is written', () => {
    expect(keys({ lat: '52.5219', lng: '52.5219' })).toEqual(['sameAsLat']);
    expect(keys({ lat: '52,5', lng: '52.50' })).toEqual(['sameAsLat']);
    expect(keys({ lat: '0', lng: '0' }, [])).toEqual(['sameAsLat']);
  });

  it.each(['---', 'A', '1', 'AB', 'HELLO', '12345678901', '-1234', '1234-', '12--34', '12 - 34', '12_34', '12.34'])(
    'refuses %j as a postcode',
    (code) => {
      expect(keys({ code })).toEqual(['codeInvalid']);
    },
  );

  it.each(['10115', '01067', ' 10179 ', 'SW1A 1AA', 'sw1a  1aa', '75008', '1010', '00-950', '1000-001', 'K1A 0B1', '100-0001', 'D02 X285'])(
    'accepts %j, a postcode from any country',
    (code) => {
      expect(keys({ code })).toEqual([]);
    },
  );

  it('refuses the coordinates of another zone, but lets a zone keep its own', () => {
    const [problem] = zoneProblems({ code: '10997', name: 'Copy', lat: '52.5323', lng: '13.3846' }, berlin);
    expect(problem).toEqual({ field: 'lng', key: 'sameAsZone', nearest: '10115' });
    expect(keys({ code: '10115', lat: '52.5323', lng: '13.3846' })).toEqual([]);
    // The same zone written in lower case is still the same zone.
    expect(keys({ code: 'sw1a 1aa', lat: '51.501', lng: '-0.1419' }, [{ code: 'SW1A 1AA', lat: 51.501, lng: -0.1419 }])).toEqual([]);
  });

  it('accepts points far away from the other zones, anywhere in the world (D84)', () => {
    expect(keys({ code: 'SW1A 1AA', lat: '51.501', lng: '-0.1419' })).toEqual([]);
    expect(keys({ code: '2000', lat: '-33.8688', lng: '151.2093' })).toEqual([]);
    expect(keys({ lat: '13.4132', lng: '52.5219' })).toEqual([]);
  });

  it('does not measure a zone against its own earlier point, and accepts the first zone anywhere', () => {
    expect(keys({ code: '10115', lat: '48.1374', lng: '11.5755' }, berlin.slice(0, 1))).toEqual([]);
    expect(keys({ lat: '48.1374', lng: '11.5755' }, [])).toEqual([]);
  });
});

describe('distanceKm', () => {
  it('matches the known distance between Berlin and Munich', () => {
    expect(distanceKm(52.52, 13.405, 48.1374, 11.5755)).toBeCloseTo(504, -1);
  });
});
