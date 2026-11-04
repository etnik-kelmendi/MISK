/** Shapes the MISK API returns. Money is in euro cents; times are ISO strings. */

export type Role = 'customer' | 'pro' | 'admin';

export interface User {
  id: string;
  role: Role | null;
  phone: string | null;
  username: string | null;
  firstName: string | null;
}

export type IconName = 'leaf' | 'hammer' | 'drop' | 'bolt' | 'sparkle' | 'brush' | 'wrench' | 'sun';
export type JobSize = 'S' | 'M' | 'L';

export interface Service {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  priceCents: number;
  durationMinutes: number;
  sizeSmallPct: number;
  sizeMediumPct: number;
  sizeLargePct: number;
  sortOrder: number;
  active: boolean;
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  icon: IconName;
  approvedPros: number;
  services: Service[];
}

export interface Catalogue {
  timezone: string;
  feeCents: number;
  categories: Category[];
}

export interface Postcode {
  code: string;
  name: string;
}

export interface Slot {
  startsAt: string;
  endsAt: string;
  freePros: number;
  available: boolean;
}

export type BookingStatus =
  | 'awaiting_payment'
  | 'searching'
  | 'unassigned'
  | 'accepted'
  | 'on_the_way'
  | 'working'
  | 'completed'
  | 'cancelled';

export type ExtraStatus = 'pending' | 'awaiting_payment' | 'approved' | 'declined' | 'cancelled';

export interface Extra {
  id: string;
  description: string;
  priceCents: number;
  status: ExtraStatus;
  createdAt: string;
}

export interface BookingBase {
  id: string;
  status: BookingStatus;
  serviceName: string;
  categoryId: string;
  size: JobSize;
  address: string;
  postcode: string;
  notes: string;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  completedAt: string | null;
  events: { status: BookingStatus; at: string }[];
  photos: { id: string; kind: 'customer' | 'completion' }[];
  extras: Extra[];
  rating: { stars: number; tags: string[] } | null;
}

export interface ProSummary {
  id: string;
  firstName: string | null;
  ratingAverage: number | null;
  ratingCount: number;
  phone?: string | null;
}

export type PaymentStatus = 'pending' | 'held' | 'captured' | 'released' | 'refunded' | 'failed';

export interface Money {
  priceCents: number;
  feeCents: number;
  extrasCents: number;
  totalCents: number;
  paymentStatus: PaymentStatus;
}

export interface CustomerBooking extends BookingBase, Money {
  pro: ProSummary | null;
  canCancel: boolean;
  canRate: boolean;
}

export interface ProJob extends BookingBase {
  customer: { firstName: string | null };
  earningsCents: number;
}

export interface AdminBooking extends BookingBase, Money {
  pro: ProSummary | null;
  cancelledBy: string | null;
  proSharePct: number;
  customer: { id: string; firstName: string | null; phone: string | null };
  offers: { id: string; proId: string; proName: string | null; status: string; offeredAt: string; expiresAt: string }[];
  payouts: { amountCents: number; status: string; error: string | null; createdAt: string }[];
}

export interface PaymentStep {
  clientSecret: string;
  publishableKey: string | null;
}

export interface BookingListItem {
  id: string;
  status: BookingStatus;
  serviceName: string;
  categoryId: string;
  startsAt: string;
  totalCents: number;
  proName: string | null;
  canRate: boolean;
}

export interface Offer {
  id: string;
  bookingId: string;
  expiresAt: string;
  serviceName: string;
  size: JobSize;
  startsAt: string;
  endsAt: string;
  address: string;
  postcode: string;
  notes: string;
  customerName: string | null;
  distanceKm: number | null;
  photoIds: string[];
  earningsCents: number;
}

export interface JobListItem {
  id: string;
  status: BookingStatus;
  serviceName: string;
  startsAt: string;
  endsAt: string;
  address: string;
  postcode: string;
  earningsCents: number;
}

export type DocumentKind = 'id' | 'certificate' | 'insurance';
export type ProStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'suspended';

export interface ProProfile {
  status: ProStatus;
  homePostcode: string | null;
  radiusKm: number;
  workingDays: number[];
  reviewNote: string | null;
  payoutsEnabled: boolean;
  hasPayoutAccount: boolean;
  ratingAverage: number | null;
  ratingCount: number;
  trades: string[];
  documents: Record<DocumentKind, { uploadId: string; uploadedAt: string } | null>;
}

export interface AdminProListItem {
  id: string;
  firstName: string | null;
  phone: string | null;
  status: ProStatus;
  homePostcode: string | null;
  radiusKm: number;
  workingDays: number[];
  submittedAt: string | null;
  payoutsEnabled: boolean;
  ratingAverage: number | null;
  ratingCount: number;
  trades: string[];
  documentCount: number;
}

export interface Overview {
  days: number;
  kpis: {
    bookings: number;
    completed: number;
    grossCents: number;
    payoutCents: number;
    miskShareCents: number;
    ratingAverage: number | null;
    ratingCount: number;
  };
  weekly: { week: string; bookings: number }[];
  attention: { pendingApplications: number; unassigned: number; unreleasedHolds: number; failedPayouts: number };
}

export interface AdminBookingListItem {
  id: string;
  status: BookingStatus;
  serviceName: string;
  startsAt: string;
  createdAt: string;
  postcode: string;
  address: string;
  customerName: string | null;
  proName: string | null;
  totalCents: number;
  paymentStatus: PaymentStatus;
}

export interface AdminCategory {
  id: string;
  slug: string;
  name: string;
  icon: IconName;
  sortOrder: number;
  active: boolean;
}

export interface AdminPostcode {
  code: string;
  name: string;
  lat: number;
  lng: number;
  active: boolean;
}

export interface Settings {
  serviceFeeCents: number;
  proSharePct: number;
}

export interface AdminAccount {
  id: string;
  username: string;
  email: string | null;
  createdAt: string;
  disabled: boolean;
}
