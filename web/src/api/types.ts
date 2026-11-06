/** Shapes the MISK API returns. Money is in euro cents; times are ISO strings. */

export type Role = 'customer' | 'pro' | 'admin';

export interface User {
  id: string;
  role: Role | null;
  phone: string | null;
  username: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
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
  /** "B-1042": what the team and the customer quote on the phone. */
  number: string;
  categoryName: string;
  problemReportedAt: string | null;
  problemNote: string | null;
  problemResolvedAt: string | null;
  /** When the card is charged: 24 hours after the job is done. Null until then. */
  chargeAt: string | null;
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
  canReportProblem: boolean;
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
  actions: AdminAction[];
  split: { proCents: number; miskCents: number };
}

export type AdminActionKind = 'assigned' | 'restarted_search' | 'rescheduled' | 'cancelled' | 'refunded' | 'charged_after_problem';

/** One change the team made to a booking. */
export interface AdminAction {
  id: string;
  action: AdminActionKind;
  details: { proName?: string | null; from?: string; to?: string; amountCents?: number; wasCharged?: boolean };
  createdAt: string;
  adminName: string | null;
}

export interface AdminVisit {
  id: string;
  number: string;
  startsAt: string;
  endsAt: string;
  status: VisitStatus;
  tasksDone: string[];
  completedAt: string | null;
  subscriptionId: string;
  planName: string;
  tasks: string[];
  address: string;
  postcode: string;
  notes: string;
  priceCents: number;
  proSharePct: number;
  subscriptionStatus: string;
  categoryName: string;
  customer: { firstName: string | null; lastName: string | null; phone: string | null; email: string | null };
  pro: { id: string; firstName: string | null; phone: string | null };
  perVisitCents: number;
  proMonthlyCents: number;
  miskMonthlyCents: number;
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

export const ADMIN_TABS = ['all', 'needs_action', 'live', 'upcoming', 'done'] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];

/** A one-off booking or a plan visit in the admin list. */
export interface AdminBookingListItem {
  kind: 'booking' | 'visit';
  id: string;
  number: string;
  startsAt: string;
  endsAt: string;
  service: string;
  categoryId: string;
  trade: string;
  customer: string | null;
  address: string;
  postcode: string;
  pro: string | null;
  status: BookingStatus | VisitStatus;
  valueCents: number;
  /** A booking's payment, or a plan visit's subscription status. */
  paymentStatus: string;
  problem: boolean;
  tab: Exclude<AdminTab, 'all'>;
}

export interface AdminBookingList {
  bookings: AdminBookingListItem[];
  counts: Record<AdminTab, number>;
  truncated: boolean;
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
  firstName: string | null;
  lastName: string | null;
  /** Asked for an account on the control panel and not yet approved. */
  pending: boolean;
  createdAt: string;
  disabled: boolean;
}

export type Frequency = 'every_2_weeks' | 'weekly' | 'twice_weekly' | 'three_times_weekly';

export interface PlanInput {
  name: string | null;
  categoryId: string | null;
  priceCents: number | null;
  frequency: Frequency;
  visitMinutes: number;
  tasks: string[];
  addonName: string | null;
  addonPriceCents: number | null;
  seasonal: boolean;
  skipsPerMonth: number;
  minTermMonths: number;
  proSharePct: number;
}

export interface Plan extends PlanInput {
  id: string;
  categoryName: string | null;
  categoryIcon: IconName | null;
  seasonFrom: number | null;
  seasonTo: number | null;
  subscribers?: number;
  status: 'draft' | 'published';
  publishedAt: string | null;
  updatedAt: string;
}

export type TimeWindow = 'morning' | 'afternoon';
export type SubscriptionStatus = 'awaiting_payment' | 'active' | 'past_due' | 'cancelled';
export type VisitStatus = 'planned' | 'skipped' | 'completed' | 'cancelled';

export interface SubscriptionVisit {
  id: string;
  startsAt: string;
  endsAt: string;
  status: VisitStatus;
  tasksDone: string[];
}

export interface Subscription {
  id: string;
  planId: string;
  planName: string;
  categoryId: string;
  tasks: string[];
  size: JobSize;
  frequency: Frequency;
  days: number[];
  timeWindow: TimeWindow;
  visitMinutes: number;
  address: string;
  postcode: string;
  notes: string;
  withAddon: boolean;
  addonName: string | null;
  priceCents: number;
  seasonal: boolean;
  seasonFrom: number | null;
  seasonTo: number | null;
  skipsPerMonth: number;
  minTermMonths: number;
  status: SubscriptionStatus;
  billingPaused: boolean;
  startedAt: string | null;
  currentPeriodEnd: string | null;
  endsAt: string | null;
  createdAt: string;
  proName: string | null;
  cancelableFrom: string | null;
  visits: SubscriptionVisit[];
  skipsLeftThisMonth: number;
}

export interface ProVisit {
  id: string;
  subscriptionId: string;
  startsAt: string;
  endsAt: string;
  status: VisitStatus;
  tasksDone: string[];
  tasks: string[];
  planName: string;
  address: string;
  postcode: string;
  notes: string;
  customerName: string | null;
  earningsCents: number;
}

export interface ProPlan extends Plan {
  mySubscribers: number;
  earningsPerMonthCents: number;
  visitsPerMonth: number;
}
