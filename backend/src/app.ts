import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Pool } from 'pg';
import { adminAccountRoutes } from './auth/admin-accounts.js';
import { emailAccountRoutes } from './auth/email-accounts.js';
import { createGuards } from './auth/guard.js';
import type { CodeDelivery } from './auth/phone-sign-in.js';
import { authRoutes } from './auth/routes.js';
import { adminBookingRoutes } from './bookings/admin-routes.js';
import { customerBookingRoutes } from './bookings/customer-routes.js';
import { proJobRoutes } from './bookings/pro-routes.js';
import { catalogueRoutes } from './catalogue/routes.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { ApiError } from './errors.js';
import type { EmailSender } from './notifications/email.js';
import { messages } from './notifications/messages.js';
import type { SmsSender } from './notifications/sms.js';
import type { PaymentGateway } from './payments/gateway.js';
import { paymentRoutes, WEBHOOK_PATH } from './payments/routes.js';
import { planRoutes } from './plans/routes.js';
import { proRoutes } from './pros/routes.js';
import { createDiskStorage, MAX_UPLOAD_BYTES, type FileStorage } from './uploads/storage.js';
import { uploadRoutes } from './uploads/uploads.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AppDependencies {
  config: Config;
  pool: Pool;
  gateway: PaymentGateway;
  sms: SmsSender | null;
  email?: EmailSender | null;
  storage?: FileStorage;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp({ config, pool, gateway, sms, email = null, storage, logger = false }: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger,
    trustProxy: config.trustProxy,
    bodyLimit: 16 * 1024,
    // Reject malformed input instead of silently converting it or dropping unknown fields.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });

  // Sign-in codes go out at once rather than through the outbox: the person is waiting for them.
  const deliverCode: CodeDelivery = async (phone, code) => {
    if (sms) {
      try {
        await sms(phone, messages.signInCode(code));
      } catch (error) {
        app.log.error({ event: 'sign_in_code_not_sent', err: error });
        throw new ApiError(502, 'sms_unavailable');
      }
      return;
    }
    // Only reachable outside production: config refuses to start production without Twilio (D10).
    app.log.warn({ event: 'sign_in_code_not_sent', phone, code }, 'SMS is not set up; sign-in code written to the log');
  };

  // Without a mail server, development writes emails to the log; production cannot send them at all.
  const deliverEmail: AppContext['deliverEmail'] = email
    ? email
    : config.production
      ? null
      : async (message) => {
          app.log.warn({ event: 'email_not_sent', ...message }, 'Email is not set up; email written to the log');
        };

  const ctx: AppContext = {
    config,
    pool,
    gateway,
    deliverCode,
    deliverEmail,
    guards: createGuards(pool),
    storage: storage ?? createDiskStorage(config.uploadDir),
  };

  await app.register(cookie);
  await app.register(cors, {
    origin: config.webOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT'],
  });
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 },
    throwFileSizeLimit: true,
  });

  // Browsers always send Origin on these requests, so a missing or foreign one is not the MISK web app.
  // Stripe's webhook comes from a server and is checked by its signature instead.
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method) || request.url === WEBHOOK_PATH) {
      return;
    }
    if (request.headers.origin !== config.webOrigin) {
      return reply.code(403).send({ error: 'forbidden_origin' });
    }
  });

  app.setErrorHandler((error: { statusCode?: number; validation?: unknown; code?: string }, request, reply) => {
    if (error instanceof ApiError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error }, error.code);
      }
      return reply.code(error.statusCode).send({ error: error.code });
    }
    if (error.validation) {
      return reply.code(400).send({ error: 'validation_failed' });
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: 'internal_error' });
    }
    if (status === 413) {
      return reply.code(413).send({ error: 'file_too_large' });
    }
    if (error.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
      return reply.code(400).send({ error: 'file_missing' });
    }
    return reply.code(status).send({ error: 'request_failed' });
  });

  app.get('/health', async (request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch (error) {
      request.log.error(error, 'Database health check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  for (const routes of [
    authRoutes,
    emailAccountRoutes,
    adminAccountRoutes,
    catalogueRoutes,
    planRoutes,
    proRoutes,
    customerBookingRoutes,
    proJobRoutes,
    adminBookingRoutes,
    uploadRoutes,
    paymentRoutes,
  ]) {
    await app.register(routes, ctx);
  }

  return app;
}
