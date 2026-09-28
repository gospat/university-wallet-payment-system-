# Resend Email Service with Automated Credential Delivery — Product Requirements

## Overview
- **Summary**: Integrate **Resend** (resend.com) as the primary email transport with a graceful **Nodemailer SMTP fallback**. When student accounts are created (single-record admin create OR bulk XLSX/CSV import workflows), systematically send each student their auto-generated login credentials (email, matriculation number, temporary password, portal login URL, force-change-password notice) using a professional configurable email template. Expose every non-static/configurable value (sender name/address, reply-to, subject line, body headline + greeting + closing, button label, portal login URL, force-password-change notice text) via DB-stored settings so ADMIN users can update them live in the Admin UI without code changes. Log every email delivery attempt to a new `EmailDeliveryLog` DB table with provider (RESEND/SMTP/MOCK), success boolean, Resend messageId, error messages, retry count, IP, idempotency key; retry failed deliveries up to 3 times with backoff; support admin-visible "Recent Deliveries" list + status filters. Run comprehensive smoke tests for single student creation (1 email) and bulk import (10 students, 10 emails) to verify reliable delivery.
- **Target Users**: Admin (config editor, delivery log viewer, creates single/bulk students), Bursary (views delivery log, triggers manual resend), Students (receivers of credential email on account creation), DevOps (env/Resend key management)
- **Purpose**: Replace hardcoded subject lines/sender strings + json-transport mock emails with real Resend delivery. Eliminate the Bursary/Admin manual "we have to tell each student their password" workflow that currently exists because the credential email is a silent jsonTransport stub. Give admin users a no-code configuration panel so the university's comms team can adjust wording without a developer.

## Goals
1. Install + configure the Resend SDK; send via Resend by default when `RESEND_API_KEY` env is present; fall back to existing SMTP (nodemailer `createTransport()`) when SMTP env is set; fall back to json-transport (dev/MOCK) when neither is configured. Update `@prisma/client` + prisma `EmailDeliveryLog` + `EmailTemplateConfig` Prisma models (DB-stored configurations).
2. Trigger credential emails automatically on BOTH creation paths:
   - SINGLE: `StudentService.create()` return → send `STUDENT_CREDENTIALS` email with the temporary password BEFORE password hash erase from memory.
   - BULK: `studentImport.ts` confirm loop validRows + created → for each created user, enqueue/send same template.
3. Admin email template config page: all editable values loaded from `EmailTemplateConfig` id=1 row + SystemSettings env fallback; values include sender, reply-to, portal URL, subject line, greeting/closing, helper texts, button label, template accent color. PATCH endpoint updates the row → writes audit log → emails sent after use the new values immediately.
4. Every email delivery attempt writes an `EmailDeliveryLog` row. Logs include `emailType: STUDENT_CREDENTIALS | RESET_PASSWORD | PAYMENT_SUCCESSFUL | BILL_ASSIGNED | PAYMENT_FAILED etc.`, status `PENDING|SENT|FAILED|RETRIED`, provider, messageId, to, recipientId, idempotency key, attempts count, lastError text, `retryAfter` DateTime, sent payload summary (never plaintext password in logs), adminId who triggered (student-import id or direct create actorId), created/updated timestamps.
5. Error handling + retries: If first send throws, log `RETRIED`, increment attempts counter, set retryAfter = now + (2^attempts min), up to max 3 attempts. BullMQ `emailQueue` worker now actually calls the new provider factory + `sendEmail` and updates delivery logs; old scaffold stub replaced.
6. Validation + Test coverage:
   - Single student create → verify 1 email enqueued, renders correct `{matric, email, tempPwd, portalBtn, forceChangeWarning}`, deliveryLog row status SENT/RESEND_MESSAGE_ID or MOCK success.
   - Bulk import 10 students → 10 EmailDeliveryLog rows created, all STUDENT_CREDENTIALS type, emailType counts match number of created rows, no duplicate temp passwords.
   - Resend API unavailable test → 3 auto retries, attempts counter increments, lastError preserved; eventually FAILED or fall back to SMTP without corrupting the DB user that was created.
   - Frozen Jest test suite (`email-secrets.test.ts`) continues to pass — no regressions on security patterns.
   - New email settings admin UI: fields save + re-load correctly on page refresh (database persistence proof).

## Non-Goals
- NOT replacing SMS/Termii SMS gateway integration (email only).
- NOT building an image asset upload widget; university logo URL is still a pasted HTTPS URL (aligned with existing branding settings pattern).
- NOT per-student-template customization (template is global, uses placeholders: `{{studentName}}`, `{{matricNumber}}`, `{{portalLoginUrl}}`, `{{temporaryPassword}}`, `{{email}}`, `{{universityName}}`, `{{buttonLabel}}`).
- NOT changing password-reset, payment-successful, or payment-reminder template LAYOUT beyond the configurable strings using the same placeholder system (reuse renderer).
- NOT adding Resend API billing/domains page into admin (config only: enable/disable Resend usage toggle, env-only for the API key).
- NOT implementing OTP matric login session (user explicitly tabled that earlier this session; we keep email+password auth).

## Background & Context
- **Current state audit at time of writing**:
  1. `nodemailer` 6.10.x installed, `@types/nodemailer` 6.4.24 installed; `resend` NOT listed in package.json.
  2. `services/email.ts` has fully-built `renderStudentAccountCreated` function with `renderPaymentSuccessful` etc. (8 templates) and `sendEmail` that uses a secret-leak guard (`checkForSecrets`) + defaults to **JSON-transport mock** when SMTP env vars are not all set (host/port/user/pass missing → no real delivery). Today credential emails are mocked — students never receive real mail.
  3. `StudentService.create()` returns the created user but password is only in memory during the function; `defaultPasswordFor(input)` logic: if caller passed a password in `CreateStudentInput`, that is the password used (bcrypt hashed at 12 rounds); else fallback is `input.matricNumber` → which means if admin creates a student without explicit password, matric number is the plaintext password sent in email. Must preserve this behavior.
  4. `controllers/admin.ts L55` and `controllers/student.ts L70` both call `StudentService.create(req.body, req.user.id, opts)` — exactly the 2 single-create paths.
  5. `services/studentImport.ts L542-554` loops validRows → `StudentService.create({...payload}, opts.actorId, {ip, userAgent, importId})` — bulk-create path; currently no email trigger after create.
  6. `EmailTemplateConfig` model does NOT exist in Prisma schema; existing `SystemSettings` has general branding + receipt + payment fields only.
  7. `EmailDeliveryLog` model does NOT exist in the schema; only a transient in-memory `sentCaptures: any[]` array in `email.ts` that resets on server restart.
  8. `bullmq` emailQueue worker in `queues/emailQueue.ts L87-L106` is a scaffold — receives job data but only logs payload, does not actually call sendEmail or update any storage; `dispatchEmail` correctly puts jobs into BullMQ when Redis available but the downstream worker never actually delivers anything today.
  9. Existing Admin UI has `pages/admin/SystemSettings.tsx`; adding a 4th configurable tab/card ("Email Templates") into that same page is natural and consistent.
  10. Frozen Jest test `__tests__/email-secrets.test.ts` must PASS unchanged; test asserts templates render without secrets and temporary passwords are in rendered output. Also frozen: health.test.ts, regression.test.ts, rbac-matrix.test.ts, idempotency.test.ts, academic-import.test.ts, reconciliation.test.ts, search-settings-notif.test.ts. (8 test suites total.)

## Functional Requirements

### FR-1: Prisma Models
1. Add new `EmailTemplateConfig` model to `api/prisma/schema.prisma` (single-row table, id=1 enforced):
   - Int id @id
   - String templateKey (unique, `'student_credentials'` default; extensible for other types later; use `@unique`)
   - String senderName max 120 nullable
   - String senderAddress max 254 nullable
   - String replyToAddress max 254 nullable
   - String portalLoginUrl max 500 nullable
   - String subjectLine max 200 nullable
   - Text greetingParagraph (long text, `@db.MediumText` for MySql) nullable
   - String buttonLabel max 60 nullable
   - Text forceChangePasswordNotice nullable MediumText
   - Text closingParagraph nullable MediumText
   - String accentColorHex max 9 nullable (e.g. `#1e40af`)
   - Int? updatedById FK user
   - DateTime createdAt default now()
   - DateTime updatedAt
   - @@unique([templateKey])
   - Relate updatedById → User model. On delete set null.
2. Add new `EmailDeliveryLog` model:
   - BigInt id @id autoincrement()
   - String emailType max 80 (indexed) → `STUDENT_CREDENTIALS | RESET_PASSWORD | PAYMENT_SUCCESSFUL | BILL_ASSIGNED | PAYMENT_FAILED | PAYMENT_REVERSED | REFUND_STATUS_CHANGED | PAYMENT_REMINDER`
   - String toAddress max 254 indexed
   - Int? recipientId FK → User
   - Int? triggeredByAdminId FK → User
   - Int? studentImportId FK → StudentImport
   - String idempotencyKey max 128 @unique indexed
   - String provider max 20 → RESEND / SMTP / MOCK
   - String status max 20 indexed → PENDING / SENT / FAILED / RETRIED
   - String resendMessageId max 200 nullable unique
   - String smtpMessageId max 200 nullable
   - Int attempts default 0
   - String lastError max 2000 nullable
   - DateTime? retryAfter
   - Json? payloadSummary (NEVER stores plaintext password; store sanitized keys-only hash like {hasPassword:true, studentNameLen:X} for debugging)
   - DateTime createdAt default now()
   - DateTime updatedAt
   - Add indexes: (emailType, status, createdAt); (recipientId); (triggeredByAdminId); (studentImportId); @@map name email_delivery_logs.
3. Append to User model: `emailDeliveriesSent EmailDeliveryLog[] @relation('EmailSentTriggeredBy', references: [id], fields: [triggeredByAdminId], onDelete: SetNull)` + inverse for recipient/studentImport relationships. Run `prisma db push` + `prisma generate`.

### FR-2: Resend Provider + Transport Factory
1. Install `resend` SDK package via api/package.json install. Add types if needed (resend has its own).
2. New `services/email/providers/` directory mirroring payment providers pattern. If providers folder does not exist, use `services/emailProviders.ts` instead for simplicity. Define:
   - `EmailProviderResult { success: boolean; messageId?: string; error?: string; }`
   - `EmailProvider` interface: `name` + `send(mail: {from, replyTo, to, subject, html, text}): Promise<EmailProviderResult>`
   - `ResendProvider` implementation: uses `new Resend(process.env.RESEND_API_KEY)`; from/replyTo/to/subject/html/text; catches errors → returns error message string.
   - `SmtpProvider` implementation: wraps existing nodemailer `createTransport` behavior (reuse current host/port/secure/user/pass env checks); returns SMTP `info.messageId` + success flag.
   - `MockJsonProvider` implementation: the fallback behavior used when `NODE_ENV === development` or NO `RESEND_API_KEY` AND NO SMTP vars all set. Writes to existing `sentCaptures` array and returns mock id `mock-<uuid>`.
   - `selectEmailProvider()` → factory that returns ResendProvider if RESEND_API_KEY non-empty, else SMTP if all SMTP vars present, else MockJson. Priority: Resend > SMTP > Mock. One changeable setting: SystemSettings `emailProviderForceSmtp` boolean can downgrade from Resend to SMTP.
3. Update `services/email.ts sendEmail()` function to invoke selectEmailProvider(). Keep the existing `checkForSecrets()` SECRET GUARD call BEFORE provider — never remove it. After provider returns:
   - If success → write EmailDeliveryLog status SENT, messageId stored, attempts += 1, payloadSummary sanitized (omit password).
   - If FAIL → write EmailDeliveryLog status FAILED or RETRIED: increment attempts; if attempts < 3 → retry backoff `setTimeout` or BullMQ delayed job; else FAILED.
4. Resend-specific env vars added to api/.env.example + current .env file section:
   - `RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
   - `RESEND_AUDIENCE_ID=` (optional)
   - Comment block explaining: "To get a Resend API key: sign up at https://resend.com → Add Domain → verify DNS → copy key. If empty, falls back to SMTP; if SMTP also empty, uses mock JSON transport (json in sentCaptures array) for local dev."

### FR-3: Configurable Renderer (EmailTemplateConfig + placeholders)
1. New `services/email/templateRenderer.ts` helper:
   - `loadTemplateConfig(templateKey: string): Promise<ResolvedTemplateConfig>` — fetches EmailTemplateConfig row where templateKey matches; falls back to env vars (`EMAIL_FROM_NAME`, `EMAIL_FROM_ADDRESS`, `EMAIL_REPLY_TO_ADDRESS`, `STUDENT_PORTAL_URL`); then falls back to sensible defaults (current hardcoded strings from email.ts today).
   - `renderWithPlaceholders(template: string, vars: Record<string,string|number|boolean|undefined>): string` — replaces `{{name}}`, `{{matricNumber}}`, `{{email}}`, `{{temporaryPassword}}`, `{{portalLoginUrl}}`, `{{buttonLabel}}`, `{{universityName}}`, `{{universityLogoUrl}}`, `{{forceChangePasswordNotice}}`, `{{greetingParagraph}}`, `{{closingParagraph}}` using a regex `/{{([a-zA-Z0-9_]+)}}/g`. If placeholder is missing AND required → use empty string; NEVER throw.
   - Use the new shared `buildBranding()` helper for `{{universityName}}` + `{{universityLogoUrl}}` so branding stays consistent.
2. Refactor `renderStudentAccountCreated` in `services/email.ts` to use the new template renderer + EmailTemplateConfig DB row for all non-static configurable values:
   - Configurable values map directly to EmailTemplateConfig columns: subjectLine → r.subject, senderName/senderAddress → from, replyToAddress → replyTo, portalLoginUrl → href, buttonLabel → render button text, greetingParagraph + closingParagraph + forceChangePasswordNotice → paragraph text.
   - Keep EXISTING professional layout structure (university header bar, HTML table, CTA button, footer with copyright). No layout or color changes unless admin explicitly sets `accentColorHex` in the config, which replaces the current `studentBlue #1e40af` constants.
3. Add validation on EmailTemplateConfig save: reject portalLoginUrl if URL invalid; reject accentColorHex unless matches `^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$`; reject senderAddress/replyToAddress if not valid email format; enforce max lengths (120, 254, 500 etc. matching schema).

### FR-4: Credential Email Trigger on Single/Bulk Student Creation
1. Modify `StudentService.create()` signature to return `Promise<{ user: Selected; temporaryPasswordPlaintext?: string }>` OR add an opt-in flag (backward compat) to return the generated password plaintext:
   - Create a new internal option `opts?.returnPlaintextPassword?: boolean` (default false). When false, only user returned. When true, returns {user, temporaryPasswordPlaintext}.
   - Credential email trigger ONLY sends when `opts?.sendCredentialEmail !== false` (default true so bulk + single-send both get email; admin can bypass by passing false when repairing imports).
   - Preserve existing password logic exactly: `const pwd = defaultPasswordFor(input) → passwordHash bcrypt 12 rounds`. Do not change passwords to random-only — keep matric as default if no password provided (matches existing behavior).
2. After successful transaction user create in both single-create endpoints (`admin.ts controller create`, `student.ts controller create`):
   - Call the new student service with `returnPlaintextPassword: true + sendCredentialEmail: true` (or inside service dispatch the email after create via try/catch so DB write NEVER fails because email delivery failed). Email sending must be non-blocking for the create endpoint.
   - Use dispatchEmail queue (BullMQ) to enqueue the STUDENT_CREDENTIALS job with idempotencyKey: `student-credentials:userId:<user.id>:<createdAt timestamp ms>`. This queue persists retries even if the single-create HTTP response was already returned to admin.
3. For `services/studentImport.ts confirmImport` validRows + UPDATE pass:
   - Pass `opts.returnPlaintextPassword = true` (or inside service dispatch) to collect temporary passwords per row, then enqueue STUDENT_CREDENTIALS emails with idempotencyKeys that include `importNumber` + row number for idempotency uniqueness. If a batch of 500 students is created, 500 emails are enqueued.
   - Set `EmailDeliveryLog.studentImportId` FK so the import detail page can show how many emails succeeded/failed.
4. Critical ordering requirement: **EMAIL SENDING MUST NOT BLOCK OR ROLLBACK STUDENT CREATION**. If Resend is down, the student is created successfully in the DB; the EmailDeliveryLog records status = FAILED, and retry worker handles the retries later. This protects the Bursary from "Resend outage means I can't onboard the new intake" scenario.
5. Extra: Add `sendStudentCredentialsManual(userId: number, triggeredByAdminId: number, forceRegenerateTempPwd=false): Promise<EmailDeliveryLog>` endpoint that Admin can call for individual students via a "Resend Credentials" button on a student row — useful if a student lost the original email or it went to spam. If `forceRegenerateTempPwd=true`, reset password to new random (call existing resetPassword) and send the new password; otherwise send original password only if we have it stored (we don't store plaintext) — so behavior for resend is: regenerate a temporary password. Document this behavior in button tooltip/label.

### FR-5: Admin Configurable Settings UI (Email Templates tab)
1. Extend `pages/admin/SystemSettings.tsx` with a 4th section/card (below University, Payments, Receipts cards) called "Email Delivery & Templates" or add an Email tab.
2. Render two sub-panels:
   - **Panel A: Credentials Template** (fields for EmailTemplateConfig templateKey='student_credentials' as per schema): Sender Name, Sender Email Address, Reply-To Address, Portal Login URL, Email Subject Line, Greeting Paragraph (textarea multiline 4 rows), Call-To-Action Button Label, Force Password Change Notice (textarea multiline), Closing Paragraph (textarea), Button Accent Color (#hex color picker input).
   - **Panel B: Delivery Overview** — toggle to force SMTP (disable Resend even if key set) + recent EmailDeliveryLog table: columns Date, Type, Recipient (email+matric), Provider, Status (PENDING/SENT/FAILED/RETRIED pill badges), Attempts, Action (Resend button for FAILED rows, View details opens Drawer with error message).
3. Add to SystemSettingsService schema PATCH: email configs + `emailProviderForceSmtp` Boolean (add to SystemSettings as new Prisma column — keep nullable, default false) + the EmailTemplateConfig save via a separate PATCH route `PATCH /admin/email-templates/:templateKey` body with validated fields.
4. Add Zod validation to the PATCH schemas (urls/hex/emails/max lengths). Existing admin/bursary role permissions already restrict SystemSettings to ADMIN role.
5. Add adminApi.ts routes for email settings GET + PATCH and the recent EmailDeliveryLog list GET (filters: emailType, status, startDate, endDate, toAddress contains, limit 200).

### FR-6: BullMQ Email Worker Real Delivery
1. Replace scaffold worker `console.log(...)` callback in `queues/emailQueue.ts:87` with real dispatch:
   - `renderFn = rendererForType(job.data.emailType)` → render `subject / html / text`
   - `provider = selectEmailProvider()`
   - `provider.send(mail)` → result
   - If success → EmailDeliveryLog update status SENT, set messageId, attempts +=1.
   - If failure → attempts +=1. If attempts < 3 → update EmailDeliveryLog status RETRIED, retryAfter = now + exponential backoff, schedule a new BullMQ job with `delay: ms`. If attempts >= 3 → update status FAILED + lastError = sanitized error message string.
2. Retries inside worker never throw. Every delivery attempt ALWAYS updates the log row — no orphaned pending rows.
3. `dispatchEmail` now creates a delivery log row with status PENDING before adding the BullMQ job. This gives admins visibility of "email has been queued and is waiting to send" — not just the final state.

### FR-7: Credential Transmission Security (Non Negotiable)
1. Passwords are NEVER stored plaintext in EmailDeliveryLog payloadSummary. PayloadSummary stores only sanitized metadata {studentName: first 40 chars, matricNumber, hasTempPassword: true/false, emailDomain: @after-part}. Use the new helper `sanitizeEmailPayload(payload)` in services/email/utils.ts.
2. `checkForSecrets()` still runs BEFORE provider.send on combined subject + html + text. If user sets a greeting that accidentally contains a pasted `sk_live_...` Resend key → throw abort as already implemented.
3. Resend API key stored ONLY in env variables, NEVER in EmailTemplateConfig DB row or GET settings response body. Admin can toggle Resend/SMTP/mock via the force SMTP field but cannot see the key through the UI.
4. Admin UI "Resend Credentials" button: for security, a password RESET happens (generate new strong temp password 14 chars + set mustChangePassword true) before sending the email — never attempt to reuse or retrieve hashed passwords.
5. Emails are sent over HTTPS (Resend SDK → api.resend.com 443) and SMTP when enabled (existing port 465 secure true).
6. Rate limit on Admin "Resend Credentials" endpoint: NEW `studentCredentialResendLimiter = 5 per 15m per user` (don't let a rogue admin send 1000 credential emails that trigger Resend quota).

## Non-Functional Requirements
- **NFR-1 (Type safety)**: api tsc exit 0; app tsc exit 0 after all changes.
- **NFR-2 (Frozen tests)**: All 8 Jest suites pass unchanged (see list at §10). No schema or assertion edits to the frozen test files.
- **NFR-3 (Non-blocking sends)**: Single/bulk student creation endpoints must have p95 latency ≤300ms even with 500-student imports (email enqueue → BullMQ add, not send). Actual delivery async off the HTTP request thread.
- **NFR-4 (Idempotency)**: Every email enqueue has a unique idempotencyKey; resending same credential for same student twice within 1 minute results in a new DeliveryLog row (new attempt, new password), but the BullMQ queue de-duplicates by jobId = idempotencyKey within the create flow.
- **NFR-5 (Graceful fallback)**: If Resend SDK throws ECONNREFUSED / 401 invalid key, AND SMTP also not configured → email still enqueued but provider = MOCK and the sentCaptures array has the mail — admin sees status = MOCK SENT in logs and knows to configure credentials properly.
- **NFR-6 (Zod trim + max boundary)**: All user inputs (subject line, sender name, greeting textarea) are trimmed + max ceilings per schema (Session-2 hardening already applied to schemas — ensure this applies to new EmailTemplateConfig schema as well).
- **NFR-7 (NDPR compliance)**: EmailDeliveryLog rows have updatedAt + retention policy suggestion — do not hard-delete logs automatically; keep records for ≥6 months. No PII in API list responses beyond email domain + matric last 3 chars for bursary role. Admin role sees full PII in logs.

## Constraints
- **Technical**:
  1. Use existing installed packages first: nodemailer (installed), bullmq (installed), prisma (installed). Add `resend` SDK only; no other mail libraries.
  2. No password storage in plaintext; passwords only exist in the `pwd` variable inside StudentService.create function scope, used to hash, used to render email template once, then discarded.
  3. prisma db push to apply new tables + columns — do not run prisma migrate dev (aligns with earlier convention).
  4. Existing auditLog writes for studentCreate / studentImport / settingsUpdate must still fire unchanged.
  5. BullMQ Redis ECONNREFUSED fallback must hold: if ensureQueue returns null, dispatchEmail falls back to direct in-process `setTimeout` call with ~3 retries simple backoff (not the ideal queue but protects single-dev env without docker redis).
- **Business**: Admin creates students and expects email to "just work". No UX change to create-student form (no new required fields for send email). "Resend Credentials" button optional UI: add to Students.tsx table row.
- **Dependencies**: Requires existing SystemSettings id=1 row (already auto-created by SystemSettingsService.get()). Prisma schema cannot have name conflicts with existing enum Role, StudentType, etc.

## Assumptions
1. Admin has or will obtain a Resend API key from resend.com and verify their sending domain at Resend dashboard to avoid spam folder placement.
2. Student email addresses are accurate (imported CSV has them correct). If a Resend "permanent bounce" happens for invalid email, Resend returns an error → delivery log FAILED, Admin can use Resend Credentials to fix email address then re-send.
3. `defaultPasswordFor(input)` matric-as-default-password behavior will be preserved — not changing to random-only; user did not request stronger onboarding passwords this round.
4. Portal login URL configurable = default env STUDENT_PORTAL_URL / CORS_ORIGIN already exists in utils/alatpay or as env vars, fallback to `http://localhost:5173` dev default when both empty.
5. Password Reset, Payment Successful, Payment Reminder templates still use their current hardcoded subjects/greeting; only Student Account Created template becomes admin-editable in this pass (lowest risk surface, best ROI, matches user spec wording "when student accounts are created").

## Open Questions
- None (decisions made: Resend primary + SMTP fallback + Mock, EmailTemplateConfig single row, EmailDeliveryLog full audit, template renderer placeholder, BullMQ worker real implementation, bull queue no-Redis setTimeout direct fallback).

## Acceptance Criteria

### AC-1: Prisma new models applied, generated client, tsc both sides exit 0
- **Type**: `rule`
- **Given**: Updated schema.prisma with EmailTemplateConfig + EmailDeliveryLog models + new SystemSettings.emailProviderForceSmtp column
- **When**: `cd api && npx prisma db push --accept-data-loss && npx prisma generate` then `cd api && npx tsc --noEmit ; cd app && npx tsc --noEmit`
- **Then**: All 4 commands exit 0; Prisma.SystemSettings TS type now has optional `emailProviderForceSmtp`; Prisma.EmailTemplateConfig and Prisma.EmailDeliveryLog types exported.
- **Pass Condition**: 4 commands exit 0.
- **Evidence**: TBD (command output saved).

### AC-2: Provider factory priority (Resend > SMTP > Mock) picks correctly
- **Type**: `rule`
- **Given**: 3 env scenarios: (a) only RESEND_API_KEY set; (b) only SMTP_HOST/PORT/USER/PASS set; (c) neither set.
- **When**: Call `selectEmailProvider()` for each.
- **Then**: Scenario a returns ResendProvider instance (name='resend'); Scenario b returns SmtpProvider (name='smtp'); Scenario c returns MockJsonProvider (name='mock'). Plus: when SystemSettings.emailProviderForceSmtp = true, scenario a still returns SmtpProvider since force overrides Resend.
- **Pass Condition**: 4 assertions correct.
- **Evidence**: TBD (node -e probe script).

### AC-3: All configurable values round-trip via Admin PATCH/GET
- **Type**: `rule`
- **Given**: Admin JWT token.
- **When**: `PATCH /admin/email-templates/student_credentials` body `{senderName: 'The Registrar Office', senderAddress: 'registrar@university.edu.ng', portalLoginUrl: 'https://pay.university.edu.ng/login', subjectLine: 'Important: Your University of Nigeria Payment Portal Login Details', greetingParagraph: 'Dear {{studentName}}, welcome to the 2025/2026 intake!', buttonLabel: 'Access Student Portal', forceChangePasswordNotice: 'For your security, your temporary password EXPIRES after your first successful login and you must choose a new password.', closingParagraph: 'If you need help, reply to this email or visit Room 101 Bursary.', accentColorHex: '#7c3aed'}` → then `GET /admin/email-templates/student_credentials`.
- **Then**: HTTP 200 both; GET response echoes the same 8 values unchanged; audit log `ACTION=EMAIL_TEMPLATE_UPDATED` exists.
- **Pass Condition**: Values match exactly.
- **Evidence**: TBD (curl probe output).

### AC-4: Single student create → 1 credential email delivered/delivery log row
- **Type**: `rule`
- **Given**: Admin JWT token.
- **When**: `POST /admin/users/create-student` (or equivalent create endpoint) payload with valid new student matric + email, password intentionally missing → backend uses matric as default temp password per `defaultPasswordFor()`.
- **Then**: Within 5 seconds (Redis or mock worker): 1 new EmailDeliveryLog row exists with emailType='STUDENT_CREDENTIALS', status in {SENT, MOCK_SENT equivalent or RETRIED/FAILED but row definitely exists}, provider = (Resend/SMTP/Mock per config), attempts ≥1, toAddress matches created student email, recipientId = student user.id, idempotencyKey contains 'student-credentials:userId'. The sent email (sentCaptures last entry or Resend SDK spy) contains all placeholders rendered: student full name, matric number, email address, temporary password = the defaultPasswordFor value (matric, since caller omitted password), portalLoginUrl button href, "change password on first login" notice present.
- **Pass Condition**: DeliveryLog row exists + template contains correct fields + password value present (in mock, sentCaptures).
- **Evidence**: TBD.

### AC-5: Bulk import 10 students → 10 delivery log rows, no duplicate password leaks to log payloadSummary
- **Type**: `rule`
- **Given**: Admin JWT token, valid 10-row XLSX students import file (no dups, all required columns, NO password column → default password per student's matric number).
- **When**: Upload via Students → Bulk Import → stage file → confirm import.
- **Then**: Import success + 10 EmailDeliveryLog rows exist (all STUDENT_CREDENTIALS type, studentImportId FK set to new import batch id). For each row: payloadSummary does NOT contain `temporaryPassword` key or any value equal to the matric number (sanitized). BUT the sent render html+text (from sentCaptures) DOES contain each student's password (correct delivery). In other words: logs never leak PII, but actual email content delivered to student is correct.
- **Pass Condition**: 10 rows, FK match, payloadSummary sanitized, sentCaptures show all 10 individual renders with correct unique per-student passwords.
- **Evidence**: TBD (db query + sentCaptures JSON).

### AC-6: Failed Resend retries 3× then FAILED but student creation still succeeds (idempotency + non-blocking guarantee)
- **Type**: `rule`
- **Given**: API env has `RESEND_API_KEY = re_INVALIDKEY_xxxxxx` (invalid so Resend rejects it). No SMTP vars set.
- **When**: Create a single student + wait 10 sec total retry window elapses.
- **Then**: Student actually exists in users table. EmailDeliveryLog for that student has attempts = 3 exactly, lastError non-empty string, status FAILED or MOCK if provider fallback activated; `retryAfter` earlier than now. No 500 propagated to student create HTTP response (it was 201).
- **Pass Condition**: student created (DB), deliveryLog attempts=3 FAILED, HTTP response to admin was success not error.
- **Evidence**: TBD.

### AC-7: Admin Resend Credentials button always resets password to new strong temp password
- **Type**: `rule`
- **Given**: Existing student record (id, hashedPassword in DB).
- **When**: Admin clicks "Resend Credentials" (calls `POST /admin/users/:id/resend-credentials`).
- **Then**: `mustChangePassword=true` updated on user row; new EmailDeliveryLog row with status SENT; rendered email HTML contains the NEW random 14-char password (NOT old one, since it's hashed we cannot recover it) + existing force change warning present.
- **Pass Condition**: User DB row has mustChangePassword=true, email rendered contains new unique password each call.
- **Evidence**: TBD.

### AC-8: Frozen Jest gate — 8 test suites pass unchanged
- **Type**: `rule`
- **Given**: NODE_ENV=test, empty test schema.
- **When**: `cd api && NODE_ENV=test npx jest health.test.ts regression.test.ts rbac-matrix.test.ts idempotency.test.ts email-secrets.test.ts academic-import.test.ts search-settings-notif.test.ts reconciliation.test.ts --runInBand --detectOpenHandles`.
- **Then**: All 8 test suites pass; total tests ≥ previous count, 0 failures.
- **Pass Condition**: Jest exit code 0.
- **Evidence**: TBD (jest log).

### AC-9: Admin SystemSettings page Email Template tab + Delivery Log panel render
- **Type**: `rubric`
- **Dimension**: UI completeness, form UX, and PII masking correctness (bursary role vs admin role views).
- **Scale**: 1-5
- **Anchors**: 1 = email settings fields not present in Admin UI at all; 3 = fields present but no validation messages, status badge colors wrong; 5 = all 8 configurable fields with validation errors on invalid URL/hex/email, accent color changes the button preview swatch live, "Recent Deliveries" table shows SENT green badge / FAILED red / PENDING gray / RETRIED amber, Resend button opens a drawer with lastError text when row FAILED. Admin role sees full email address / full matric, Bursary role sees truncated mask `s******@university.edu.ng` + matric `...001` only.
- **Pass Threshold**: ≥ 4
- **Evidence**: TBD (browser screenshots of SystemSettings UI before/after save).

### AC-10: Security checklist passes (no password in log payloads, no env API keys in GET responses)
- **Type**: `rule`
- **Given**: Running backend, Admin JWT token.
- **When**: (1) GET /admin/email-templates/student_credentials → response body stringified; (2) GET /admin/email-delivery-logs?limit=5 response bodies payloadSummary stringified for each row; (3) create 1 student → wait for SENT row → inspect deliveryLog row payloadSummary + sentCaptures render.
- **Then**: (1) response does NOT contain 'RESEND_API_KEY' or 'sk_' or 'SMTP_PASS' substrings; (2) payloadSummary does NOT contain bcrypt hash patterns / actual passwords / JWT patterns; (3) the sent email HTML/text DOES contain the temporary password but the DB deliveryLog payloadSummary does not.
- **Pass Condition**: All 3 cases pass assertions.
- **Evidence**: TBD (jq asserts).
