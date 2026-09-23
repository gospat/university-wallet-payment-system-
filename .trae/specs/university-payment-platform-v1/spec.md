# University Student Payment Management Platform - Product Requirements Document (PRD)

## Overview
- **Summary**: Transform the existing wallet-deposit skeleton into a professional university financial-management platform with a complete Student→Fee→Invoice→Payment→Transaction→Receipt audit chain, three secure portals, RBAC-enforced backend, auditable financial ledger, fee/invoice management, Paystack integration with idempotent webhooks, receipt verification, bulk imports (students & fees), rich reporting with exports, and security hardening (no public admin signup, immutable financial records).
- **Purpose**: Replace the current generic "wallet deposit" flow (which accepts any amount from the client, has no invoice concept, no fee assignment, and only 6 UI pages) with a correct university fee-payment pipeline that matches the 45-section specification. The university needs a single auditable system of record for student financial data.
- **Target Users**:
  1. **Students** (~thousands): Pay fees, view schedules, download receipts, track balance.
  2. **Administrators** (~2-10): Full system management, student/fee bulk uploads, reporting, configuration.
  3. **Bursary Officers** (~5-20): Payment operations — fee setup, fee assignment, payment monitoring, receipt verification, reconciliation, refunds (no system config access).

## Goals
- **G1 — Auditable Financial Chain**: Every Student → Fee → Invoice → Payment → Transaction → Receipt → Ledger entry is permanently linked and immutable on completion. Deleted financial records never occur; reversals/adjustments only.
- **G2 — University Data Model**: All 15+ student fields (matric, JAMB, admission number, level, session, faculty, dept, programme, middle name, student type, entry mode, admission year, graduation year, phone, address, account status), Fee + FeeCategory, FeeAssignment (7 assignment dimensions), Invoice, Receipt, WebhookEvent, StudentImport, Refund tables exist and populated.
- **G3 — Correct Fee-to-Payment Flow**: Frontend submits ONLY an `invoiceId` (never an amount). Backend calculates the due amount from the database + prior payment history, creates a PENDING payment with unique PAY- reference, initializes Paystack, verifies server-side, compares expected vs gateway amount (±1 subunit tolerance), credits invoice + wallet, generates persisted receipt, writes double ledger entry.
- **G4 — Bulk Uploads (Students & Fees)**: 7-step CSV/XLSX pipeline (upload → parse → validate → duplicate detection → error report → preview → confirm-import). Non-destructive import; skip/update/cancel for duplicates. Full import logging.
- **G5 — Administrative Dashboards**: Admin has 16+ dashboard KPI cards (students active, fees configured, billed/paid/outstanding, today/week/month collections, success/pending/failed/reversed counts, recent payments/students/fees) that are CLICKABLE and filter the respective record pages. Bursary has its own bursary-specific dashboard (not admin's).
- **G6 — Rich Payment Reporting & Export**: 8 report types (Daily, Monthly, Session, Fee, Department, Faculty, Programme, Level, Student) each with date/status/fee/session filters, exportable to Excel, CSV, and PDF.
- **G7 — Secure Receipt Generation + Verification**: Every successful payment auto-creates a DB Receipt row with unique REC- number + verification token + QR. Public `/verify/:reference` page shows non-PII receipt confirmation; authenticated users get full official branded PDF (logo, QR, verify URL, PAID watermark, timestamped).
- **G8 — Paystack Webhook Idempotency + Security**: Dedicated `webhook_events` table with unique (eventId, txRef) constraint. HMAC-SHA512 signature check before ANY processing. Fast HTTP 200 return after DB persistence; processing happens async via BullMQ queue. charge.success, refund.* events handled.
- **G9 — RBAC with Backbone Enforcement**: Every protected endpoint uses `protect()` + `restrictTo([...])`. Public `/auth/signup` CANNOT create ADMIN/BURSARY (forced STUDENT). Financial mutations restricted to BURSARY/ADMIN only. BURSARY cannot delete admins, change JWT secret, alter Paystack keys, delete transactions, modify completed amounts.
- **G10 — Zero Diagnostics Build**: TypeScript strict, tsc --noEmit passes both api/ and app/ projects with 0 errors. No console.error or unhandled promise rejections at boot or during core flows.

## Non-Goals (Explicitly Out of Scope for V1)
- **N1**: Multi-tenant / multi-university SaaS deployment (single institution only).
- **N2**: Paystack Split Payments / Subaccounts settlement accounting (the N2k service charge discrepancy in the current code is fixed to go into a university income ledger entry, but no actual Paystack split API calls).
- **N3**: Hosted/Production cloud deploy infrastructure, Terraform, CI/CD pipelines, Docker/K8s orchestration (the existing docker-compose.yml is a dev dependency only).
- **N4**: Mobile native apps — responsive web only (breakpoints 360px–4K per user profile preference).
- **N5**: HR/Staff payroll, non-student invoicing, procurement/expenses management.
- **N6**: 2FA / OTP (password reset via email is the limit; phone/WhatsApp SMS out of scope).
- **N7**: Payment gateways other than Paystack (Remita, Flutterwave, Interswitch deferred). Channel support within Paystack (card, bank, USSD, QR, bank_transfer) IS included.
- **N8**: Programmatic student SSO integration with university MIS (manual bulk import covers V1 onboarding).

## Background & Context
**Repository**: `/Users/gloriousanjorin-adeboye/University payment gate-way /`
**Existing Stack**:
- Backend: Node/Express + TypeScript, Prisma 5.22 (MySQL), ioredis/BullMQ, bcrypt 12 rounds, JWT 90d, Winston logging, helmet/cors/express-rate-limit, Puppeteer + QRCode for PDFs, Paystack SDK pattern.
- Frontend: Vite 5 + React 18 + TypeScript, React Router v7, TanStack React Query 5, Axios, Tailwind 4 (no shadows/transitions per user profile preference for size), Lucide React icons.

**Baseline Audit Findings (from independent codebase analysis)**:
1. **DB Schema Gaps**: 9 mandatory tables ENTIRELY absent: Fee, FeeCategory, FeeAssignment, Invoice, Receipt, WebhookEvent, StudentImport, Refund, PaymentChannel. TransactionType enum has FEE_PAYMENT/REFUND values with 0 usage.
2. **API Gaps**: No fee CRUD, no bulk student upload, no bulk fee upload, no fee assignment generator, no invoice list/detail, no payment schedule endpoint, NO public receipt verify page (/public/verify/:reference), NO reports, NO transaction filters, NO refunds, NO audit log pagination. `POST /auth/signup` allows ADMIN role escalation — CRITICAL.
3. **Paystack Issues**: Current `PaystackService.initializeTransaction` hardcodes a fixed N2000 service charge + N2000 Paystack fee regardless of amount. `verifyDeposit` credits only the "tuition" portion; the N4000 charges are silently dropped with no income ledger — a reconciliation BUG. No webhook persistence; error console-only.
4. **RBAC Frontend Gaps**: AdminLogin + BursaryLogin have role-split bugs (ADMIN logging into /bursary/login is rejected by PrivateRoute). `/unauthorized` route missing.
5. **Frontend Pages**: Only 6 total pages (3 logins + 3 dashboards). 15+ required pages missing (student profile, fee list, invoice detail, checkout, admin student list/bulk upload, fee mgmt/bulk upload, reports, bursary transaction search, bursary student financial profile, receipt verify, transfer/withdrawal UI — the endpoints exist but UI does not).

**Project Convention Sources** (from `project_memory.md` / user profile):
- Zero Diagnostics environment (no errors/warnings/hints).
- 8px grid system, ultra-responsive 360px→4K, no shadows/transitions/complex gradients (size over fx), edge-aligned full-width header.
- WCAG/Accessibility compliance, aria-current correct on nav.
- Internationalization (i18n) — all user-facing strings moved to language files (V1 will at minimum centralize strings to a constants file as a single source of truth, even if EN-only at launch).
- Security-first: CSPRNG salts, strict rate limiting.
- No core platform mods; use extension points.
- Hashtag `#problems_and_diagnostics` pattern for systematic cleanup tasks.

## Functional Requirements

### Module A — Authentication & Authorization
- **FR-A1**: Three separate login entry points: `/student/login`, `/admin/login`, `/bursary/login`. Each validates the returned user's role and rejects mismatches (e.g., student logging in via admin portal = error).
- **FR-A2**: Student login accepts BOTH email and matriculation number as the username field.
- **FR-A3**: Public `POST /auth/signup` strips/ignores any `role` field and always creates STUDENT-only. ADMIN/BURSARY creation only via `POST /admin/users` (ADMIN role required).
- **FR-A4**: User `accountStatus` field (ACTIVE/SUSPENDED) checked on every `protect()` call — suspended users get 403.
- **FR-A5**: Failed-login attempt counter + lockout: 5 failed attempts → 15 min account lock. Resets on successful login or after timeout.
- **FR-A6**: Password reset flow: `POST /auth/forgot-password` → signed JWT reset token (15m expiry) via email link → `POST /auth/reset-password/:token`.
- **FR-A7**: Change-password endpoint `POST /auth/change-password` (authenticated, requires currentPassword + newPassword).
- **FR-A8**: `/unauthorized` route exists with role-aware guidance.
- **FR-A9**: BURSARY forbidden actions enforced at API level: cannot create/delete ADMIN users, cannot modify JWT_SECRET/PAYSTACK_SECRET via any endpoint, cannot hard-delete Transaction/User/Receipt rows, cannot modify Transaction rows where status=SUCCESS (amount/reference fields).

### Module B — Student Data Model
- **FR-B1**: User/Student record expanded with all Identification, Academic, and Contact fields per §8 of the spec, including `middleName`, `admissionNumber`, `jambNumber`, `studentType` (enum UNDERGRADUATE/POSTGRADUATE/PART_TIME/JUPEB), `entryMode` (UTME/DIRECT_ENTRY/TRANSFER), `admissionYear`, `graduationYear` (nullable), `phoneNumber`, `address`.
- **FR-B2**: `matricNumber` has DB UNIQUE constraint + model-level validation.
- **FR-B3**: `accountStatus` enum ACTIVE/SUSPENDED/GRADUATED/WITHDRAWN. User has `lastLoginAt` DateTime, `failedLoginAttempts` Int, `lockedUntil` DateTime|null.
- **FR-B4**: Student CRUD endpoints: `GET /admin/students` (paginated, filters: search, college, dept, programme, level, session, status), `GET /admin/students/:id`, `POST /admin/students` (ADMIN only), `PATCH /admin/students/:id` (ADMIN only, matricNumber immutable after creation except via special flag), `DELETE /admin/students/:id` → actually sets `accountStatus=WITHDRAWN` (SOFT DELETE only), student data preserved for audit.
- **FR-B5**: `GET /student/profile` (authenticated STUDENT, returns own full profile without password hash), `PATCH /student/profile` (allows updating OWN contact fields only, NOT academic fields, NOT matric, NOT role).

### Module C — Bulk Student Upload
- **FR-C1**: `POST /admin/students/bulk/validate` accepts CSV or XLSX multipart file, returns validation result WITHOUT importing anything (Step 2-5 of §10).
- **FR-C2**: Validator checks: required columns, matric format, email format, phone format, level/session integer format, non-empty required names, known college/dept/programme enums.
- **FR-C3**: Duplicate detection TWO-WAY: (a) duplicates within uploaded file (grouped by matricNumber), (b) matricNumbers already in the database.
- **FR-C4**: Validation response shape: `{ total, validCount, duplicatesWithinFile, duplicatesInDb, missingMatric, invalidRecords, validRows[], errorRows[], columnsDetected }`.
- **FR-C5**: `POST /admin/students/bulk/confirm` accepts the same file + `duplicateStrategy: 'SKIP' | 'UPDATE' | 'CANCEL'` (default SKIP). Creates a `StudentImport` audit row. Each inserted/updated student linked via `studentImportId` field.
- **FR-C6**: `StudentImport` records: importNumber (IMP-YYYY-NNNNNN), uploadedBy, createdAt, fileName, totalRecords, successfulRecords, failedRecords, duplicateRecords, duplicateStrategy.
- **FR-C7**: `GET /admin/imports/students` lists import history; `GET /admin/imports/students/:id/errors.csv` returns the error report as a downloadable CSV.

### Module D — Fee Management + Fee Categories + Fee Versioning
- **FR-D1**: `FeeCategory` model (admin-creatable fee types, not hardcoded): `id, name, code, description, createdAt, createdBy`. Seeded with the 16 default categories from §14 (Tuition, Registration, Acceptance, Accommodation, Medical, ICT, Library, Examination, Transcript, Certificate, ID Card, Convocation, Late Registration, Departmental, Faculty, Other Charges).
- **FR-D2**: `Fee` model full §13 structure: `id, feeCode (UNIQUE per session+cohort combo, not globally), name, description, feeCategoryId→FeeCategory, amount, currency(default NGN), academicSession, semester (FIRST/SECOND), facultyId/College, departmentId, programmeId, level (Int, e.g., 100/200), studentType, isMandatory(Boolean), paymentDeadline(DateTime), isActive(Boolean), createdById, createdAt, updatedAt`.
- **FR-D3**: Fee versioning: same "Tuition" name across sessions = separate Fee rows (different session). Historical transactions FK'd to the original Fee row, so amounts are preserved even if Fee is later edited.
- **FR-D4**: Fee CRUD endpoints (ADMIN + BURSARY): `GET/POST/PATCH /admin/fees`, `POST /admin/fees/:id/activate`, `POST /admin/fees/:id/disable`. DELETE forbidden for fees with existing invoices/transactions.
- **FR-D5**: `GET /admin/fees/categories`, `POST /admin/fees/categories`, `PATCH /admin/fees/categories/:id`.

### Module E — Fee Assignment Engine
- **FR-E1**: `FeeAssignment` table: `id, feeId, assignmentType (STUDENT|PROGRAMME|DEPARTMENT|FACULTY|LEVEL|SESSION|STUDENT_TYPE), targetStudentId?, targetProgramme?, targetDepartment?, targetFaculty?, targetLevel?, targetSession?, targetStudentType?, assignedBy, assignedAt, isActive`.
- **FR-E2**: `POST /admin/fee-assignments/create` auto-expands rules: assigning to PROGRAMME → looks up all students matching that programme + fee.session and produces one pending Invoice per student. Assigning LEVEL → same for level cohort.
- **FR-E3**: `POST /admin/fee-assignments/generate-invoices` given an array of FeeAssignment ids, materialises Invoices for every affected student.
- **FR-E4**: Manual single-student assignment: `POST /admin/fee-assignments/student` body = { studentId, feeId, overrideAmount? (default fee.amount), overrideDeadline? }.

### Module F — Invoice Model + Payment Schedule
- **FR-F1**: `Invoice` table: `id, invoiceNumber (INV-YYYY-NNNNNNNN UNIQUE), studentId→User, feeId→Fee, amountDue(Decimal), amountPaid(Decimal default 0), balance(Decimal generated as amountDue-amountPaid), status enum (UNPAID|PARTIALLY_PAID|PAID|PENDING|FAILED|REVERSED|REFUNDED|CANCELLED), dueDate, session, semester, createdAt, updatedAt, paidAt?`.
- **FR-F2**: `GET /student/fees/schedule` (STUDENT auth): returns invoices GROUPED BY academic session, with per-invoice columns (FeeName, Amount, Paid, Balance, Status) matching the §16 table exactly. Totals per-session at bottom.
- **FR-F3**: `GET /student/invoices` (paginated, filters: session, status, feeId, dateFrom/dateTo).
- **FR-F4**: `GET /student/invoices/:id` (detail + ownership check: STUDENT can only see own invoice; ADMIN/BURSARY any).

### Module G — Correct Payment Flow (§19–23, §26–27)
- **FR-G1**: `POST /student/payments/initiate` accepts ONLY `{ invoiceId, optionalPartialAmount? }`. The amount to charge is CALCULATED ON THE BACKEND: `const payable = optionalPartialAmount ? min(optionalPartialAmount, invoice.balance) : invoice.balance`.
- **FR-G2**: The payable amount is NEVER read from a client-sent "amount" body field. Request with "amount" present alongside invoiceId throws 400.
- **FR-G3**: Payment record (Transaction) created with unique `reference = PAY-YYYYMMDD-<6hex-random>` (format from §18), `type=FEE_PAYMENT`, `status=PENDING`, `metadata = { invoiceId, feeId, session, matricNumber, studentId, expectedAmount, optionalPartialAmountUsed }`. idempotencyKey per (studentId + invoiceId + short window) to prevent double-clicks.
- **FR-G4**: Paystack initialize with amount (NGN subunit kobo), currency NGN, full metadata (student_id, matric_number, invoice_id, fee_id, academic_session, fee_name) per §22, callback URL points to frontend `/student/payments/callback/:paystackRef`.
- **FR-G5**: Paystack verification happens via `GET /student/payments/verify/:paystackRef` (PROTECTED). Backend calls Paystack /transaction/verify. Compares `tx.data.data.amount/100` against the stored `expectedAmount`. Accepts if within ±1 kobo (integer sub-unit); otherwise flags status=UNDERPAID or OVERPAID with separate handling flow (NOT marked PAID).
- **FR-G6**: Partial payments: when invoice.amountDue=500k and student pays 200k → invoice.amountPaid +=200k, invoice.status = PARTIALLY_PAID, balance=300k. Second payment for remaining 300k → status=PAID. Every payment is its OWN Transaction row (no overwrites).
- **FR-G7**: Full state machine for Transaction.status and Invoice.status, with transition guards (e.g., SUCCESS cannot go back to PENDING except via refund/reversal records).

### Module H — Webhook Idempotency (§24–25)
- **FR-H1**: Dedicated webhook route `POST /api/v1/payments/webhooks/paystack` (not mounted inside wallet router) with CORS bypass and raw-body buffering (HMAC requires unmodified payload).
- **FR-H2**: HMAC-SHA512 signature check on `x-paystack-signature` header using PAYSTACK_SECRET_KEY BEFORE any DB operations. Fail (401 signature mismatch) on invalid.
- **FR-H3**: `WebhookEvent` table: `id, paystackEventId (UNIQUE), eventType, transactionReference (Paystack ref), payload(JSONB), isProcessed, processedAt, createdAt, attempts, lastError?`. Primary unique check on `paystackEventId`; secondary check on `transactionReference + eventType`.
- **FR-H4**: Webhook controller responds 200 in under 500ms after writing the WebhookEvent row (unprocessed) to DB. Actual processing dispatched async to BullMQ queue `webhook:process`.
- **FR-H5**: Queue processor for `webhook:process` applies the same verify + idempotency logic as FR-G5/G6/G7. Handles charge.success, charge.failed, refund.processed, refund.failed. If same txRef already has an applied payment (Transaction.status==SUCCESS), returns idempotent-ack.

### Module I — Double-Entry Ledger (§28)
- **FR-I1**: Rename WalletLedger → GeneralLedger, with schema: `id, entryType(INVOICE_ISSUED|PAYMENT|REFUND|REVERSAL|SERVICE_CHARGE|ADJUSTMENT), account (STUDENT_RECEIVABLE | UNIVERSITY_INCOME | SERVICE_CHARGE_INCOME | CASH_CLEARING), studentId?, walletId?, transactionId?, invoiceId?, debitAmount, creditAmount, balanceAfterPerAccount, reference, entryDate, narration, recordedBy, createdAt`.
- **FR-I2**: Atomic: issuing an Invoice = debit STUDENT_RECEIVABLE (increase asset), credit UNIVERSITY_INCOME (accrual basis).
- **FR-I3**: Atomic: verifying a SUCCESSFUL Payment = debit CASH_CLEARING, credit STUDENT_RECEIVABLE (decrease receivable, match invoice). The Paystack charge split: gateway fee is DEBITed to a UNIVERSITY_EXPENSES_FEE account; service charge portion credited to SERVICE_CHARGE_INCOME (this fixes the current dropped-N4000 bug).
- **FR-I4**: Every Financial Ledger Entry has a FK back to its originating Transaction/Invoice. No orphan entries. Balances at the (account, date) level are mathematically consistent.

### Module J — Receipt Generation, PDF, Verification (§31–35)
- **FR-J1**: `Receipt` table: `id, receiptNumber (REC-YYYY-NNNNNN UNIQUE), verificationToken (URL-safe 24char random, UNIQUE), transactionId→Transaction, invoiceId→Invoice, studentId→User, paidAmount, paystackReference, paymentChannel, paymentMethodDetail, paidAt(DateTime server timestamp NOT client clock), generatedAt, qrCodeData?, isVoided(Boolean default false), voidedBy?, voidedAt?`.
- **FR-J2**: On Payment SUCCESS (from verify flow OR from webhook worker), create Receipt row atomically in same Prisma transaction. If duplicate receiptNumber generated, retry.
- **FR-J3**: `GET /student/receipts/:reference/download` → official PDF (A4, university branding: placeholders for logo, name, address, contact, website URL — all configurable via env vars). Contains every §31/34 field, QR code encoding the verify URL, PAID watermark, "This is an authorized system-generated receipt" footer, WAT timestamp with timezone.
- **FR-J4**: **PUBLIC** (NO auth) `GET /public/verify-receipt/:receiptNumberOrToken`: returns JSON with minimum non-PII fields only (receiptNumber, status PAID/VOIDED, amount, date, feeName, studentInitialsOnly, last4OfMatric). NEVER returns full email, phone, address.
- **FR-J5**: Authenticated `GET /admin/receipts` with filters (reference, student, date, fee, status) and actions: view metadata, download PDF, regenerate PDF (only server timestamp unchanged), resend receipt by email (nodemailer, configured via env).

### Module K — Refunds (§36–37)
- **FR-K1**: `Refund` table: `id, refundNumber (REF-YYYY-NNNNNN), originalTransactionId→Transaction, originalReceiptId→Receipt, requestedAmount, reason, status (REQUESTED/APPROVED/REJECTED/PAID/FAILED), requestedById→User, approvedById→User?, paidAt?, paystackRefundReference?, notes(JSONB?), createdAt, updatedAt`.
- **FR-K2**: BURSARY can request Refund; ADMIN must approve. Double-approval.
- **FR-K3**: On Refund PAID → creates reversal ledger entry (FR-I1 REVERSAL type), creates a new REFUND Transaction linked to original via metadata.parentTransactionId, invoice status becomes PARTIALLY_PAID (partial refund) or REFUNDED (full), related Receipt NOT hard-deleted; a separate Receipt with isVoided=true created OR a flag added. Original Transaction remains untouched.
- **FR-K4**: No DB delete of Refund or the underlying Transactions. Soft-delete via status only.

### Module L — Audit Log (§38)
- **FR-L1**: `AuditLog` table expanded: `id, userId, action enum (all §38 actions plus more), entityType, entityId, oldValue(JSONB?), newValue(JSONB?), ipAddress, userAgent, createdAt`.
- **FR-L2**: Centralized `audit()` helper called inside every controller mutation path (addStudent, updateStudent, fee create/patch, fee assignment, payment verify, refund approve, user role change, config change, bulk import finalize, etc.). Attaches IP/User-Agent from request.
- **FR-L3**: `GET /admin/audit-logs` with filters: userId, action, entity, dateFrom, dateTo, search entityId. Pagination 50/page.
- **FR-L4**: Login, logout, signup all audit-logged automatically.

### Module M — Bulk Fee Upload (§39–40)
- **FR-M1**: Analogous to bulk students: `POST /admin/fees/bulk/validate` → `POST /admin/fees/bulk/confirm` with duplicateStrategy.
- **FR-M2**: Validates §40 fields (feeCode UNIQUE+format, feeName, amount>0, session format, faculty/department/programme existence, level integer, duplicate feeCodes within file + against DB).
- **FR-M3**: Records entries in a separate `FeeImport` table (same pattern as StudentImport).

### Module N — Admin Dashboard (§4)
- **FR-N1**: `GET /admin/dashboard/stats` returns ALL 16 KPI values from §4 (totalStudents, activeStudents, totalFeesConfigured, totalBilled, totalPaid, totalOutstanding, todayPayments, weekPayments, monthPayments, successTx, pendingTx, failedTx, reversedTx).
- **FR-N2**: Dashboard cards are CLICKABLE in UI: clicking "Pending Transactions" navigates to /admin/transactions?status=PENDING, clicking "Today's Payments" navigates with dateFrom=today, etc. (deep-linkable filters).
- **FR-N3**: Recent lists returned (separate endpoints or embedded): recent 10 Payments, recent 10 Students, recent 10 Fees.

### Module O — Bursary Transaction Search + Student Financial Profile (§29–30, §44)
- **FR-O1**: `GET /bursary/transactions` (BURSARY/ADMIN only) — THE core table. Supports ALL §44 filters: transactionId, paymentRef, paystackRef, student name/email/phone search, matric, invoiceId, feeId, session, dateFrom/dateTo, status, channel. Pagination + sort.
- **FR-O2**: `GET /bursary/students/search` — fuzzy search by name/matric/email/phone returning short list.
- **FR-O3**: `GET /bursary/students/:id/financial-profile` = §30 complete payload: student summary (id, name, matric, programme, level, session), financialSummary { billed, paid, outstanding }, paginated paymentHistory table { date, fee, amount, ref, status, receiptLink }, invoices list.

### Module P — Reports + Exports (§42–43)
- **FR-P1**: 8 report endpoints under `/admin/reports/*` (DailyCollection, MonthlyCollection, SessionCollection, FeeCollection, Department, Faculty, Programme, Level, Student).
- **FR-P2**: Every report accepts filters matching its domain (date range, session, feeId, deptId, levelId, etc.).
- **FR-P3**: Every report supports `&format=json|xlsx|csv|pdf` query param (default json). XLSX via exceljs, CSV native, PDF via Puppeteer same as receipts.

### Module Q — Payment Channels (§45)
- **FR-Q1**: Paystack initialize payload includes `channels: []` configured via env var `PAYSTACK_ENABLED_CHANNELS` (no hardcoded assumptions). If env unset, defaults to Paystack's standard.
- **FR-Q2**: On verify, store `paystack.data.data.channel` into `Transaction.metadata.paystackChannel` and `Receipt.paymentChannel` so the channel is on every record.

### Module R — Frontend Pages & UI Coverage
- **FR-R1**: All 15+ missing pages created (as per audit finding). Route table exactly matches permissions.
  Student pages:
  - `/student/profile` view + edit (limited fields + change password)
  - `/student/fees/schedule` Payment Schedule grouped by session (§16 table)
  - `/student/invoices` list + `/student/invoices/:id` detail
  - `/student/payments/checkout/:invoiceId` Payment Summary (§19) + Paystack redirect trigger
  - `/student/payments/callback/:paystackRef` verification loading + result screen
  - `/student/receipts/:ref/view` in-browser rendered receipt preview + download PDF button
  - `/student/transfer` peer-to-peer UI (uses existing `/wallet/transfer`)
  - `/student/withdraw` withdrawal form (uses existing `/wallet/withdraw`)
  Admin pages:
  - `/admin/students` table + `/admin/students/:id` edit profile
  - `/admin/students/bulk-upload` full 7-step flow with validation preview + error download
  - `/admin/fees` table + `/admin/fees/new` modal + `/admin/fees/:id` edit
  - `/admin/fees/bulk-upload` 7-step
  - `/admin/fee-categories` CRUD
  - `/admin/fee-assignments` assignment rules + generate-invoices action
  - `/admin/reports` hub page with 8 report tiles, filter form, export dropdown
  - `/admin/audit-logs` full audit log browser table
  - `/admin/imports` history of student/fee imports + error download
  Bursary pages:
  - `/bursary/transactions` powerful search table §44
  - `/bursary/students/:id/financial-profile` §30 page
  - `/bursary/receipts/verify` UI for scanning QR / entering ref + verifying authenticity
  - `/bursary/refunds` request + approval list
  Shared public pages:
  - `/public/verify-receipt/:referenceOrToken` (non-PII confirmation card)
  - `/unauthorized` 403 role explanation
  - `/404` not found

### Module S — RBAC Backend Enforcement (beyond frontend guards)
- **FR-S1**: Every mutation endpoint uses explicit role guard via `restrictTo`. BURSARY restricted from: DELETE /admin/students (only ADMIN soft-delete), PATCH /admin/users/:id/role (cannot elevate to ADMIN), any endpoint that touches env vars.
- **FR-S2**: Ownership checks: STUDENT on `/student/invoices/:id` MUST own invoice (studentId === req.user.id). Same for payments/receipts. If not, 404 (not 403, to prevent enumeration).
- **FR-S3**: Immutability guards: Transaction.amount PATCH returns 403 if status === SUCCESS unless the mutation is a Refund flow. Same for receiptNumber; cannot edit.

### Module T — Misc System
- **FR-T1**: Rate limiting tiers: auth login 40/15m (existing), auth signup 10/h, paystack webhook 1000/min but HMAC checked first, student payments 20/h, admin mutations 100/h, public verify-receipt 60/min.
- **FR-T2**: CORS_ORIGIN env respected (comma separated). App baseURL api.ts uses VITE_API_URL env (fix the hardcoded http://localhost:3000).
- **FR-T3**: String centralization: all hardcoded user-facing strings moved to a single TS constants file per project (`api/src/i18n/en.ts`, `app/src/i18n/en.ts`) for future i18n expansion.
- **FR-T4**: 8px grid system applied consistently across new UI; no box-shadow/transition (except `focus-visible` outline); full-width no-max headers; responsive down to 360px.
- **FR-T5**: TypeScript `strict: true` in both tsconfigs, tsc builds with 0 errors for V1 completion.

## Non-Functional Requirements
- **NFR-1 Security**: OWASP Top 10 compliance baseline. No secrets in frontend payloads. Paystack secret never serialized or logged (must replace any console.log of metadata with a redacted deep-clone helper).
- **NFR-2 Performance**: Dashboard stats endpoint response < 800ms with 100k transactions in MySQL (appropriate covering indexes created in migrations). List endpoints paginated min 20/page. Paystack verify under 3s.
- **NFR-3 Reliability**: Webhook at-least-once delivery semantics with idempotent processing. No data loss on process restart (BullMQ persistent Redis queue).
- **NFR-4 Maintainability**: 95%+ of modules have JSDoc-style comments on exported functions/services. Service layer pattern preserved (new services in `api/src/services/` not inline in controllers).
- **NFR-5 Accessibility (WCAG 2.1 AA)**: Color contrast 4.5:1, focus styles visible, tables with scope attributes, aria-labels on icon-only buttons, aria-current=page on nav.
- **NFR-6 Build/Type Safety**: Strict TS, `npm run build` in api/ and app/ exits 0, lint passes.
- **NFR-7 UX Consistency**: Same 8px spacing tokens, card/table/button/input/modal primitives reused across all 3 portals. No bespoke widget per page.

## Constraints
- **Technical C1**: Backend Prisma + MySQL only. No ORM swap to TypeORM/Drizzle. No DB engine swap.
- **Technical C2**: Frontend React + Vite + Tailwind v4 only. No Next.js migration in V1.
- **Technical C3**: Payment gateway limited to Paystack (V1). No multi-gateway abstraction layer deeper than is needed for channels list.
- **Technical C4**: PDF engine Puppeteer only (no PDFKit rewrite).
- **Business B1**: Financial immutability is an absolute non-negotiable. No delete endpoints on successful transaction/receipt/invoice after any SUCCESS state.
- **Business B2**: Nigerian context: currency default NGN, date/time WAT (Africa/Lagos TZ displayed to users), matric number formats include slashes, JAMB numbers present.
- **Dependencies**: Existing npm packages used first; new additions require justification. xlsx (SheetJS) or exceljs for bulk upload parsing and export. Nodemailer for password reset + resend receipt.

## Assumptions
- **A1**: University MySQL server (local or hosted) accessible and configured in .env. Existing `university_wallet` DB can accept new Prisma migrations.
- **A2**: Admin account with email `admin@university.edu.ng` (password as seeded) pre-exists and can bootstrap role creation.
- **A3**: Redis available on localhost:6379 in production or BullMQ falls back to in-memory without reliability — but in dev current Redis is down so we will add a graceful degraded mode (no queue, process webhook synchronously but still idempotency key protected).
- **A4**: Paystack test keys in env are valid; the user has a Paystack merchant test account for end-to-end flows.
- **A5**: SMTP credentials (for password reset + resend receipt) will be configured later via env. If missing in dev, emails get logged to console only (nodemailer ethereal/test account fallback safe fallback behavior).
- **A6**: University branding vars (logo URL, official name, address) will be provided by the user and set via env vars; placeholders ("Federal University of Technology", address placeholder, website) are acceptable for the implementation deliverable.

## Acceptance Criteria

### AC-1: Public Signup Role Escalation Closed
- **Type**: `rule`
- **Given**: A fresh unauthenticated client
- **When**: `POST /auth/signup` with body `{ email: 'hacker@x.com', password: 'X', role: 'ADMIN', firstName: 'H', lastName: 'X' }`
- **Then**: Response is 201 and the created user record has `role === 'STUDENT'` (the role field is coerced and ignored, not an error). The endpoint must NEVER create a non-STUDENT user.
- **Pass Condition**: Database check + 2 API calls (signup forcing ADMIN and signup forcing BURSARY) both return role=STUDENT persisted.
- **Evidence**: `curl` commands in __tests__/auth-security.test.ts + API output showing role field forced to STUDENT in DB.

### AC-2: Student Record Full §8 Schema
- **Type**: `rule`
- **Given**: Admin authenticated with ADMIN role
- **When**: `POST /admin/students` with a full payload of every §8 required field (middleName, admissionNumber, jambNumber, level, session, phone, address, studentType UNDERGRADUATE, entryMode UTME, admissionYear 2026, graduationYear null)
- **Then**: HTTP 201. Response body contains every created field. A subsequent `GET /admin/students/:id` returns the same fields identically.
- **Pass Condition**: 20 fields are non-null and correctly typed in both create and read responses; Prisma `@@unique` on matricNumber prevents duplicate matric insert (returns 400 + specific error message).
- **Evidence**: Integration test POST + GET. Prisma migration shows all new columns.

### AC-3: Bulk Student Upload 7-Step Idempotency
- **Type**: `rule`
- **Given**: Admin has a CSV with 50 rows. 3 rows have duplicate matricNumbers within the file. 5 rows have matricNumbers that already exist in DB. 2 rows have missing required fields.
- **When**: (1) `POST /admin/students/bulk/validate` multipart → returns counts. (2) `POST /admin/students/bulk/confirm` with `duplicateStrategy=SKIP`. (3) Re-issue same confirm request exactly (simulate retry).
- **Then**: (Step 1 response) 50 total, 40 valid, 3 file-dup, 5 db-dup, 2 invalid. (Step 2) exactly 40 new rows inserted. (Step 3) zero additional students inserted (idempotent confirm token). StudentImport record shows correct counts in both runs.
- **Pass Condition**: Counts match expected exactly. Second confirm produces 0 new records. StudentImport audit rows exist with importNumber format IMP-YYYY-NNNNNN.
- **Evidence**: Validate JSON response, pre-insert and post-insert DB row counts via direct Prisma query, StudentImport table entries.

### AC-4: Fee Model + Versioning + Category CRUD
- **Type**: `rubric`
- **Dimension**: Fee system completeness across Category / Fee / Assignment dimensions
- **Scale**: 1-5
- **Anchors**: 1 = no new Fee/FeeCategory tables or endpoints. 3 = Fee + FeeCategory CRUD basic endpoints only, no versioning semantics. 5 = Full §13 Fee fields + Admin-creatable FeeCategory seeded with 16 defaults, versioning (same fee name different sessions separate rows, historical transactions FK to original Fee confirmed via query, modifying a Fee row that has SUCCESS payments returns 400 and offers a "clone to new session" flow instead).
- **Pass Threshold**: >= 4
- **Evidence**: FeeCategory list endpoint returns 16 seeded categories + 1 admin-created; POST two Tuition fees for 2025/2026 and 2026/2027, verify they are separate rows not overwrites; a Payment created with feeId=1, then fee 1.amount patched to higher number, then GET /transactions/:id shows the amount paid is the ORIGINAL fee amount from payment time (not updated).

### AC-5: Fee Assignment Auto-Expands to Invoices
- **Type**: `rule`
- **Given**: A Programme "Computer Science" has 100 STUDENT users in DB. Fee "Tuition 2026/2027 CS 100L" exists.
- **When**: `POST /admin/fee-assignments/generate-invoices` body { assignmentId: PROGRAMME, programme: "Computer Science", feeIds: [tuitionFee.id] }
- **Then**: Exactly 100 Invoice rows created, one per matching student, invoiceNumber format INV-2026-NNNNNNNN with UNIQUE constraint enforced. Each Invoice.feeId === tuitionFee.id, Invoice.status === UNPAID, Invoice.amountDue === Tuition's amount (350000), Invoice.amountPaid === 0, balance computed column = amountDue.
- **Pass Condition**: DB Invoice count increased by exactly 100. Invoices for all 100 students present. A duplicate re-generation call (same assignmentId + same feeIds) skips and produces 0 new invoices for already-generated (upsert where not exists).
- **Evidence**: Pre-count, post-count SQL query on Invoices. Duplicate call returns 0 newly created count in response JSON.

### AC-6: Payment Initialization Never Trusts Client Amount
- **Type**: `rule`
- **Given**: An Invoice for 350000 NGN exists (status UNPAID). Student JWT authenticated.
- **When**: Two calls: (A) `POST /student/payments/initiate` body `{ invoiceId: X, amount: 1 }` includes a fake amount. (B) Same endpoint body `{ invoiceId: X }` with no amount.
- **Then**: Call (A) returns HTTP 400 InvalidRequest ("field 'amount' not allowed on this endpoint; amount is determined by the invoice"). Call (B) returns 200 with Paystack URL, and the stored Transaction.expectedAmount === 350000 (NOT any other value).
- **Pass Condition**: Call A status code 400. Call B Transaction DB row shows expectedAmount=350000 exactly. Paystack initialize payload's subunits match 350000*100 kobo exactly.
- **Evidence**: Two curl commands with JSON responses, Transaction DB row select.

### AC-7: Partial Payment State Machine + Invoice Ledger Balances
- **Type**: `rule`
- **Given**: Invoice amount 500000 NGN UNPAID.
- **When**: Payment 1 for 200000 succeeds (verify flow or webhook). Payment 2 for remaining 300000 succeeds.
- **Then**: After payment 1: Invoice.amountPaid = 200000, Invoice.balance = 300000, Invoice.status = PARTIALLY_PAID. Two distinct Transaction rows (payment IDs not reused, references unique PAY-*). After payment 2: Invoice.status PAID, balance 0. GeneralLedger entries exist for each payment, each with correct STUDENT_RECEIVABLE credit entry.
- **Pass Condition**: All 4 DB state values match expected after each step; ledger debit/credit net zero per transaction; 2 Transaction rows total; Invoice amountPaid is SUM(transaction success amounts).
- **Evidence**: Sequential DB state dumps after each step; GeneralLedger summary query by account.

### AC-8: Paystack Amount Protection
- **Type**: `rule`
- **Given**: Payment initialized for 350000, Transaction.expectedAmount = 350000.
- **When**: Mock Paystack verify endpoint returns 35000 (10% of expected) status="success".
- **Then**: Transaction.status set to UNDERPAID (or FAILED) — NOT SUCCESS. Invoice status does NOT change to PAID/PARTIALLY_PAID. No Receipt is generated. GeneralLedger has no credit entry. An AuditLog action `PAYMENT_UNDERPAID` is recorded.
- **Pass Condition**: All five state invariants hold (tx not SUCCESS, invoice unchanged, no receipt, no ledger credit, audit log present).
- **Evidence**: Mock verify service returns the tampered amount; state assertions via query.

### AC-9: Webhook HMAC + Idempotent Processing
- **Type**: `rule`
- **Given**: A valid Paystack event body for charge.success + correct HMAC-SHA512 signature on x-paystack-signature header.
- **When**: (Call 1) webhook endpoint receives event, responds 200 in <500ms. (Call 2) exact same body/signature resent 2 seconds later (retry).
- **Then**: Both calls return 200. WebhookEvent rows in DB: exactly 1 row with isProcessed=true, and 1 receipt/payment side effect. Call 2 causes no additional financial state change (no duplicate Transaction status update, no duplicate Receipt, no duplicate Ledger entry).
- **Pass Condition**: (a) Response time metric on call 1 <500ms. (b) WebhookEvent count=1 for this paystackEventId unique. (c) DB financial tables: no delta on call 2 vs call 1.
- **Evidence**: Timing wrapper on webhook call, duplicate call post DB counts.

### AC-10: Receipt Verify (Public) Only Returns Non-PII
- **Type**: `rule`
- **Given**: Existing Receipt REC-2026-000001 for student John Doe with matric 2024/CSC/001, phone 080xxx, email john@x.
- **When**: `GET /public/verify-receipt/REC-2026-000001` (NO Authorization header, curl from no-auth).
- **Then**: Response 200 JSON. Required present fields: receiptNumber, status("PAID"), amount, paidAt date-only, feeName, studentInitialsOnly ("JD"), last4OfMatric ("/001"). Forbidden fields ABSENT: full email, phone, address, studentId internal int, full firstName/lastName, full matric number.
- **Pass Condition**: JSON schema validation allows only 7 minimum fields; none of the 5 forbidden PII substrings are present anywhere in response body (including inside nested objects).
- **Evidence**: Schema validator script + response body grep.

### AC-11: Refund Immutable Original Transaction
- **Type**: `rule`
- **Given**: Transaction with id=42 status=SUCCESS amount=50000, Receipt id=9 for it.
- **When**: `POST /bursary/refunds` creates REFUND request of 50000; ADMIN approves; system marks Refund.status=PAID.
- **Then**: Transaction 42.amount remains 50000 (NOT mutated to 0), Transaction 42.status still SUCCESS. A NEW Transaction 92 with type=REFUND status=SUCCESS created (linked via metadata.parentTx=42). Invoice for 42.status becomes REFUNDED. Receipt 9 row is NOT deleted (or any other receipt hard delete). Receipt void marker set or separate void receipt created.
- **Pass Condition**: Tx42 original DB row untouched (before/after byte-identical for amount/reference/status). Tx92 NEW row exists with correct REFUND type. No DELETE query run against Receipt table during flow.
- **Evidence**: DB transaction trigger (temporarily for test) captures DELETE attempts and logs; manual SELECT of tx42 and new tx92.

### AC-12: Bursary Cannot Modify Completed Tx Amounts
- **Type**: `rule`
- **Given**: Bursary JWT user. Transaction id=100 status=SUCCESS amount=350000.
- **When**: `PATCH /bursary/transactions/100` body `{ amount: 0, status: REVERSED }` (malicious attempt).
- **Then**: HTTP 403 Forbidden. The rule at API-level code explicitly blocks any mutation of amount/reference on status=SUCCESS transactions for BURSARY. BURSARY also cannot reach `DELETE /admin/students/:id`.
- **Pass Condition**: 2 blocked actions → both 403. ADMIN attempting same via restricted endpoint → allowed (only ADMIN can reverse, and even then it must be via Refund flow not direct amount edit).
- **Evidence**: 2 curl commands with 403 response.

### AC-13: Full Admin Dashboard 16 KPIs Computed Correctly
- **Type**: `rule`
- **Given**: Seeded dataset (5 students, 10 fees, 14 transactions as current DB).
- **When**: `GET /admin/dashboard/stats`.
- **Then**: JSON contains exactly 13 specified counters/totals (totalStudents, activeStudents, totalFeesConfigured, totalBilled, totalPaid, totalOutstanding, todayPayments, weekPayments, monthPayments, successTx, pendingTx, failedTx, reversedTx) all with correct types (Decimal/numeric for currency, int for counts) and accurate values matching DB aggregation.
- **Pass Condition**: 13/13 KPIs present and match manual SQL aggregation of the same data (with 0 delta tolerance on counts, ±0.01 on money).
- **Evidence**: SQL manual count query + JSON response diff.

### AC-14: Powerful Transaction Search (§44)
- **Type**: `rubric`
- **Dimension**: Filter+pagination completeness of the Bursary transaction search endpoint
- **Scale**: 1-5
- **Anchors**: 1 = no endpoint. 3 = list endpoint with 3 filters. 5 = supports ALL §44 filters: dateFrom/dateTo, status, feeId, session, faculty, department, programme, level, channel. AND search params matric number substring, student name/email/phone substring, paymentRef exact, paystackRef exact. Pagination (page+pageSize+totalCount), sortable columns (amount ASC/DESC, date ASC/DESC). Returns all §44 columns with actions hrefs.
- **Pass Threshold**: >= 4
- **Evidence**: 9 distinct filter calls each returns correctly filtered subset; pagination pageSize=5 → returns exactly 5 and total>5.

### AC-15: Reports Export to 3 Formats
- **Type**: `rule`
- **Given**: Fee Collection Report with data (5 fee types).
- **When**: Call 3 times with `?format=csv`, `xlsx`, `pdf`.
- **Then**: All 3 responses succeed with 200 OK. CSV: Content-Type text/csv, contains header row + 5 rows. XLSX: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, opens as valid workbook with 1 sheet. PDF: application/pdf, header %PDF-1.x and non-trivial size (>= 10KB).
- **Pass Condition**: 3/3 export formats non-empty, correct MIME types, valid parsing.
- **Evidence**: curl Content-Type checks; file size checks; XLSX opens via exceljs `workbook.xlsx.read(buffer)` OK.

### AC-16: Student Payment Schedule UI Matches §16 Exactly
- **Type**: `rule`
- **Given**: Student has 3 invoices in DB (Tuition Partially Paid, Registration Paid, ICT Outstanding) in one session.
- **When**: Visit `/student/fees/schedule` in browser.
- **Then**: Visible rendered table: header row "Payment | Amount | Paid | Balance | Status". Data rows for 3 fees match DB currency formats and status labels (Part Paid / Paid / Outstanding with correct styling). Session groupings with per-session "Total" row. Dashboard KPI-like session totals.
- **Pass Condition**: Automated DOM query selector table>tr counts and cell textContent comparisons match the DB state perfectly for all 3 invoices + 1 totals row per session.
- **Evidence**: Puppeteer/Playwright browser DOM snapshot with cell values.

### AC-17: Zero TypeScript Build Diagnostics
- **Type**: `rule`
- **Given**: Clean install.
- **When**: Run `cd api && npx tsc --noEmit --strict` and `cd app && npx tsc --noEmit --strict`.
- **Then**: Both commands exit 0 with 0 errors, 0 warnings.
- **Pass Condition**: Exit codes both 0. No output text lines matching "error TS" or "warning TS".
- **Evidence**: Captured stdout of both commands.

### AC-18: RBAC Login Role Guards
- **Type**: `rule`
- **Given**: ADMIN user admin@university.edu.ng password admin123; STUDENT student1@university.edu.ng password student123; BURSARY finance@university.edu.ng.
- **When**: (1) Student email/password submitted to `/admin/login`. (2) BURSARY email submitted to `/student/login`. (3) ADMIN email submitted to `/admin/login`.
- **Then**: Case 1: `/admin/login` rejects with role mismatch (HTTP 401 or UI error "Admin account required"). Case 2: `/student/login` rejects. Case 3: `/admin/login` succeeds and redirects to `/admin/dashboard`. Correct cross-role rejection for each portal pair with clear error message.
- **Pass Condition**: 6/6 expected outcomes (3 roles × 3 portals) correctly accept or reject based on role.
- **Evidence**: Matrix test results table.

### AC-19: Existing Core Flows Not Regressed
- **Type**: `rule`
- **Given**: The previously-working student deposit to wallet flow, transfer flow, withdrawal approval flow.
- **When**: Execute the flows end-to-end after all code changes.
- **Then**: All 3 flows still succeed. Existing API endpoints `/wallet/deposit`, `/wallet/transfer`, `/bursary/withdrawals/:id/approve` behave identically for compatibility (backward compatible, no breakage of existing functionality from the widened platform buildout; endpoints can be deprecated with aliases but not removed).
- **Pass Condition**: Existing jest/supertest tests (health.test.ts plus new regression tests for those 3 endpoints) all pass.
- **Evidence**: `npm test` exit 0 in api/ with both existing + new regression tests.

### AC-20: Frontend All 25+ Pages Routable and Guarded
- **Type**: `rubric`
- **Dimension**: Coverage of UI routes with correct authentication + RBAC guards + proper navigation to all deep links from dashboard cards
- **Scale**: 1-5
- **Anchors**: 1 = 6 original pages only. 3 = 15 new pages present but not all guards correct. 5 = all 25+ pages render, `PrivateRoute` role checks correct for each path, missing roles sent to `/unauthorized` (which exists and displays actionable error), deep-links from dashboard cards actually navigate (e.g., clicking Admin dashboard "Pending transactions" card → /admin/transactions?status=PENDING with table filtered correctly).
- **Pass Threshold**: >= 4
- **Evidence**: Full route table walk-through snapshot; PrivateRoute redirection tests for each protected path with wrong role JWT.

## Open Questions

### Q1: University Branding Assets
The Receipt PDF requires university name, logo (PNG/JPG), official address, website URL, and contact email/phone for branding. Could you please provide:
- Full official university name (e.g., "Federal University of Technology X")
- Logo file path or URL (or confirm a placeholder is acceptable for now)
- Official address line 1-2
- Website URL (displayed on receipts; can be placeholder)
- Contact details (phone/email)

**Currently Assumed**: Placeholder values set via env vars `UNI_NAME`, `UNI_LOGO_URL`, `UNI_ADDRESS`, `UNI_WEBSITE`, `UNI_CONTACT` — which is an acceptable V1 deliverable if the values aren't available today.

### Q2: SMTP / Email Sending
§6 (password reset) and §35 (resend receipt by email) require SMTP. Options:
(a) Provide SMTP credentials now (HOST/PORT/USER/PASS/SECURE)
(b) Use placeholder nodemailer Ethereal test accounts in dev (emails logged to console only; never actually sent)
(c) Disable password reset + resend email UI buttons until SMTP is configured

**Currently Assumed**: (b) graceful placeholder behavior — UI buttons exist, email logic exists, if SMTP env vars not set emails log locally without crashing the app.

### Q3: Academic Session String Format
The spec mentions "2026/2027" as an example. Which format is standard at your institution?
(a) `YYYY/YYYY` (e.g., 2026/2027)
(b) `YYYY/YY` (e.g., 2026/27)
(c) Numeric session id code
(d) Other

**Currently Assumed**: (a) String `YYYY/YYYY` stored as VARCHAR, with validation pattern.

### Q4: Matric Number Regex Pattern
The spec requires matric number uniqueness and validation. What format does your university use? Example patterns:
- `2024/CSC/001` (Year/DeptCode/Serial)
- `CS/2024/00123`
- `MGS/2024/SCI/1001`
- Pure numeric

**Currently Assumed**: Flexible VARCHAR with optional slashes; uniqueness enforced, format validation left configurable in a `MATRIC_REGEX` env var or central constant.

### Q5: Redis Availability for BullMQ Webhook Queue
The current dev environment has Redis port 6379 CLOSED (per earlier nc check). We need to decide:
(a) Start Redis locally (brew services start redis / docker compose up redis) → full queue reliability.
(b) Keep Redis absent; fall back to synchronous webhook processing with idempotency keys only.

**Currently Assumed**: (b) graceful degraded mode if Redis connection fails on boot. Still idempotent per FR-H3. But loses retry semantics. Recommend choosing (a) for production-like behavior.
