import type { UploadKind } from '../../../api/types';

/** Where the pro Profile's pages live (D100). Availability and Earnings are pages of their own (D99). */
export const PRO_PROFILE_PATHS = {
  profile: '/pro/profile',
  personal: '/pro/profile/personal',
  work: '/pro/profile/work',
  availability: '/pro/availability',
  documents: '/pro/profile/documents',
  bank: '/pro/profile/bank',
  ratings: '/pro/profile/ratings',
  performance: '/pro/profile/performance',
  notifications: '/pro/profile/notifications',
  help: '/pro/profile/help',
  terms: '/pro/profile/terms',
  earnings: '/pro/earnings',
} as const;

/** GET /pro/profile/overview: the numbers on the Profile rows and in the header. */
export interface ProfileOverview {
  jobsDone: number;
  documents: { expiring: number; expired: number; checking: number };
  bankLast4: string | null;
  topPercent: number | null;
}

export type DocumentStatus = 'valid' | 'expiring' | 'checking' | 'expired' | 'missing';

/** GET /pro/documents: one uploaded document as the pro sees it. */
export interface ProDocumentView {
  kind: UploadKind;
  status: DocumentStatus;
  /** "YYYY-MM-DD": the new copy's date while it is being checked, otherwise the date the pro is covered until. */
  expiresOn: string | null;
  expires: boolean;
  fileName: string | null;
  notAccepted: boolean;
  reviewNote: string | null;
  required: boolean;
}

export type PayoutInterval = 'weekly' | 'biweekly' | 'monthly';

/** GET /pro/bank. */
export interface BankSummary {
  hasPayoutAccount: boolean;
  payoutsEnabled: boolean;
  bank: { last4: string; holderName: string | null; active: boolean } | null;
  bankError: boolean;
  interval: PayoutInterval;
  nextPayoutOn: string;
  nextPayoutCents: number;
  statementYears: number[];
  defaultStatementYear: number;
}

export interface ReviewSummary {
  average: number | null;
  count: number;
  stars: { stars: number; count: number; pct: number }[];
  tags: { tag: string; count: number }[];
}

export interface Review {
  bookingId: string;
  stars: number;
  tags: string[];
  review: string | null;
  customerName: string | null;
  createdAt: string;
  reply: string | null;
  repliedAt: string | null;
}

/** GET /pro/reviews. */
export interface ReviewsPage {
  summary: ReviewSummary;
  reviews: Review[];
  hasMore: boolean;
  replyMaxLength: number;
}

export interface Metric {
  value: number | null;
  goal: number;
  belowGoal: boolean;
  basis: number;
}

/** GET /pro/performance. */
export interface Performance {
  windowDays: number;
  acceptance: Metric;
  onTime: Metric;
  completion: Metric;
  lateCancellations: { value: number; limit: number; belowGoal: boolean };
  rating: Metric;
  rank: { trade: string; pros: number; topPercent: number | null } | null;
}
