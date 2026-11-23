import type { Pool } from 'pg';
import type { CodeDelivery } from './auth/phone-sign-in.js';
import type { Guards } from './auth/guard.js';
import type { Config } from './config.js';
import type { EmailMessage } from './notifications/email.js';
import type { Channel } from './notifications/outbox.js';
import type { PaymentGateway } from './payments/gateway.js';
import type { FileStorage } from './uploads/storage.js';

/** What every route module needs. Built once in `buildApp`. */
export interface AppContext {
  config: Config;
  pool: Pool;
  guards: Guards;
  gateway: PaymentGateway;
  deliverCode: CodeDelivery;
  /** Sends an email; null when email is not set up in production. */
  deliverEmail: ((message: EmailMessage) => Promise<void>) | null;
  storage: FileStorage;
  /** Whether the server can send on each channel; a message queued on one that is not set up is kept as not sent. */
  channelsReady: Record<Channel, boolean>;
}
