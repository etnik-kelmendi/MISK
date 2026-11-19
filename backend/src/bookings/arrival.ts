import type { Queryable } from '../db.js';

/**
 * When the pro is expected at the job (D83). With a recent position from the pro's phone the time is the
 * straight-line distance to the centre of the job's postcode, made longer by ROAD_FACTOR for the roads, at
 * SPEED_KMH, plus BUFFER_MINUTES to park and ring. Without one it is the booked start (or now, once the start
 * has passed): a pro who has not set off after the start is late by the time since the start.
 */
export const ROAD_FACTOR = 1.4;
export const SPEED_KMH = 25;
export const BUFFER_MINUTES = 3;
/** A position older than this no longer says where the pro is. */
export const POSITION_FRESH_MINUTES = 5;
/** The customer is told the pro runs late once they will arrive more than this many minutes after the start. */
export const LATE_NOTICE_MINUTES = 10;
/** A pro this many minutes late or more lets the customer cancel for free (D83). */
export const FREE_CANCEL_LATE_MINUTES = 30;
/** Statuses with an arrival to show: the pro is booked and has not arrived yet. */
export const ARRIVAL_STATUSES = ['accepted', 'on_the_way'];

export interface Point {
  lat: number;
  lng: number;
}

export interface Arrival {
  expectedAt: Date;
  /** Minutes after the booked start the pro is expected, 0 when on time. */
  lateMinutes: number;
  source: 'live' | 'booked';
  /** The pro's latest position, only while it is recent. */
  proPosition?: Point & { at: Date };
  /** The centre of the job's postcode; null when the postcode is not known. */
  destination: Point | null;
}

const EARTH_RADIUS_KM = 6371;
const MINUTE_MS = 60_000;

/** Great-circle distance in kilometres, the same formula as the database's distance_km. */
export function distanceKm(a: Point, b: Point): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Minutes to drive from one point to the other, as the arrival time counts them. */
export function travelMinutes(from: Point, to: Point): number {
  return ((distanceKm(from, to) * ROAD_FACTOR) / SPEED_KMH) * 60 + BUFFER_MINUTES;
}

export interface ArrivalInput {
  status: string;
  startsAt: Date;
  now: Date;
  position: (Point & { at: Date }) | null;
  destination: Point | null;
}

/** The expected arrival of a booked pro, or null when there is nothing to arrive for (see ARRIVAL_STATUSES). */
export function computeArrival(input: ArrivalInput): Arrival | null {
  if (!ARRIVAL_STATUSES.includes(input.status)) {
    return null;
  }
  const { position, destination, now, startsAt } = input;
  const fresh =
    input.status === 'on_the_way' &&
    position !== null &&
    destination !== null &&
    now.getTime() - position.at.getTime() <= POSITION_FRESH_MINUTES * MINUTE_MS;
  const expectedAt =
    fresh && position && destination
      ? new Date(now.getTime() + travelMinutes(position, destination) * MINUTE_MS)
      : new Date(Math.max(startsAt.getTime(), now.getTime()));
  const lateMinutes = Math.max(0, Math.round((expectedAt.getTime() - startsAt.getTime()) / MINUTE_MS));
  return {
    expectedAt,
    lateMinutes,
    source: fresh ? 'live' : 'booked',
    ...(fresh && position ? { proPosition: { lat: position.lat, lng: position.lng, at: position.at } } : {}),
    destination,
  };
}

/** The arrival of one booking as it stands now. Pass a transaction's client to read it under its lock. */
export async function loadArrival(db: Queryable, bookingId: string): Promise<Arrival | null> {
  const found = await db.query<{
    status: string;
    starts_at: Date;
    pro_lat: number | null;
    pro_lng: number | null;
    pro_location_at: Date | null;
    dest_lat: number | null;
    dest_lng: number | null;
    now: Date;
  }>(
    `SELECT b.status, b.starts_at, b.pro_lat, b.pro_lng, b.pro_location_at, pc.lat AS dest_lat, pc.lng AS dest_lng, now() AS now
     FROM bookings b LEFT JOIN postcodes pc ON pc.code = b.postcode WHERE b.id = $1`,
    [bookingId],
  );
  const row = found.rows[0];
  if (!row) {
    return null;
  }
  return computeArrival({
    status: row.status,
    startsAt: row.starts_at,
    now: row.now,
    position:
      row.pro_lat !== null && row.pro_lng !== null && row.pro_location_at !== null
        ? { lat: row.pro_lat, lng: row.pro_lng, at: row.pro_location_at }
        : null,
    destination: row.dest_lat !== null && row.dest_lng !== null ? { lat: row.dest_lat, lng: row.dest_lng } : null,
  });
}
