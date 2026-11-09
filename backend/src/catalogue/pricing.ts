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
