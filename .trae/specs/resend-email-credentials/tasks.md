# Resend Email with Automated Credential Delivery — Implementation Plan

Derived from `spec.md` dated 2026-09-27. Every task-local TR is type `rule` or `rubric`; parent AC references preserved.

## Task 1: Prisma Schema New Models + Columns + prisma db push + client generate
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  1. Edit `api/prisma/schema.prisma`.
  2. Add to `SystemSettings` model 1 new column: `emailProviderForceSmtp Boolean? @default(false)`.
  3. Add new `EmailTemplateConfig` model (described in spec FR-1): id Int @id default(1) enforced; templateKey String @unique @db.VarChar(80) default('student_credentials'); senderName String? @db.VarChar(120); senderAddress String? @db.VarChar(254); replyToAddress String? @db.VarChar(254); portalLoginUrl String? @db.VarChar(500); subjectLine String? @db.VarChar(200); greetingParagraph String? @db.MediumText; buttonLabel String? @db.VarChar(60); forceChangePasswordNotice String? @db.MediumText; closingParagraph String? @db.MediumText; accentColorHex String? @db.VarChar(9); updatedById Int?; @relation(fields: [updatedById], references: [id], onDelete: SetNull, name: 'EmailConfigUpdater'); @@unique([templateKey]).
  4. Add new `EmailDeliveryLog` model (described spec FR-1). BigInt id autoincrement PK; emailType, toAddress, recipientId, triggeredByAdminId, studentImportId, idempotencyKey unique, provider RESEND/SMTP/MOCK, status PENDING/SENT/FAILED/RETRIED, resendMessageId nullable unique, smtpMessageId nullable, attempts default 0, lastError nullable 2000 varchar, retryAfter DateTime?, payloadSummary Json?; createdAt/updatedAt; indexes on (emailType,status,createdAt), recipientId, triggeredByAdminId, studentImportId. Relations to User via separate named FK names to avoid collisions.
  5. Run `cd api && npx prisma db push --accept-data-loss --schema=prisma/schema.prisma` followed by `npx prisma generate`.
  6. Update `services/systemSettings.ts SEED_DATA` to include `emailProviderForceSmtp: false` default.
- **Acceptance Criteria Addressed**: AC-1 (schema/tsc)
- **Test Requirements**:
  - `rule` TR-1.1: `npx prisma db push` exit 0; `npx prisma generate` exit 0. Evidence: terminal output captured.
  - `rule` TR-1.2: `tsc api` exit 0. Evidence: exit 0.
  - `rule` TR-1.3: Generated Prisma types export EmailTemplateConfig & EmailDeliveryLog (grep @prisma/client generated index.d.ts). Evidence: grep.
  - `rule` TR-1.4: SystemSettings type includes `emailProviderForceSmtp?: boolean | null` optional field. Evidence: TS type check.

## Task 2: Install resend package, build provider factory (priority Resend > SMTP > Mock)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  1. `cd api && npm install resend@latest --save`. Check package-lock updated.
  2. Create `api/src/services/emailProviders.ts`. Define:
     - interface `EmailProvider { readonly name: 'resend'|'smtp'|'mock'; send(mail: MailArgs): Promise<EmailProviderResult>; }`
     - `MailArgs = {from: string; replyTo?: string; to: string; subject: string; html: string; text: string; }`
     - `EmailProviderResult = { success: boolean; messageId?: string; error?: string; }`
     - `ResendProvider(name='resend')`: if RESEND_API_KEY non-empty use SDK `new Resend(process.env.RESEND_API_KEY).emails.send({from,to,reply_to,subject,html,text})`.
     - `SmtpProvider(name='smtp')`: use nodemailer createTransport with existing env variables; if any env var absent return success=false with error 'smtp not configured'.
     - `MockJsonProvider(name='mock')`: writes to sentCaptures array, returns `success: true, messageId: 'mock-' + randomHex(12)`.
     - `selectEmailProvider(forceSmtp?: boolean): EmailProvider`. Priority: Resend → SMTP → Mock. If SystemSettings.emailProviderForceSmtp === true (or param forceSmtp=true), pick SMTP before Resend (override).
  3. Add `api/.env` section with RESEND_API_KEY commented out + docs link. Update `api/.env.example` with same.
  4. Update frozen `email-secrets.test.ts` only when needed (no breaking imports required; if a test uses `sendEmail` and relies on `jsonTransport:true` being detected as success we keep compatibility via Mock provider still setting success=true).
  5. Optional: create `api/src/__tests__/emailProviderFactory.test.ts` — a small unit test for provider priority selection; test can be skipped if Jest timing tight (validate via node -e instead).
- **Acceptance Criteria Addressed**: AC-2 (provider priority), AC-6 (failure resilience partial: provider return correct error messages)
- **Test Requirements**:
  - `rule` TR-2.1: `npm ls resend` → resend listed with correct major version. Evidence: command exit 0.
  - `rule` TR-2.2: `tsc api` exit 0.
  - `rule` TR-2.3: Standalone probe (node -e): env case A → RESEND_API_KEY set → factory returns provider.name === 'resend'; case B SMTP vars set → 'smtp'; case C none → 'mock'; case D RESEND_API_KEY + forceSmtp=true → 'smtp'. Evidence: 4 assertions all pass.
  - `rule` TR-2.4: Frozen Jest 8 suites still pass (run only email-secrets.test.ts to confirm). Evidence: exit 0.

## Task 3: Shared template renderer placeholder engine + EmailTemplateConfig service
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2, Task 1 (EmailTemplateConfig table present)
- **Description**:
  1. Create `api/src/services/emailTemplate.ts`:
     - `EmailTemplateService.getByKey(templateKey: 'student_credentials' | string, brandingOverride?: Branding): Promise<ResolvedStudentCredsTemplate>`. Loads EmailTemplateConfig row from DB; env fallback cascades `EMAIL_FROM_NAME/EMAIL_FROM_ADDRESS/EMAIL_REPLY_TO/STUDENT_PORTAL_URL/CORS_ORIGIN`; last-resort defaults to current hardcoded strings in email.ts. Uses `buildBranding()` for universityName/logoUrl.
     - `EmailTemplateService.updateByKey(templateKey, patch, opts.updatedById?): Promise<...>` — zod-validate patch (urls/hex/emails/max lengths), update DB, write audit log.
     - `renderPlaceholders(text: string, vars: Record<string,unknown>): string` — replaces `{{foo}}` with stringified vars. If placeholder unknown, replace with `''` (empty). Never throw.
     - `renderStudentCredentialEmailHtmlText(vars: TemplateVars, config: ResolvedStudentCredsTemplate): RenderedEmail` — builds the html/text wrapped emails using current layout but substitutes all configurable fields. Keep the secret pre-send check intact, and keep university wrapper header/footer unchanged unless accentColorHex is set (then swap #1e40af blue with the hex).
  2. Zod validation schema for EmailTemplateConfigPatch includes `.trim().max(N)` ceilings per FR-3 §3: senderName max 120, senderAddress max 254 .email(), portalLoginUrl z.string().url().max(500), accentColorHex regex `^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$`.
  3. Update existing `renderStudentAccountCreated` in `services/email.ts` to delegate to the new template renderer (backward compat: still accepts the same positional argument list; internally calls the new engine). Keep 9 frozen email secrets tests passing exactly as before.
  4. `sanitizeEmailPayload(payload, {truncateNamesAt=40, maskPassword= true})` helper returns payloadSummary object safe for DB logs.
- **Acceptance Criteria Addressed**: AC-3 (config round-trip backend), AC-10 (security no password logs)
- **Test Requirements**:
  - `rule` TR-3.1: Placeholder engine passes 6 assertions: renders {{universityName}}, {{portalLoginUrl}}, {{temporaryPassword}}; unknown placeholder → empty string; HTML-unsafe characters like `<` `>` `"` `&` in password escaped as entities in HTML output (use built-in html escape function). Evidence: Jest or node probe.
  - `rule` TR-3.2: getByKey when DB row empty → returns env/hardcoded defaults that exactly match current render. Evidence: diff string against unchanged `renderStudentAccountCreated` output.
  - `rule` TR-3.3: Update by key with invalid URL → zod rejects 400. Evidence: curl 400 + error message.
  - `rule` TR-3.4: sanitizeEmailPayload: object with `{studentName, temporaryPassword}` → returned summary does NOT include temporaryPassword string value anywhere (checked by includes()). Evidence: probe.
  - `rule` TR-3.5: `tsc api` exit 0.

## Task 4: BullMQ emailQueue worker REAL implementation (no scaffold) + PENDING delivery logs created pre-enqueue
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2, Task 3
- **Description**:
  1. `queues/emailQueue.ts`:
     - `dispatchEmail(args)` NOW: FIRST creates EmailDeliveryLog row with status = PENDING + idempotencyKey, attempts = 0; THEN enqueues BullMQ job.
     - Worker callback at line 87 now: switch(job.data.emailType) → render function, call provider.send, update delivery log. Known: STUDENT_CREDENTIALS (render credential template), RESET_PASSWORD (existing renderPasswordReset), PAYMENT_SUCCESSFUL, BILL_ASSIGNED, PAYMENT_FAILED, PAYMENT_REVERSED, REFUND_STATUS_CHANGED, PAYMENT_REMINDER. For templates without config yet (all except student credentials), keep calling existing render functions unchanged. After provider result: increment attempts, write success with messageId / resendMessageId / smtpMessageId, status = SENT. If fail + attempts < 3 → RETRIED, schedule BullMQ job with delay milliseconds (exponential backoff 2min → 4min → 8min). If attempts >=3 → FAILED. Errors stored as lastError string (truncate to 2000 chars).
     - If ensureQueue returns null (Redis unavailable), fallback to direct inline send with simple setTimeout retry loop 3× instead of BullMQ. Still writes delivery log correctly.
  2. Update `server.ts` bootstrap: ensure emailQueue worker is imported so it's initialized (already imported via queue/ts? verify by grep).
- **Acceptance Criteria Addressed**: AC-6 retry semantics
- **Test Requirements**:
  - `rule` TR-4.1: Dispatch single STUDENT_CREDENTIALS email → EmailDeliveryLog row count +1; initial status = PENDING; after worker runs, status becomes SENT or FAILED; attempts ≥ 1. Evidence: DB query.
  - `rule` TR-4.2: Worker fallback without Redis (ensureQueue returns null via env override) still delivers via inline mock provider. Evidence: sentCaptures.length increases.
  - `rule` TR-4.3: Worker with Resend API key invalid → status transitions: PENDING → RETRIED (×2) → FAILED, attempts = 3. Evidence: after 10 seconds, DB row query.

## Task 5: StudentService credential trigger (single create + bulk import)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 3, Task 4
- **Description**:
  1. Modify `services/student.ts` StudentService.create:
     - Keep password generation logic (`pwd = defaultPasswordFor`, `bcrypt.hash(pwd,12)` at 12 rounds).
     - Add optional flags to opts type definition: `sendCredentialEmail?: boolean` (default true), `returnPlaintextPassword?: boolean` (default false).
     - After prisma transaction commit (successful user create):
       - If opts.sendCredentialEmail !== false: dispatch `EMAIL_TYPE_STUDENT_CREDENTIALS` via dispatchEmail() with payload {userId, studentName, matricNumber, email, temporaryPassword = pwd, idempotencyKey: 'student-credentials:userId:'+user.id+':'+Date.now()}.
       - Return value: if opts.returnPlaintextPassword === true → {user, temporaryPasswordPlaintext: pwd}; else return user as before. Wrap in try/catch — IF DISPATCH FAILS → log warn but NEVER throw user-visible error, the created user must be returned successfully (idempotency + non-blocking guarantee AC-4,AC-6).
  2. StudentService.resetPassword (existing) already resets + returns temporaryPassword. Also now dispatches STUDENT_CREDENTIALS email? No, per spec resend credential endpoint uses it explicitly. Add a dedicated StudentService.sendCredentialEmail(userId, opts.actorId, {forcePasswordReset: boolean}) method with password reset path that calls existing resetPassword + dispatch STUDENT_CREDENTIALS. This implements the Resend Credentials button from FR-4 §5.
  3. Bulk import: `services/studentImport.ts` confirmImport pass 2 (valid rows): currently calls StudentService.create — already in the loop. Since StudentService.create now dispatches emails internally by default, the loop automatically handles bulk sends. For extra observability: pass opts.importId in dispatch so EmailDeliveryLog.studentImportId FK is set. Update dispatchEmail args to accept studentImportId.
- **Acceptance Criteria Addressed**: AC-4 (single create → 1 email), AC-5 (bulk 10 → 10 log rows)
- **Test Requirements**:
  - `rule` TR-5.1: Create 1 student (payload without password → default: matric number). Within 5 seconds, EmailDeliveryLog count +=1; type = STUDENT_CREDENTIALS; the dispatched worker render HTML includes the matric number as the temp password. Evidence: sentCaptures mock entry HTML string includes password value equals matric.
  - `rule` TR-5.2: dispatch error (throw in dispatch mock) never propagates to createStudent endpoint; endpoint still returns 201 user shape; exception only in warn log. Evidence: curl 201 + warn in stderr.
  - `rule` TR-5.3: Bulk 10 students import confirm → total new EmailDeliveryLog rows = 10; each row has studentImportId FK populated; payloadSummary never contains password string. Evidence: MySQL raw SQL count + sanitized payloadSummary inspect.
  - `rule` TR-5.4: `tsc api` exit 0.

## Task 6: Admin backend routes for templates config (GET + PATCH) + delivery logs list + resend-credentials endpoint
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 3, Task 5
- **Description**:
  1. `routes/admin.ts` (or `routes/emailSettings.ts`) add 5 new admin routes protected by `protect + restrictTo('ADMIN')`:
     - GET `/admin/email-templates/:templateKey` → EmailTemplateService.getByKey + {status, data}.
     - PATCH `/admin/email-templates/:templateKey` → validateBody with zod schema, updatedById=req.user.id, audit write action=`EMAIL_TEMPLATE_UPDATED`.
     - GET `/admin/email-delivery-logs` → query {emailType?, status?, toAddressContains?, recipientId?, studentImportId?, page?, pageSize?, sort=createdAt desc} → return {rows, total, totalPages}; role=BURSARY sees masked (PII truncated) and role=ADMIN sees full values. Rate limit 200/15m.
     - GET `/admin/email-delivery-logs/:id` → single row detail.
     - POST `/admin/users/:id/resend-credentials` → StudentService.sendCredentialEmail(userId, req.user.id, forcePasswordReset: true), returns 202 accepted + deliveryLog id. Rate limit 5/15m per user.
  2. `controllers/admin.ts L55` create-student controller already calls StudentService.create — no extra work needed, emails auto dispatch by default.
  3. Add zod validation for all new route schemas with trim/max ceilings.
- **Acceptance Criteria Addressed**: AC-3 round trip (GET/PATCH admin), AC-7 resend button resets password, AC-10 no secret leaks.
- **Test Requirements**:
  - `rule` TR-6.1: Curl chain: PATCH /admin/email-templates/student_credentials {subjectLine, portalLoginUrl} → 200. GET same → returns new values. Evidence: curl.
  - `rule` TR-6.2: POST /admin/users/:id/resend-credentials → 202 accepted; user row `mustChangePassword=true` set; EmailDeliveryLog row created; sent email contains a NEW password (not previous). Evidence: DB query + sentCaptures html include password.
  - `rule` TR-6.3: GET /admin/email-delivery-logs as BURSARY role → `to` field masked (a******@b.com); when same request sent as ADMIN → full address. Evidence: 2 curl JSON payloads.
  - `rule` TR-6.4: `tsc api` exit 0.

## Task 7: Frontend Admin SystemSettings UI new Email tab + Students row Resend Credentials button
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 6 (backend endpoints)
- **Description**:
  1. `app/src/services/adminApi.ts`: Add functions:
     - `getEmailTemplateConfig(key: string)`, `patchEmailTemplateConfig(key, patch)`
     - `listEmailDeliveryLogs(params)`, `getEmailDeliveryLog(id)`, `resendStudentCredentials(userId: number)`
  2. `app/src/pages/admin/SystemSettings.tsx`:
     - Add a 4th card/tab "Email Delivery & Templates" below existing cards. Two subsections:
       - A. STUDENT CREDENTIALS TEMPLATE (form fields matching spec FR-5): Sender Name, Sender Address, Reply-To Address, Portal Login URL, Subject Line (max 200), Greeting Paragraph (textarea rows=4), Button Label (max 60), Force Change Password Notice (rows=4), Closing Paragraph (rows=4), Accent Color Hex (type color hex input with live swatch preview). Submit button: Patch + toast success/error.
       - B. RECENT DELIVERY LOGS (paginated table 25 rows): columns Date/Time, Type badge, Recipient (email+matric with role-based mask applied automatically or display what API sends), Provider pill, Status pill (color scheme PENDING gray, SENT green, RETRIED amber, FAILED red), Attempts, Action (if FAILED opens Drawer with lastError, Resend Button for STUDENT_CREDENTIALS rows that failed).
  3. `app/src/pages/admin/Students.tsx`:
     - Add a new action button at each row: `🔁 Resend Credentials`. ConfirmModal warns: "This will RESET the student's current password to a new random temporary one and send the new password via email to the address on file. The student will be required to choose a new password on next login." If admin confirms → call resendStudentCredentials(id) → toast 202 accepted.
- **Acceptance Criteria Addressed**: AC-9 UI quality rubric, AC-7 button behavior end-to-end in UI flow
- **Test Requirements**:
  - `rule` TR-7.1: SystemSettings.tsx → Email tab displays 8 editable fields + save button with dirty state. Evidence: browser snapshot.
  - `rule` TR-7.2: Patch button save → POST/PATCH to backend → toast success, values persist on page refresh. Evidence: network 200 + re-fetched values match.
  - `rubric` TR-7.3: UI completeness rating (as per AC-9 rubric 1-5, threshold ≥ 4). Evidence: screenshots and checklist evidence.
  - `rule` TR-7.4: `tsc app` exit 0.

## Task 8: Comprehensive integration smoke tests (single create + bulk 10 + invalid Resend fallback)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Tasks 1-7 implemented
- **Description**:
  1. Write `api/scripts/_smoke-email-session.mjs`:
     - Login admin; create student via API → get response.
     - Query delivery logs count increased by 1; render student password = matric (since password omitted in payload).
     - Bulk import via staged upload (or direct service call via endpoint): 10 unique rows → delivery logs count increases by 10; no password strings in payloadSummary JSON when we loop the log rows.
     - Toggle env to invalid Resend key → create a student → wait 10s → row attempts = 3, status = FAILED.
  2. Run frozen Jest 8 suites (`--runInBand`) to gate.
  3. Manual step: login via browser to admin → SystemSettings → Email tab → set test portalLoginUrl to a staging URL, save, create a new student → verify sent email HTML contains the new portalLoginUrl inside the button href (proof template renderer applied admin UI change).
- **Acceptance Criteria Addressed**: AC-4, AC-5, AC-6, AC-8 (frozen tests), AC-10
- **Test Requirements**:
  - `rule` TR-8.1: `_smoke-email-session.mjs` exits 0. Evidence: terminal summary.
  - `rule` TR-8.2: Frozen Jest 8 suites, all tests pass. Evidence: jest summary log.
  - `rule` TR-8.3: Admin UI edit → credential email uses the new values (portalLoginUrl button href verified). Evidence: sentCaptures entry HTML inspected.
  - `rule` TR-8.4: Final `tsc api` exit 0 + `tsc app` exit 0.
  - `rule` TR-8.5: IDE GetDiagnostics returns empty.

## Task 9: Independent Review
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 8 passes
- **Description**: Delegate fresh review context to cross-check:
  1. Spec.md AC-1 → AC-10 all pass independently.
  2. No plaintext password in payloadSummary (randomly sample 10 rows from delivery logs after bulk smoke).
  3. Resend key NOT exposed via GET settings or GET template endpoints.
  4. BullMQ retry: after 3 attempts, status=FAILED + attempts=3.
  5. Admin updates template → email uses updated subject/greeting.
  6. Report pass / fail / blocked + remediation items if any.
- **Acceptance Criteria Addressed**: All ACs via independent Review gate
- **Test Requirements**:
  - `rule` TR-9.1: review.md file exists, has checklist with pass for all 10 ACs. Evidence: file contents.
  - If any failed checkpoint exists → create new `pending` remediation tasks in tasks.md, mark status, exit Review.
