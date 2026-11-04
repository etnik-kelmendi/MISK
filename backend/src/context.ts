import type { Pool } from 'pg';
import type { CodeDelivery } from './auth/phone-sign-in.js';
import type { Guards } from './auth/guard.js';
import type { Config } from './config.js';
import type { PaymentGateway } from './payments/gateway.js';
import type { FileStorage } from './uploads/storage.js';

/** What every route module needs. Built once in `buildApp`. */
export interface AppContext {
  config: Config;
  pool: Pool;
  guards: Guards;
  gateway: PaymentGateway;
  deliverCode: CodeDelivery;
  storage: FileStorage;
}
