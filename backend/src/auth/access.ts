/**
 * Team roles and what each may open in the control panel (D35). The server checks every /admin request
 * against this list, so hiding a menu item is never the only protection.
 */
export const ADMIN_ROLES = ['admin', 'operations', 'support', 'finance'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const AREAS = ['overview', 'bookings', 'providers', 'plans', 'catalogue', 'fees', 'zones', 'notifications', 'team'] as const;
export type Area = (typeof AREAS)[number];

export const ACCESS: Record<AdminRole, readonly Area[]> = {
  admin: AREAS,
  // Runs the marketplace day to day: jobs, pros, what is sold and where, and the messages.
  operations: ['overview', 'bookings', 'providers', 'plans', 'catalogue', 'zones', 'notifications'],
  // Helps customers and pros with their bookings.
  support: ['overview', 'bookings', 'providers'],
  // Money: bookings and refunds, fees, commission and payouts.
  finance: ['overview', 'bookings', 'fees'],
};

/** Longest prefix first, so /admin/team-x never matches /admin/team by accident. */
const PREFIXES: [string, Area][] = (
  [
    ['/admin/overview', 'overview'],
    ['/admin/badges', 'overview'],
    ['/admin/bookings', 'bookings'],
    ['/admin/visits', 'bookings'],
    ['/admin/pros', 'providers'],
    ['/admin/plans', 'plans'],
    ['/admin/catalogue', 'catalogue'],
    ['/admin/categories', 'catalogue'],
    ['/admin/services', 'catalogue'],
    ['/admin/settings', 'fees'],
    ['/admin/postcodes', 'zones'],
    ['/admin/zones', 'zones'],
    ['/admin/notifications', 'notifications'],
    ['/admin/team', 'team'],
    ['/admin/activity', 'team'],
  ] as [string, Area][]
).sort((a, b) => b[0].length - a[0].length);

/** The area an /admin route belongs to; null for routes every team member may use. */
export function areaOf(routeUrl: string): Area | null {
  for (const [prefix, area] of PREFIXES) {
    if (routeUrl === prefix || routeUrl.startsWith(`${prefix}/`) || routeUrl.startsWith(`${prefix}?`)) {
      return area;
    }
  }
  return null;
}

export function canOpen(role: AdminRole | null, area: Area): boolean {
  return role !== null && ACCESS[role].includes(area);
}
