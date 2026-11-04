export type JobSize = 'S' | 'M' | 'L';

export interface SizedPrice {
  priceCents: number;
  sizeSmallPct: number;
  sizeMediumPct: number;
  sizeLargePct: number;
}

/** The fixed job price for a size, in whole cents. */
export function jobPriceCents(service: SizedPrice, size: JobSize): number {
  const pct = { S: service.sizeSmallPct, M: service.sizeMediumPct, L: service.sizeLargePct }[size];
  return Math.round((service.priceCents * pct) / 100);
}

/** The pro's part of an amount, rounded down so MISK never pays out more than it took. */
export function proShareCents(amountCents: number, proSharePct: number): number {
  return Math.floor((amountCents * proSharePct) / 100);
}
