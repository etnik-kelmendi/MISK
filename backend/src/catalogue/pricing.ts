export type JobSize = 'S' | 'M' | 'L';

export type Pricing = 'fixed' | 'hourly';

export interface SizedPrice {
  priceCents: number;
  sizeSmallPct: number;
  sizeMediumPct: number;
  sizeLargePct: number;
  /** 'hourly': `priceCents` is per hour and the size does not change the price. */
  pricing: Pricing;
  durationMinutes: number;
}

/** The job price in whole cents: base price times the size factor, or the hourly rate times the job length. */
export function jobPriceCents(service: SizedPrice, size: JobSize): number {
  if (service.pricing === 'hourly') {
    return Math.round((service.priceCents * service.durationMinutes) / 60);
  }
  const pct = { S: service.sizeSmallPct, M: service.sizeMediumPct, L: service.sizeLargePct }[size];
  return Math.round((service.priceCents * pct) / 100);
}

/** The pro's part of an amount, rounded down so MISK never pays out more than it took. */
export function proShareCents(amountCents: number, proSharePct: number): number {
  return Math.floor((amountCents * proSharePct) / 100);
}

/** Two or more services in one visit cost this much less (D68). */
export const PACKAGE_DISCOUNT_PCT = 10;
/** The most services one booking can hold. */
export const MAX_PACKAGE_SERVICES = 10;

export interface PackagePrice {
  /** Each service's own price for the size. */
  lines: number[];
  /** What the package discount takes off; 0 for a single service. */
  discountCents: number;
  /** The job price after the discount. */
  jobCents: number;
  /** The visit length: every service's length added up. */
  durationMinutes: number;
}

/** The price and length of one visit with one or more services of a trade (D68). */
export function packagePrice(services: SizedPrice[], size: JobSize): PackagePrice {
  const lines = services.map((service) => jobPriceCents(service, size));
  const sum = lines.reduce((total, cents) => total + cents, 0);
  const discountCents = services.length > 1 ? Math.round((sum * PACKAGE_DISCOUNT_PCT) / 100) : 0;
  return {
    lines,
    discountCents,
    jobCents: sum - discountCents,
    durationMinutes: services.reduce((total, service) => total + service.durationMinutes, 0),
  };
}
