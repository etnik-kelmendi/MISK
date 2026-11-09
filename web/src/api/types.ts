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
  /** An admin's team role; null for everyone else. */
  adminRole?: AdminRole | null;
  /** The control panel areas this person may open (admins only). */
  areas?: AdminArea[];
}

export const ADMIN_ROLES = ['admin', 'operations', 'support', 'finance'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export type AdminArea = 'overview' | 'bookings' | 'providers' | 'plans' | 'catalogue' | 'fees' | 'zones' | 'notifications' | 'team';

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
  /** 'hourly': the price is per hour and there are no sizes. */
  pricing: 'fixed' | 'hourly';
  /** Added in the last 14 days. */
  isNew: boolean;
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
  /** The pro's share of jobs and tips today, in percent. */
  proSharePct: number;
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
  /** What cancelling now would cost: set when a pro is booked and the start is less than 24 hours away. */
  lateCancelCents: number | null;
  lateCancel: boolean;
  tip: { amountCents: number; proCents: number; status: 'pending' | 'captured' | 'failed' } | null;
  canTip: boolean;
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

export type DocumentKind = 'id' | 'certificate' | 'insurance' | 'background';
export const DOCUMENT_KINDS: DocumentKind[] = ['id', 'certificate', 'insurance', 'background'];
/** Documents that run out, so the pro gives their expiry date. */
export const EXPIRING_KINDS: DocumentKind[] = ['id', 'insurance'];

export type ProStatus = 'draft' | 'submitted' | 'info_requested' | 'approved' | 'pending_approval' | 'rejected' | 'suspended';
export type CheckState = 'missing' | 'waiting_review' | 'rejected' | 'expired' | 'expiring' | 'valid';

export interface ProDocument {
  uploadId: string;
  fileName: string;
  uploadedAt: string;
  /** "YYYY-MM-DD" */
  expiresOn: string | null;
  reviewStatus: 'pending' | 'accepted' | 'rejected';
  reviewNote: string | null;
}

export interface ProProfile {
  status: ProStatus;
  homePostcode: string | null;
  radiusKm: number;
  workingDays: number[];
  reviewNote: string | null;
  payoutsEnabled: boolean;
  hasPayoutAccount: boolean;
  jobsPaused: boolean;
  suspendedReason: string | null;
  ratingAverage: number | null;
  ratingCount: number;
  trades: string[];
  documents: Record<DocumentKind, (ProDocument & { state: CheckState }) | null>;
}

export const PRO_TABS = ['applications', 'active', 'pending_approval', 'suspended'] as const;
export type ProTab = (typeof PRO_TABS)[number];
export type QualityReason = 'low_acceptance' | 'late' | 'low_rating';

export interface ProNumbers {
  jobs30: number;
  acceptancePct: number | null;
  onTimePct: number | null;
  regularCustomers: number;
  ratingAverage: number | null;
  ratingCount: number;
  qualityReasons: QualityReason[];
}

export interface AdminProListItem extends ProNumbers {
  id: string;
  firstName: string | null;
  lastName: string | null;
  status: ProStatus;
  trades: string[];
  submittedAt: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  reviewNote: string | null;
  jobsPaused: boolean;
  watchList: boolean;
  checksDone: number;
  checksTotal: number;
  ready: boolean;
  expiringDocument: boolean;
  expiredDocument: boolean;
  waitingDocuments: number;
}

export interface AdminProSummary {
  kpis: { activePros: number; onlineNow: number; avgAcceptancePct: number | null; documentsExpiring: number };
  counts: Record<ProTab, number>;
  inviteUrl: string;
}

export interface ProCheck {
  kind: DocumentKind;
  ok: boolean;
  state: CheckState;
  document: (ProDocument & { reviewedAt: string | null; validUntil: string | null }) | null;
}

export type ProActionKind =
  | 'approved'
  | 'info_requested'
  | 'rejected'
  | 'document_accepted'
  | 'document_rejected'
  | 'reminder_sent'
  | 'watch_list_on'
  | 'watch_list_off'
  | 'coaching_booked'
  | 'jobs_paused'
  | 'jobs_resumed'
  | 'suspended'
  | 'reinstated'
  | 'moved_to_pending'
  | 'back_to_active';

export interface ProActionEntry {
  id: string;
  action: ProActionKind;
  details: {
    document?: DocumentKind;
    documents?: DocumentKind[];
    note?: string;
    message?: string;
    reason?: string;
    at?: string;
    to?: string;
    bookings?: number;
    plans?: number;
    plansWithoutPro?: number;
  };
  createdAt: string;
  adminName: string | null;
}

export interface AdminProDetail extends ProNumbers {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  status: ProStatus;
  homePostcode: string | null;
  postcodeName: string | null;
  radiusKm: number;
  workingDays: number[];
  trades: string[];
  submittedAt: string | null;
  reviewNote: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  jobsPausedAt: string | null;
  watchListAt: string | null;
  coachingCallAt: string | null;
  payoutsEnabled: boolean;
  hasPayoutAccount: boolean;
  earnedThisMonthCents: number;
  checks: ProCheck[];
  allChecksOk: boolean;
  regulars: { id: string; firstName: string | null; planName: string; since: string | null }[];
  reviews: { stars: number; tags: string[]; createdAt: string; customerName: string | null; service: string }[];
  payouts: { amountCents: number; status: string; createdAt: string; source: 'job' | 'plan' }[];
  bank: { bankLast4: string | null; nextPayout: { amountCents: number; arrivesOn: string } | null } | null;
  actions: ProActionEntry[];
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
  /** False while the trade is a draft, hidden from customers. */
  active: boolean;
  visibleServices: number;
  totalServices: number;
  /** Pros with this trade, applicants included. */
  pros: number;
  /** Approved pros with this trade. */
  verifiedPros: number;
}

export type CatalogueChangeAction =
  | 'trade_added'
  | 'trade_published'
  | 'trade_unpublished'
  | 'trade_edited'
  | 'service_added'
  | 'service_edited'
  | 'price_changed'
  | 'service_hidden'
  | 'service_shown';

export interface CatalogueChange {
  id: string;
  categoryId: string;
  serviceId: string | null;
  action: CatalogueChangeAction;
  details: { from?: number; to?: number; name?: string };
  createdAt: string;
  serviceName: string | null;
  adminName: string | null;
}

export interface AdminCatalogue {
  categories: AdminCategory[];
  services: Service[];
  proSharePct: number;
  appUrl: string;
  changes: CatalogueChange[];
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

export type PayoutInterval = 'weekly' | 'biweekly' | 'monthly';

export interface PlatformSettings {
  serviceFeeCents: number;
  commissionPct: number;
  proSharePct: number;
  payoutInterval: PayoutInterval;
  /** "YYYY-MM-DD" */
  nextPayoutOn: string;
  freeCancelHours: number;
  chargeDelayHours: number;
}

export interface Zone {
  code: string;
  name: string;
  lat: number;
  lng: number;
  live: boolean;
  pros: number;
  bookingsPerWeek: number;
  waiting: number;
}

export type MessageKind =
  | 'booking_confirmed'
  | 'booking_reminder'
  | 'pro_on_the_way'
  | 'extra_requested'
  | 'job_completed'
  | 'rating_request'
  | 'job_offer'
  | 'payout_sent';
export type Channel = 'push' | 'sms' | 'email';

export interface NotificationSettings {
  messages: { kind: MessageKind; audience: 'customer' | 'pro'; push: boolean; sms: boolean; email: boolean }[];
  ready: Record<Channel, boolean>;
  me: { phone: string | null; email: string | null; push: boolean };
}

export interface TeamMember {
  id: string;
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: AdminRole;
  createdAt: string;
  invitedAt: string | null;
  disabled: boolean;
  pending: boolean;
  lastActive: string | null;
}

export interface ActivityEntry {
  id: string;
  area: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
  subject: string | null;
  adminName: string | null;
  adminFullName: string | null;
}

export interface ProPayouts {
  sharePct: number;
  interval: PayoutInterval;
  nextPayoutOn: string;
  bankLast4: string | null;
}
