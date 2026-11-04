import nodemailer from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Sends one email. Throws when the mail server refuses or cannot be reached. */
export type EmailSender = (message: EmailMessage) => Promise<void>;

export interface SmtpConfig {
  host: string;
  port: number;
  /** True for implicit TLS (usually port 465); otherwise STARTTLS is required. */
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

export function createSmtpSender(config: SmtpConfig): EmailSender {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // Never send credentials or reset links over an unencrypted connection.
    requireTLS: !config.secure,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return async (message) => {
    await transport.sendMail({ from: config.from, ...message });
  };
}
