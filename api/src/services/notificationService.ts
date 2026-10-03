/**
 * Module 2 + 4 — Notification Service.
 *
 * Sends student credential emails using Nodemailer with SMTP env or a JSON-log fallback.
 * IMPORTANT: Only emailWorker.ts calls send*. Do NOT call these inline in request handlers.
 * Plaintext password never logged.
 */
import nodemailer, { Transporter } from "nodemailer";
import logger from "../config/logger";

interface StudentCredentialsPayload {
  to: string;
  matricNumber: string;
  password: string; // plaintext — do not log
  firstName?: string;
  lastName?: string;
}

let _transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (_transporter) return _transporter;
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM ?? "University Bursary <noreply@university.example>";
  if (host) {
    _transporter = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: String(process.env.SMTP_SECURE) === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" }
        : undefined,
    });
    logger.info("[notify] using real SMTP transport", { host, from });
  } else {
    // Fallback JSON transport — emails logged but not sent. Good for dev/test.
    _transporter = nodemailer.createTransport({ jsonTransport: true });
    logger.info("[notify] no SMTP_HOST — using JSON log transport");
  }
  return _transporter;
}

function renderCredentialsHtml(p: StudentCredentialsPayload): string {
  const greeting = `Dear ${p.firstName ?? "Student"} ${p.lastName ?? ""},`.trim();
  return `
  <div style="font-family: sans-serif; line-height:1.5; max-width:620px; margin:0 auto;">
    <h2>University Payment Gateway — Account Created</h2>
    <p>${greeting}</p>
    <p>Your student portal account has been created. Use the credentials below to sign in and then change your password at first login.</p>
    <table style="border-collapse:collapse; width:100%;">
      <tr><td style="padding:6px; width:35%; background:#f3f4f6;"><strong>Matric Number</strong></td><td style="padding:6px;">${p.matricNumber}</td></tr>
      <tr><td style="padding:6px; background:#f3f4f6;"><strong>Password</strong></td><td style="padding:6px; font-family:monospace;">${p.password}</td></tr>
    </table>
    <p style="margin-top:16px; color:#374151;">After login you will be required to change your password.</p>
    <p style="color:#6b7280; font-size:13px;">If you did not request this account, please ignore this email.</p>
  </div>`;
}

function renderCredentialsText(p: StudentCredentialsPayload): string {
  return [
    "University Payment Gateway — Account Created",
    "",
    `Matric Number: ${p.matricNumber}`,
    `Password: ${p.password}`,
    "",
    "After login you will be required to change your password.",
  ].join("\n");
}

export async function sendStudentCredentials(payload: StudentCredentialsPayload): Promise<void> {
  const t = getTransporter();
  const info = await t.sendMail({
    from: process.env.SMTP_FROM ?? "University Bursary <noreply@university.example>",
    to: payload.to,
    subject: `University Account — ${payload.matricNumber}`,
    text: renderCredentialsText(payload),
    html: renderCredentialsHtml(payload),
  });
  if ((t as any).options?.jsonTransport) {
    logger.info("[notify][json-transport] credentials email generated (NOT SENT)", {
      to: payload.to,
      matricNumber: payload.matricNumber,
      messageId: info.messageId ?? "n/a",
    });
  } else {
    logger.info("[notify] credentials email sent", {
      to: payload.to,
      matricNumber: payload.matricNumber,
      messageId: info.messageId,
    });
  }
}
