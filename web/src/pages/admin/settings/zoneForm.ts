/**
 * Checks for the "Add a zone" form (D47). The API repeats the important ones, so these exist to tell the
 * admin what to fix, under the right field, before anything is sent.
 */

/** Must match ZONE_MAX_DISTANCE_KM in the API. */
export const ZONE_MAX_DISTANCE_KM = 100;

/** A German postcode (MISK serves Berlin): five digits, never starting with 00. Must match the API. */
const POSTCODE = /^(?!00)\d{5}$/;
/** Two zones never share a centre; closer than this means one zone's coordinates were reused. Must match the API. */
export const ZONE_MIN_DISTANCE_KM = 0.1;
/** A plain decimal number: optional sign, up to three digits, then a dot or comma and decimals. */
const DECIMAL = /^[+-]?\d{1,3}(?:[.,]\d+)?$/;
/** Two numbers as a map copies them, e.g. "52.5200, 13.4050". Dots only, so "52,52" stays one number. */
const PAIR = /^\s*([+-]?\d{1,3}\.\d+)\s*[,;\s]\s*([+-]?\d{1,3}\.\d+)\s*$/;

export type ZoneField = 'code' | 'name' | 'lat' | 'lng';

export type ZoneProblem =
  | { field: 'code'; key: 'codeRequired' | 'codeInvalid' }
  | { field: 'name'; key: 'nameRequired' }
  | { field: 'lat'; key: 'latRequired' | 'latFormat' | 'latRange' }
  | { field: 'lng'; key: 'lngRequired' | 'lngFormat' | 'lngRange' | 'sameAsLat' }
  | { field: 'lng'; key: 'tooFar'; km: number; nearest: string }
  | { field: 'lng'; key: 'sameAsZone'; nearest: string };

export interface ZoneInput {
  code: string;
  name: string;
  lat: string;
  lng: string;
}

export interface KnownZone {
  code: string;
  lat: number;
  lng: number;
}

/** The number in a coordinate field, or null when it is not a plain decimal number. */
export function parseCoordinate(text: string): number | null {
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed)) return null;
  const value = Number(trimmed.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/** "52.52, 13.405" pasted into one field, split into latitude and longitude; null for anything else. */
export function splitPair(text: string): { lat: string; lng: string } | null {
  const match = PAIR.exec(text);
  return match?.[1] && match[2] ? { lat: match[1], lng: match[2] } : null;
}

/** Great-circle distance, the same formula as distance_km() in the database. */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function nearestZone(lat: number, lng: number, code: string, zones: KnownZone[]): { code: string; km: number } | null {
  let best: { code: string; km: number } | null = null;
  for (const zone of zones) {
    if (zone.code.toUpperCase() === code.toUpperCase()) continue;
    const km = distanceKm(zone.lat, zone.lng, lat, lng);
    if (!best || km < best.km) best = { code: zone.code, km };
  }
  return best;
}

/** Everything wrong with the form, at most one problem per field, in field order. */
export function zoneProblems(input: ZoneInput, zones: KnownZone[]): ZoneProblem[] {
  const problems: ZoneProblem[] = [];
  const code = input.code.trim();
  if (code === '') problems.push({ field: 'code', key: 'codeRequired' });
  else if (!POSTCODE.test(code)) problems.push({ field: 'code', key: 'codeInvalid' });

  if (input.name.trim() === '') problems.push({ field: 'name', key: 'nameRequired' });

  const lat = parseCoordinate(input.lat);
  if (input.lat.trim() === '') problems.push({ field: 'lat', key: 'latRequired' });
  else if (lat === null) problems.push({ field: 'lat', key: 'latFormat' });
  else if (Math.abs(lat) > 90) problems.push({ field: 'lat', key: 'latRange' });

  const lng = parseCoordinate(input.lng);
  if (input.lng.trim() === '') problems.push({ field: 'lng', key: 'lngRequired' });
  else if (lng === null) problems.push({ field: 'lng', key: 'lngFormat' });
  else if (Math.abs(lng) > 180) problems.push({ field: 'lng', key: 'lngRange' });

  const coordinatesOk = !problems.some((p) => p.field === 'lat' || p.field === 'lng');
  if (coordinatesOk && lat !== null && lng !== null) {
    if (lat === lng) {
      problems.push({ field: 'lng', key: 'sameAsLat' });
    } else {
      const nearest = nearestZone(lat, lng, code, zones);
      if (nearest && nearest.km < ZONE_MIN_DISTANCE_KM) {
        problems.push({ field: 'lng', key: 'sameAsZone', nearest: nearest.code });
      } else if (nearest && nearest.km > ZONE_MAX_DISTANCE_KM) {
        problems.push({ field: 'lng', key: 'tooFar', km: Math.round(nearest.km), nearest: nearest.code });
      }
    }
  }
  return problems;
}
