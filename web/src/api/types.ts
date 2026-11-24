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
export type AdminArea = 'overview' | 'bookings' | 'providers' | 'users' | 'plans' | 'catalogue' | 'fees' | 'zones' | 'notifications' | 'team';

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
  /** What the pro ticks off on the job (D86); none means the service itself is the one task. */
  tasks?: string[];
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  icon: IconName;
  approvedPros: number;
  /** Whether pros of this trade must upload a trade certificate (D93); cleaning needs none. */
  needsCertificate?: boolean;
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
  /** Only when a pro was picked on Home (D89): whether that pro is free and online at this time. */
  preferredFree?: boolean;
}

/** A saved address of the customer (D89). */
export interface SavedAddress {
  id: string;
  label: string | null;
  address: string;
  postcode: string;
  /** For the pro, e.g. "Gate code 4411"; null when there are none (D92). */
  notes: string | null;
  /** The zone's name, e.g. "Mitte". */
  areaName: string;
  /** False when the team paused the zone since the address was saved. */
  served: boolean;
  selected: boolean;
  createdAt: string;
}

export interface HomeTrade {
  id: string;
  slug: string;
  name: string;
  icon: IconName;
}

/** A pro as Home shows them (D89): first name only. */
export interface HomePro {
  id: string;
  firstName: string | null;
  photoId: string | null;
  /** Published trades in the team's order; the first is the one Home books. */
  trades: HomeTrade[];
  ratingAverage: number | null;
  ratingCount: number;
  jobsDone: number;
  isFavourite: boolean;
}

/** GET /home (D89): the plans banner and "Top rated near you" for the selected address. */
export interface HomeData {
  plan: { id: string; name: string; categoryId: string; fromCents: number } | null;
  pros: HomePro[];
}

/** A favourite pro (D83), with the trades they can be booked in now (D89). */
export interface FavouritePro {
  id: string;
  firstName: string | null;
  photoId: string | null;
  ratingAverage: number | null;
  ratingCount: number;
  jobsDone: number;
  trades: HomeTrade[];
  savedAt: string;
}

export type BookingStatus =
  'awaiting_payment' | 'searching' | 'unassigned' | 'accepted' | 'on_the_way' | 'working' | 'completed' | 'cancelled';

export type ExtraStatus = 'pending' | 'awaiting_payment' | 'approved' | 'declined' | 'cancelled';

export interface Extra {
  id: string;
  description: string;
  priceCents: number;
  /** How long the extra work takes (D83); null for requests from before. */
  durationMinutes?: number | null;
  status: ExtraStatus;
  createdAt: string;
  /** 'waiting': paid waiting at a locked door (D94), a line nobody approves; 'work' otherwise. */
  kind?: 'work' | 'waiting';
  /** Who pays a line (D94): MISK pays waiting time the customer's card refused. Only the pro and the team see it. */
  fundedBy?: 'customer' | 'misk';
}

/** A customer no-show (D94): the pro left with the call-out fee. */
export interface NoShow {
  at: string;
  chargeCents: number;
  waitingCents: number;
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
  /** Problem photos are only sent to the customer who took them and to the MISK team. */
  photos: { id: string; kind: 'customer' | 'completion' | 'problem' }[];
  extras: Extra[];
  rating: { stars: number; tags: string[]; review?: string | null } | null;
  /** The job's checklist (D86): the booked services' tasks, then approved extra work. */
  tasks?: JobTask[];
  /** Set when the customer was not home and the pro left with the call-out fee (D94). */
  noShow?: NoShow | null;
}

/** One line of a job's checklist (D86). */
export interface JobTask {
  key: string;
  label: string;
  done: boolean;
}

/** One item of the MISK price list a pro picks extra work from (D86). */
export interface PriceItem {
  id: string;
  name: string;
  priceCents: number;
  durationMinutes: number;
}

export const ISSUE_REASONS = ['customer_not_home', 'no_access', 'bigger_job', 'unsafe', 'other'] as const;
export type IssueReason = (typeof ISSUE_REASONS)[number];
export const PRO_CANCEL_REASONS = ['ill', 'vehicle', 'family', 'double_booked', 'other'] as const;
export type ProCancelReason = (typeof PRO_CANCEL_REASONS)[number];
export const CUSTOMER_RATING_TAGS = ['easy_access', 'clear_instructions', 'friendly', 'on_time'] as const;
export type CustomerRatingTag = (typeof CUSTOMER_RATING_TAGS)[number];

export interface ProSummary {
  id: string;
  firstName: string | null;
  ratingAverage: number | null;
  ratingCount: number;
  phone?: string | null;
  /** The pro's profile photo (D83); initials are shown without one. */
  photoId?: string | null;
  /** Finished bookings and plan visits (D83). */
  jobsDone?: number;
  /** Whether the customer saved this pro as a favourite (D83). */
  isFavourite?: boolean;
}

/** When the pro is expected (D83): from their live position while on the way, else the booked start. */
export interface Arrival {
  expectedAt: string;
  lateMinutes: number;
  source: 'live' | 'booked';
  proPosition?: { lat: number; lng: number; at: string };
  destination: { lat: number; lng: number } | null;
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
  /** The pro picked on Home, who was offered the job first (D89). */
  preferredPro?: { id: string; firstName: string | null } | null;
  /** Set while a pro is booked and has not arrived yet (D83). */
  arrival?: Arrival | null;
  /** The pro is more than 30 minutes late, so cancelling is free (D83). */
  freeCancelProLate?: boolean;
  canCancel: boolean;
  canRate: boolean;
  canReportProblem: boolean;
  /** What cancelling now would cost: set when a pro is booked and the start is less than 24 hours away. */
  lateCancelCents: number | null;
  lateCancel: boolean;
  /** The visit's services (D68): the free times are looked up for them. */
  services: { id: string; name: string; priceCents: number; durationMinutes: number }[];
  /** Free to move until 24 hours before the start, unless the pro has set off (D75). */
  canReschedule: boolean;
  tip: { amountCents: number; proCents: number; status: 'pending' | 'captured' | 'failed' } | null;
  canTip: boolean;
  /** Chat messages from the pro the customer has not opened yet (D67). */
  unreadMessages?: number;
  /** A flexible booking (D70): its window, whether the pro has picked the time, and by when they must. */
  flexibleWindow?: 'morning' | 'afternoon' | 'any' | null;
  timeConfirmed?: boolean;
  confirmBy?: string | null;
  /** The pro asked MISK support for help on site (D86). */
  proIssueOpen?: boolean;
  /** The call-out fee a customer who is not home pays (D94), from Settings. */
  callOutFeeCents?: number;
}

export interface ProJob extends BookingBase {
  /** The customer's stars from earlier pros (D86); null for a customer nobody has rated yet. */
  customer: { firstName: string | null; ratingAverage?: number | null; ratingCount?: number };
  earningsCents: number;
  /** The pro's share of the job and of extra work, in percent (D86). */
  proSharePct?: number;
  /** Chat messages from the customer the pro has not opened yet. */
  unreadMessages?: number;
  /** An issue this pro reported that MISK support has not resolved yet (D86). */
  openIssue?: { id: string; reason: IssueReason; createdAt: string } | null;
  /** The pro can give the job back until work starts; under 24 hours before the start it is late (D86). */
  canCancel?: boolean;
  cancelIsLate?: boolean;
  /** The pro's private rating of the customer (D86), with an optional comment (D94). */
  customerRating?: { stars: number; tags: CustomerRatingTag[]; comment?: string | null } | null;
  canRateCustomer?: boolean;
  /** "Unsafe to work" was reported: the job is stopped until MISK support resolves it (D94). */
  stopped?: boolean;
  /** From this moment the pro can leave with the call-out fee (D94); null without a door report. */
  leaveAt?: string | null;
  noShowWaitMinutes?: number;
  callOutFeeCents?: number;
  /** The day the earnings reach the pro's bank, YYYY-MM-DD (D94); null until the job is done. */
  payoutOn?: string | null;
}

/** Working hours, holidays and whether offers come in right now (D94). */
export type AutoOfflineReason = 'holiday' | 'day_off' | 'outside_hours';
export interface ProAvailability {
  /** "HH:MM"; the end may be "24:00". */
  workStart: string;
  workEnd: string;
  holidays: { id: string; startsOn: string; endsOn: string }[];
  onlineNow: boolean;
  /** Why the pro is offline although the switch is on; `until` is the last holiday day. */
  autoOffline: { reason: AutoOfflineReason; until: string | null } | null;
  overrideUntil: string | null;
}

/** "You cancelled this job" on the Jobs page (D94). */
export interface ProCancellation {
  id: string;
  bookingId: string;
  reason: ProCancelReason;
  note: string | null;
  late: boolean;
  createdAt: string;
  serviceName: string;
  startsAt: string;
  /** First name of the pro the job was offered to next, or null while MISK is still finding one. */
  nextProName: string | null;
}

/** What the team sees about a customer in the booking and plan visit panels. */
export interface CustomerProfile {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  signIn: 'phone' | 'email';
  emailConfirmed: boolean;
  memberSince: string;
  disabled: boolean;
  bookings: { total: number; completed: number; cancelled: number; upcoming: number };
  spentCents: number;
  tipsCents: number;
  activePlans: string[];
  ratingsGiven: number;
  averageStarsGiven: number | null;
  problemsReported: number;
  /** How pros rated this customer after jobs (D86). */
  proRatingAverage?: number | null;
  proRatingCount?: number;
  lateCancellations: number;
  lastBookingAt: string | null;
}

export interface AdminBooking extends BookingBase, Money {
  pro: ProSummary | null;
  /** The pro the customer picked on Home, who was offered the job first (D89). */
  preferredPro?: { id: string; firstName: string | null } | null;
  cancelledBy: string | null;
  proSharePct: number;
  customer: { id: string; firstName: string | null; phone: string | null };
  customerProfile: CustomerProfile | null;
  offers: { id: string; proId: string; proName: string | null; status: string; offeredAt: string; expiresAt: string }[];
  payouts: { amountCents: number; status: string; error: string | null; createdAt: string }[];
  actions: AdminAction[];
  split: { proCents: number; miskCents: number };
  /** The team confirmed this pro, so the assignment is final until the pro gives the job back (D88). */
  assignmentLocked: boolean;
  assignmentLockedAt: string | null;
  /** Who confirmed it. */
  assignmentLockedBy: string | null;
  /** Issues the pro reported on site (D86), newest first. */
  issues?: AdminIssue[];
  /** The pro's private rating of the customer (D86). */
  customerRating?: { stars: number; tags: CustomerRatingTag[]; createdAt: string } | null;
  /** Pros who gave this job back (D86), newest first. */
  proCancellations?: { proName: string | null; reason: ProCancelReason; note: string | null; late: boolean; createdAt: string }[];
}

export interface AdminIssue {
  id: string;
  proId: string;
  proName: string | null;
  reason: IssueReason;
  details: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export type AdminActionKind =
  | 'assigned'
  | 'restarted_search'
  | 'rescheduled'
  | 'cancelled'
  | 'refunded'
  | 'charged_after_problem'
  | 'pro_cancelled'
  | 'issue_reported'
  | 'issue_resolved'
  // On site (D94): the customer was not home, waiting at a locked door was paid, the customer was told the pro runs late.
  | 'no_show'
  | 'waiting_paid'
  | 'late_warning';

/** One change the team made to a booking. */
export interface AdminAction {
  id: string;
  action: AdminActionKind;
  details: {
    proName?: string | null;
    from?: string;
    to?: string;
    amountCents?: number;
    wasCharged?: boolean;
    /** Why the team cancelled, and whether the customer was sent it (D63). */
    note?: string;
    sentToCustomer?: boolean;
    /** Why the pro cancelled or what they reported (D86). */
    reason?: string;
    late?: boolean;
    /** The pro gave back a job the team had confirmed them on, so the team can choose again (D88). */
    assignmentUnlocked?: boolean;
    /** On site (D94): what a no-show charged and paid, waiting time and who paid it, how late the pro was. */
    chargeCents?: number;
    proCents?: number;
    cents?: number;
    fundedBy?: 'customer' | 'misk';
    lateMinutes?: number;
  };
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
  customerProfile: CustomerProfile | null;
  pro: { id: string; firstName: string | null; phone: string | null };
  /** The customer's pause that called this visit off (D78). */
  pause?: { startsOn: string; endsOn: string; creditCents: number; visitsCalledOff: number } | null;
  perVisitCents: number;
  proMonthlyCents: number;
  miskMonthlyCents: number;
}

export interface PaymentStep {
  clientSecret: string;
  publishableKey: string | null;
  /**
   * What the browser does with the secret: 'payment' (the default) pays or holds money; 'setup' only saves the card,
   * for a plan whose first month is charged on its first visit day (D91).
   */
  confirm?: 'payment' | 'setup';
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
  // The Bookings page (D67).
  endsAt?: string;
  /** Where the job is: Job details starts from the last one (D69). */
  address?: string;
  postcode?: string;
  /** Set while a flexible booking waits for its pro to pick the time (D70). */
  flexibleWindow?: 'morning' | 'afternoon' | 'any' | null;
  completedAt?: string | null;
  paymentStatus?: PaymentStatus;
  hasReceipt?: boolean;
  canReportProblem?: boolean;
  problemOpen?: boolean;
  canReschedule?: boolean;
  unreadMessages?: number;
  categorySlug?: string;
  categoryIcon?: IconName;
  categoryActive?: boolean;
}

/** A coming visit of one of the customer's plans, on the Upcoming tab. */
export interface PlanVisitItem {
  id: string;
  startsAt: string;
  endsAt: string;
  subscriptionId: string;
  planName: string;
  categoryId: string;
  categoryIcon: IconName;
  proName: string | null;
}

/** One message in the chat between customer and pro of a booking (D67). */
export interface ChatMessage {
  id: string;
  from: 'customer' | 'pro';
  /** Null for a photo sent without text (D83). */
  body: string | null;
  photoId?: string | null;
  createdAt: string;
  readAt: string | null;
}

export type ReceiptState = 'paid' | 'charging' | 'on_hold' | 'refunded' | 'released' | 'unpaid';

export interface Receipt {
  number: string;
  bookingNumber: string;
  date: string;
  serviceName: string;
  proName: string | null;
  address: string;
  lines: { label: string; cents: number; kind: 'job' | 'discount' | 'extra' | 'fee' | 'tip' }[];
  totalCents: number;
  state: ReceiptState;
  chargeAt: string | null;
  /** How the customer paid (D83), e.g. label "Apple Pay · Visa •••• 4242". */
  paymentMethod?: { brand: string; last4: string | null; wallet: string | null; label: string } | null;
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
  /** A flexible job (D70): its window, and the starts this pro is free for, one of which they pick. */
  flexibleWindow?: 'morning' | 'afternoon' | 'any' | null;
  startOptions?: string[] | null;
  /** The customer's stars from earlier pros (D86). */
  customerRating?: number | null;
  /** How long the job takes, in minutes (D94). */
  durationMinutes?: number;
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
/** Documents the pro uploads; the background check is a consent and the partner's result, never a file (D93). */
export type UploadKind = 'id' | 'certificate' | 'insurance';
export const UPLOAD_KINDS: UploadKind[] = ['id', 'certificate', 'insurance'];

export type ProStatus = 'draft' | 'submitted' | 'info_requested' | 'approved' | 'pending_approval' | 'rejected' | 'suspended';
export type CheckState = 'missing' | 'waiting_review' | 'rejected' | 'expired' | 'expiring' | 'valid';

export interface ProDocument {
  /** Null for the background check, which has no file (D93). */
  uploadId: string | null;
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
  /** The pro's profile photo, shown to their customers (D83). */
  photoId?: string | null;
  trades: string[];
  /** The Jobs page (D86): the online switch, the trades by name and a pause after late cancellations. */
  online?: boolean;
  tradeNames?: string[];
  offersPausedUntil?: string | null;
  documents: Record<DocumentKind, (ProDocument & { state: CheckState }) | null>;
  /** The application (D93). The home address is private: only the pro and the MISK team see it. */
  homeAddress?: string | null;
  backgroundConsentAt?: string | null;
  submittedAt?: string | null;
  /** Documents the team asked for again; each gets an upload button on the status page. */
  requestedDocuments?: UploadKind[];
  rejectedAt?: string | null;
  /** The day a turned-down applicant can apply again, YYYY-MM-DD. */
  reapplyOn?: string | null;
  /** Whether the pro can still change and send the application. */
  editable?: boolean;
  /** False when every chosen trade needs no trade certificate. */
  certificateRequired?: boolean;
  /** Working hours, holidays and whether offers come in right now (D94). */
  availability?: ProAvailability;
}

export type ApplicationStepKey = 'sent' | 'documents' | 'background' | 'decision';
export type ApplicationStepState = 'done' | 'current' | 'attention' | 'failed' | 'upcoming';

/** GET /pro/application: the Application status page (D93). */
export interface ApplicationView {
  profile: ProProfile;
  timeline: { steps: { key: ApplicationStepKey; state: ApplicationStepState }[]; current: ApplicationStepKey } | null;
  support: { email: string | null; phone: string | null };
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
  /** False for a trade certificate the pro's trades do not need (D93). */
  required?: boolean;
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
  | 'back_to_active'
  | 'info_provided';

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
  /** Private: shown to the team only (D93). */
  homeAddress?: string | null;
  backgroundConsentAt?: string | null;
  requestedDocuments?: UploadKind[];
  rejectedAt?: string | null;
  certificateRequired?: boolean;
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

export const OVERVIEW_PERIODS = ['1', '7', '30'] as const;
export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number];

export interface Overview {
  days: number;
  /** The city MISK serves, and its time zone. */
  city: string;
  timezone: string;
  kpis: {
    bookings: number;
    previousBookings: number;
    /** Change against the previous period in percent; null when that period had none. */
    bookingsChangePct: number | null;
    completed: number;
    activeSubscriptions: number;
    newSubscriptions: number;
    grossCents: number;
    previousGrossCents: number;
    grossChangePct: number | null;
    payoutCents: number;
    miskShareCents: number;
    ratingAverage: number | null;
    ratingCount: number;
    /** Share of jobs finished in the period whose work started on time; null without finished jobs. */
    onTimePct: number | null;
  };
  /** Monday of each week, oldest first; the last one is the current week. */
  weekly: { week: string; oneOff: number; visits: number; bookings: number }[];
  attention: { pendingApplications: number; unassigned: number; unreleasedHolds: number; failedPayouts: number };
}

/** A booking or plan visit in the overview's live table. */
export interface LiveBooking {
  kind: 'booking' | 'visit';
  id: string;
  number: string;
  startsAt: string;
  endsAt: string;
  service: string;
  customer: string | null;
  address: string;
  postcode: string;
  pro: string | null;
  status: BookingStatus | VisitStatus;
  valueCents: number;
  problem: boolean;
  tab: 'needs_action' | 'live' | 'upcoming' | 'done';
}

export interface OverviewApplication {
  id: string;
  firstName: string | null;
  lastName: string | null;
  trades: string[];
  documentsUploaded: number;
  documentsTotal: number;
  /** All four checks are OK, so the pro can be approved from the overview. */
  ready: boolean;
}

export interface OverviewLive {
  bookings: LiveBooking[];
  /** Null for team members who may not open Providers. */
  applications: { waiting: number; pros: OverviewApplication[] } | null;
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
  /** The pro reported an issue on site that the team has not resolved (D86). */
  proIssue?: boolean;
  /** A pro reported "Unsafe to work": the top of Needs action (D94). */
  urgent?: boolean;
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
  /** Asked for an account on the control panel, or signed up with an invitation link, and not yet approved. */
  pending: boolean;
  /** The role asked or invited for; the approving admin may change it (D84). */
  adminRole: AdminRole | null;
  /** Set when the account was made with an invitation link. */
  invitedAt: string | null;
  createdAt: string;
  disabled: boolean;
}

export type Frequency = 'every_2_weeks' | 'weekly' | 'twice_weekly' | 'three_times_weekly';

/** The minimum terms a plan can have, in months (D77). */
export const MIN_TERMS = [1, 3, 6, 12] as const;
export type MinTerm = (typeof MIN_TERMS)[number];

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
  /** 1, 3, 6 or 12 (D77). */
  minTermMonths: MinTerm;
  /** Notice needed before a pause starts, 0 to 30 days (D77, D85). */
  pauseNoticeDays: number;
  /** Most paused weeks a year, 0 to 8; 0 means the plan cannot be paused (D77, D85). */
  maxPauseWeeks: number;
  proSharePct: number;
}

export interface Plan extends PlanInput {
  id: string;
  categoryName: string | null;
  categoryIcon: IconName | null;
  seasonFrom: number | null;
  seasonTo: number | null;
  subscribers?: number;
  /** A visit of this plan is happening right now (D66). */
  visitInProgress?: boolean;
  status: 'draft' | 'published';
  publishedAt: string | null;
  updatedAt: string;
}

/** A published plan as customers see it (D90), with the server's price of every frequency and size. */
export interface PublicPlan extends Plan {
  priceCents: number;
  /** Monthly price in cents per frequency and size, without the extra. */
  prices: Record<Frequency, Record<JobSize, number>>;
  /** The small size at the plan's own frequency: "from €…/month". */
  fromCents: number;
}

/** When the first visit of a new plan is (D90). */
export type PlanStart = 'asap' | 'next_week' | 'in_2_weeks';

export type TimeWindow = 'morning' | 'afternoon';
export type SubscriptionStatus = 'awaiting_payment' | 'active' | 'past_due' | 'cancelled';
export type VisitStatus = 'planned' | 'skipped' | 'completed' | 'cancelled';

export interface SubscriptionVisit {
  id: string;
  startsAt: string;
  endsAt: string;
  status: VisitStatus;
  tasksDone: string[];
  /** Where a moved visit was first planned (D77). */
  movedFrom: string | null;
  /** A move the customer asked for that the pro has not answered yet. */
  pendingMove: { toStartsAt: string; toEndsAt: string; respondBy: string } | null;
  /** The pause that called this visit off (D78); absent or null when it was not paused. */
  pausedBy?: string | null;
  /** When the customer skipped it (D90). */
  skippedAt?: string | null;
  /** Skipped visits of the plan in this visit's calendar month (D90). */
  skipsUsedInMonth?: number;
}

/** A pause of a monthly plan (D78). Days are 'YYYY-MM-DD' in the market time zone; `endsOn` is the first day after it. */
export interface SubscriptionPause {
  id: string;
  startsOn: string;
  endsOn: string;
  weeks: number;
  startsAt: string;
  endsAt: string;
  status: 'upcoming' | 'running' | 'past' | 'withdrawn';
  visitsCalledOff: number;
  visitCreditCents: number;
  creditCents: number;
  visitsRestored: number;
  reversedCents: number;
  createdAt: string;
  withdrawnAt: string | null;
}

/** What a customer can choose when pausing, or why they cannot pause now (D78). */
export interface PauseOptions {
  earliestStartOn: string | null;
  latestStartOn: string | null;
  latestEndOn: string | null;
  noticeDays: number;
  maxPauseWeeks: number;
  weeksLeftThisYear: number;
  /** Weeks left per calendar year a pause can start in, keyed by the year. */
  weeksLeft: Record<string, number>;
  visitCreditCents: number;
  /** The times of the visits a pause could call off. */
  visitStarts: string[];
  reason: 'not_active' | 'pause_already_planned' | 'no_weeks_left' | 'plan_ending' | 'pauses_not_allowed' | null;
}

/** The days a visit can move to, or why it cannot move (D77). */
export interface VisitMoveOptions {
  options: { startsAt: string; endsAt: string }[];
  /** The nearby days, each saying whether the pro is free then (D90); only free ones can be asked for. */
  days?: { startsAt: string; endsAt: string; free: boolean }[];
  reason: 'not_movable' | 'too_late' | 'move_pending' | 'no_free_day' | null;
}

/** A customer's request to move a visit, waiting for the pro (D77). */
export interface ProVisitMove {
  id: string;
  visitId: string;
  subscriptionId: string;
  planName: string;
  customerName: string | null;
  address: string;
  postcode: string;
  fromStartsAt: string;
  fromEndsAt: string;
  toStartsAt: string;
  toEndsAt: string;
  respondBy: string;
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
  minTermMonths: number;
  pauseNoticeDays: number;
  maxPauseWeeks: number;
  status: SubscriptionStatus;
  billingPaused: boolean;
  startedAt: string | null;
  currentPeriodEnd: string | null;
  endsAt: string | null;
  createdAt: string;
  proName: string | null;
  cancelableFrom: string | null;
  categoryIcon?: IconName | null;
  /** The first visit's day, 'YYYY-MM-DD' (D90); null for plans from before it was kept. */
  firstVisitOn?: string | null;
  /** The next visit still to come, or null. */
  nextVisitAt?: string | null;
  /** When billing starts: the first visit day, or sign-up when the first month was charged at once (D91). */
  billingStartsAt?: string | null;
  /** When the minimum term ends, counted from when billing starts (D90, D91). */
  minTermEndsAt?: string;
  /** When the plan would end if cancelled now: the minimum term's end or 30 days' notice, whichever is later (D90). */
  cancelEndsAt?: string;
  /** At most this many skipped visits a calendar month (D90). */
  skipsPerMonth?: number;
  skipsLeftThisMonth?: number;
  /** The card or wallet the plan is billed to; only on a single plan (D90). */
  paymentMethod?: { brand: string; last4: string | null; wallet: string | null } | null;
  visits: SubscriptionVisit[];
  /** Newest first (D78). */
  pauses: SubscriptionPause[];
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
  /** What a customer who is not home pays the pro, and the most waiting at a door paid (D94). */
  noShowFeeCents: number;
  waitingCapMinutes: number;
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

/** A message MISK sent a customer or pro, as listed under Messages in the app. */
export interface InboxMessage {
  id: string;
  kind: string;
  body: string;
  /** The page of the app the message is about, e.g. a booking's chat (D83). */
  link?: string | null;
  read: boolean;
  createdAt: string;
}

export interface Inbox {
  messages: InboxMessage[];
  unread: number;
}

/** The cheap check the app makes often: how many messages are unread, and which is newest (D87). */
export interface InboxUnread {
  unread: number;
  newestId: string | null;
}
