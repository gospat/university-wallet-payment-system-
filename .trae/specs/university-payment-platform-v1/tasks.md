# University Student Payment Management Platform - Implementation Plan (tasks.md)

**Spec Reference**: `.trae/specs/university-payment-platform-v1/spec.md`
**Phase**: Plan (Pre-Approval)
**Total Tasks**: 25 (organized into 7 vertical releases)
**Coverage Map**: Every AC (AC-1 through AC-20) is covered by at least one task. Some tasks cover multiple ACs where information boundaries align.

---

## RELEASE 0 — FOUNDATION & SECURITY (Critical path; MUST ship first)

### Task 1: Security Hardening — Close Public Signup Role Escalation + Password Reset + Account Lockout
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: None
- **Description**:
  - Fix `POST /auth/signup` in [auth.ts](file:///Users/gloriousanjorin-adeboye/University%20payment%20gate-way%20/api/src/services/auth.ts#L28-L66) to strip/force `role=STUDENT` always.
  - Expand User model fields: `accountStatus` enum, `lastLoginAt`, `failedLoginAttempts`, `lockedUntil`.
  - `protect()` middleware: check accountStatus !== SUSPENDED.
  - Login flow increment failedLoginAttempts; >=5 → lockedUntil = now + 15min. Successful login resets both.
  - `POST /auth/forgot-password` (signed JWT reset token, 15m expiry) + `POST /auth/reset-password/:token` (validates payload).
  - `POST /auth/change-password` authenticated; requires currentPassword.
  - `GET /unauthorized` route + page created in app/.
  - `GET /404` route in app/.
  - Fix PrivateRoute to redirect role-mismatches to `/unauthorized` (which now exists) instead of dead-end.
  - Audit all 3 login portals for role-bugs (AdminLogin allowing BURSARY→AdminDashboard rejected; BursaryLogin allowing ADMIN→rejected; align both `AuthContext.navigate` and `PrivateRoute.roles` arrays).
- **Acceptance Criteria Addressed**: AC-1, FR-A1 to FR-A9, FR-S1
- **Test Requirements**:
  - `rule` TR-1.1: `curl` POST /auth/signup with `role:"ADMIN"` → persisted DB user.role is "STUDENT" (AC-1 pass condition exactly). Evidence: API response + Prisma user findOne.
  - `rule` TR-1.2: 5 sequential wrong-password attempts to /auth/login → 6th attempt returns 423 Locked; after 15 min forward-clock (test override) returns 200. Evidence: supertest sequence with timestamp mocks.
  - `rule` TR-1.3: /unauthorized route exists (HTTP 200 text/html), not 302→/login fallback. Evidence: curl + status code.
  - `rule` TR-1.4: Forgot-password flow: POST → token returned; POST reset-password → password changed in DB. Evidence: bcrypt.compare(newPw, hash) returns true.
  - `rubric` TR-1.5: Login portal role-split correctness. Scale 1-5; anchors 1=all role-bugs present, 3=2/3 portals correct, 5=all 3 accept matching role only with clear error message; threshold >= 4. Evidence: 9-case test matrix.
- **Notes**: Add migration `0002_add_account_status_fields`. Do NOT delete existing users; fields must be nullable-defaulted (ACTIVE).

### Task 2: Prisma Schema Expansion — Add ALL 9 Missing Tables + Enums
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: None (can be run in parallel with Task 1, but migrations must be applied before code uses new models)
- **Description**:
  - Write migration `0003_core_domain_models` to schema.prisma adding:
    - Enums: AccountStatus, StudentType, EntryMode, InvoiceStatus, RefundStatus, PaymentChannel (enum set with PAYSTACK_CHANNEL variants)
    - Models: FeeCategory, Fee, FeeAssignment, Invoice, Receipt, WebhookEvent, StudentImport, Refund, GeneralLedger (renamed WalletLedger with back-compat; keep WalletLedger as VIEW alias or maintain both)
    - Expand User model with all FR-B1 new fields; keep existing columns untouched.
    - Expand Transaction: add invoiceId? FK, paystackReference?, paystackChannel?, expectedAmount Decimal, expectedAmountCurrency String, underpaidReason?.
    - Expand Wallet; expand AuditLog per §38.
    - Add UNIQUE constraints: matricNumber, feeCode (per-session-scoped), invoiceNumber (global), receiptNumber (global), verificationToken (global), webhookEvent.paystackEventId, studentImport.importNumber, refund.refundNumber.
    - Add indexes for performance: Invoice (studentId, status, session), Transaction (status, userId, createdAt), Receipt (transactionId).
  - Run `npx prisma migrate dev --create-only` (review SQL).
  - Run `prisma generate` twice to ensure no drift.
- **Acceptance Criteria Addressed**: AC-2, AC-4 (db model part), FR-B1..B3, FR-D1, FR-E1, FR-F1, FR-J1, FR-H3, FR-C6, FR-K1, FR-I1..I4, FR-L1
- **Test Requirements**:
  - `rule` TR-2.1: Prisma introspection shows 14 tables (users, wallets, transactions, wallet_ledger, audit_logs PLUS 9 new). Evidence: `npx prisma db pull && cat prisma/schema.prisma | grep "model "` count = 14.
  - `rule` TR-2.2: Attempt INSERT duplicate matricNumber → DB throws unique violation (P2002). Evidence: test using prisma.user.create twice with same matric → catches P2002.
  - `rule` TR-2.3: Invoice.status enum contains ALL 8 values (UNPAID|PARTIALLY_PAID|PAID|PENDING|FAILED|REVERSED|REFUNDED|CANCELLED). Evidence: raw SQL `SHOW COLUMNS FROM invoices WHERE Field='status';`.
  - `rubric` TR-2.4: Migration SQL correctness and future-readiness. Scale 1-5; anchors 1=manual SQL errors, 3=works but no indexes, 5=indexes present, all nullable correct, foreign keys CASCADE/RESTRICT appropriate (financial FK = RESTRICT); threshold >= 4. Evidence: manual migration SQL code review output.

### Task 3: String Centralization + TypeScript Strict + Hardcoded API BaseURL Fix
- **Status**: `pending`
- **Priority**: `medium`
- **Depends On**: None
- **Description**:
  - Create `api/src/i18n/en.ts` and `app/src/i18n/en.ts` files — move every user-facing string (login labels, button texts, dashboard card titles, error messages) to constants exported from these files. Replace inline strings with imports.
  - Update both tsconfig.json to `"strict": true`.
  - Fix `app/src/services/api.ts` baseURL: change hardcoded `http://localhost:3000/api/v1` to `import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1'`. Add `.env.example` for app with `VITE_API_URL=http://localhost:3000/api/v1`.
  - Run `cd api && npx tsc --noEmit --strict` and `cd app && npx tsc --noEmit --strict`; fix every strict error encountered.
  - Add scripts in root package.json: `"typecheck": "cd api && npx tsc --noEmit --strict && cd ../app && npx tsc --noEmit --strict"`.
- **Acceptance Criteria Addressed**: AC-17 (partial baseline), FR-T3, FR-T2, FR-T5
- **Test Requirements**:
  - `rule` TR-3.1: `npm run typecheck` exit 0 with 0 errors, 0 warnings. Evidence: captured stdout matching spec AC-17 pass condition.
  - `rule` TR-3.2: grep for hardcoded user-facing English in TSX → results empty (strings imported only from i18n module). Evidence: grep report.
  - `rule` TR-3.3: App api.ts baseURL reads from import.meta.env.VITE_API_URL. Evidence: import.meta.env present in file AND hardcoded http://localhost not present without fallback guard.

### Task 4: Redis Graceful Degradation + BullMQ Webhook Queue Scaffold
- **Status**: `pending`
- **Priority**: `medium`
- **Depends On**: Task 2
- **Description**:
  - Create `api/src/config/queue.ts`: BullMQ Queue (`webhook:process`) + Worker. If ioredis connect fails 3 consecutive times, fall back to in-memory synchronous-dispatch (no throw, just warn). All enqueue logic goes through a helper `dispatchJob(name, payload)` that handles the Redis-absent fallback.
  - Expand paystack signature verify helper: extract to `api/src/utils/paystack.ts` with `verifyHmac(payload, headerSig)`.
  - Create webhook route handler scaffold `api/src/routes/webhooks.ts` — raw-body middleware (NOT express.json parsed before HMAC check!), CORS disabled.
- **Acceptance Criteria Addressed**: FR-H1..H4, Assumptions A3
- **Test Requirements**:
  - `rule` TR-4.1: With Redis absent (port 6379 closed), `dispatchJob` does not throw, returns synchronously. Evidence: unit test mocks Redis absent → dispatchJob resolves.
  - `rule` TR-4.2: HMAC verify: sign payload with PAYSTACK_SECRET_KEY → `verifyHmac` returns true; tamper 1 byte → returns false. Evidence: 2 test vectors (valid + tampered).
  - `rule` TR-4.3: Webhook route `/paystack/webhook` returns 200 in <500ms when Redis present (enqueue fast) AND Redis absent (sync fast). Evidence: time-to-last-byte measured via `curl -w '%{time_total}s'`.

---

## RELEASE 1 — STUDENT MANAGEMENT & BULK UPLOADS

### Task 5: Student CRUD API + Profile Endpoints
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 1, Task 2
- **Description**:
  - `GET /admin/students`: pagination (page, pageSize), filters: search (name, matric, email, phone fuzzy), college, department, programme, level, session, accountStatus.
  - `GET /admin/students/:id` full details.
  - `POST /admin/students` (ADMIN only, from §FR-B4): validates all new fields; matric immutable.
  - `PATCH /admin/students/:id` (ADMIN only); patch that attempts to mutate matricNumber → 400 "Immutable field".
  - `DELETE /admin/students/:id` → SOFT set accountStatus=WITHDRAWN; return 200 with success message, actual row NOT deleted. Add audit log USER_DELETED (soft).
  - `GET /student/profile`: STUDENT-only; returns own profile minus password hash; includes all FR-B1 fields.
  - `PATCH /student/profile`: STUDENT-only; allows contact (email verify first?), phone, address, changePassword embedded. BLOCKS mutations to academic fields (college, dept, programme, level, session, matric, studentType, entryMode, admissionYear, graduationYear).
  - Centralized `audit(action, entity, oldValue?, newValue?)` helper in `api/src/utils/audit.ts`; every mutation uses it. Attaches ipAddress and userAgent from req.headers. Audit log action enum matches §38 list.
- **Acceptance Criteria Addressed**: AC-2, FR-B1..B5, FR-L1..L3, FR-S2
- **Test Requirements**:
  - `rule` TR-5.1: POST /admin/students with all 20 FR-B1 fields → 201 + 20 fields echoed; GET matches. Evidence: AC-2 spec-aligned supertest.
  - `rule` TR-5.2: DELETE /admin/students/:id returns 200; subsequent `GET /admin/students/:id` shows accountStatus=WITHDRAWN; raw DB user row still present (not deleted). Evidence: 2 DB snapshots before+after DELETE.
  - `rule` TR-5.3: PATCH /student/profile with {college: "X"} from a STUDENT JWT → 400 "Cannot modify academic fields". Evidence: 400 status + error message.
  - `rubric` TR-5.4: Audit log completeness across all 6 student CRUD mutations. Scale 1-5; 1=no audit, 3=some, 5=every mutation has audit entry with userId, action, entity, entityId, ipAddress, correct old/new JSON where field changed; threshold >= 4. Evidence: SELECT COUNT(*) FROM audit_logs per mutation.

### Task 6: Bulk Student Upload 7-Step Pipeline + Import Logs + Error Download
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 2, Task 5
- **Description**:
  - Add dependencies: `xlsx` or `exceljs` (justified for CSV + XLSX parse). Add `papaparse` for CSV if lighter (choose one; justify).
  - Validate step `POST /admin/students/bulk/validate`:
    1. multipart file read; detect CSV vs XLSX by mimetype.
    2. Parse columns. Report columns detected.
    3. Row-level validators (§10 STEP 3).
    4. Duplicate detection (§10 STEP 4): both within-file and DB-against.
    5. Response shape §FR-C4: { total, validCount, duplicatesWithinFile, duplicatesInDb, missingMatric, invalidRecords, validRows[], errorRows[] }
  - Confirm step `POST /admin/students/bulk/confirm`: accepts file again OR accepts a validateToken signed JWT that encodes the validation results (avoids re-parsing). `duplicateStrategy: 'SKIP' | 'UPDATE' | 'CANCEL'` (default SKIP).
  - Creates StudentImport record per §11 with importNumber format `IMP-YYYY-NNNNNN`.
  - Each created/updated user set `studentImportId` FK.
  - `GET /admin/imports/students` list import history (paginated).
  - `GET /admin/imports/students/:id/errors.csv` returns CSV with header "row_number,matric_number,name,error_type,error_message,record_payload".
  - Fee bulk upload REUSES the same service layer abstractions (generic `BulkImportService<T>` with per-model validators).
- **Acceptance Criteria Addressed**: AC-3, FR-C1..C7, FR-M1..M3
- **Test Requirements**:
  - `rule` TR-6.1: 50-row CSV fixture (3 file-dup, 5 db-dup, 2 invalid). Validator returns counts exactly: total=50, valid=40, duplicatesWithinFile=3, duplicatesInDb=5, invalidRecords=2. Evidence: Validate response JSON snapshot against exact expected.
  - `rule` TR-6.2: Confirm with SKIP strategy → exactly 40 new DB users. Re-run identical confirm → 0 new users (idempotent confirm token). Evidence: pre-counts, post-counts, second confirm delta.
  - `rule` TR-6.3: StudentImport row created with importNumber matching regex /^IMP-\d{4}-\d{6}$/. Evidence: regex.test match.
  - `rule` TR-6.4: `errors.csv` download response: Content-Type text/csv, rows = 3+5+2 = 10 error rows + header line (11 total). Evidence: line count wc -l on response body.
  - `rubric` TR-6.5: Reusability of the generic BulkImportService for fees later. Scale 1-5; 1=one-off per-type, 3=shared base but heavy duplication, 5=abstracted, per-model validator plugin; threshold >= 4. Evidence: code structure of the service.

### Task 7: Admin Student UI Pages (List / Edit / Bulk Upload 7-Step)
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 5, Task 6 (frontend parallelizable after API is spec'd)
- **Description**:
  - `/admin/students` route: Reusable data table component with search input, filter chips (college, dept, programme, level, accountStatus), pagination, row actions (Edit, View Profile, Soft-Delete-with-confirm).
  - `/admin/students/:id/edit` page: Readonly matric (displayed disabled), editable academic fields, contact fields, status toggler. Save button calls PATCH. Form validation (zod schema mirror of backend).
  - `/admin/students/bulk-upload` page:
    - Step indicator: 1 Upload → 2 Validate → 3 Preview → 4 Confirm
    - Drag-and-drop CSV/XLSX zone
    - Step 2 shows counts card grid (valid, dups, invalid) with toggles to show valid vs error rows in table
    - Step 3 "Valid Records Preview" table + "Records Requiring Attention" error table; Download Error CSV button; Duplicate strategy radio (Skip default / Update / Cancel)
    - Step 4 Confirm modal → success counts summary + View Import History link
  - `/admin/imports` route: Import history table (student + fee tabs), filter, download error CSV action per row.
- **Acceptance Criteria Addressed**: AC-20 (pages coverage), FR-R1
- **Test Requirements**:
  - `rule` TR-7.1: New routes `/admin/students`, `/admin/students/bulk-upload`, `/admin/imports` all render with no React errors and pass PrivateRoute (ADMIN only). Evidence: snapshot tests + PrivateRoute redirect test.
  - `rubric` TR-7.2: 8px grid consistency + no shadow/transition (excluding focus outlines). Scale 1-5; 1=inconsistent, 3=mostly, 5=every component aligned, NO CSS shadows (grep for box-shadow returns 0, grep for transition returns 0 excluding focus); threshold >= 4. Evidence: visual DOM + CSS audit.
  - `rule` TR-7.3: Upload step "Confirm" disabled until validate step succeeds. Evidence: browser snapshot shows button disabled=true at step2-before-validate-call, enabled after.

---

## RELEASE 2 — FEE MANAGEMENT, ASSIGNMENTS, INVOICES

### Task 8: Fee Category + Fee CRUD + Fee Versioning API
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 2
- **Description**:
  - Seed migration `0004_seed_fee_categories`: 16 default fee categories (Tuition...Other Charges) from §14. Created by seeded admin user id=1.
  - `GET /admin/fees/categories`, `POST /admin/fees/categories`, `PATCH /admin/fees/categories/:id`, `DELETE /admin/fees/categories/:id` (DELETE only if 0 Fee rows reference it).
  - Fee CRUD per §FR-D4: `GET /admin/fees` (filters: session, category, college, dept, programme, level, isActive; pagination), `POST /admin/fees`, `PATCH /admin/fees/:id`.
  - Fee versioning enforcement: if Fee has related Invoices/SUCCESS Transactions, PATCH amount → 409 Conflict "Fee versioned; please create a new Fee for the new session or clone this fee to a new version". Offer endpoint `POST /admin/fees/:id/clone` that duplicates the Fee with an incremented version suffix / new session (user-provided session body field).
  - `POST /admin/fees/:id/activate` / `POST /admin/fees/:id/disable`. Only ADMIN + BURSARY.
- **Acceptance Criteria Addressed**: AC-4, FR-D1..D5, FR-M1..M3 (service layer reused)
- **Test Requirements**:
  - `rule` TR-8.1: Initial `GET /admin/fees/categories` returns 16 rows with names matching the 16 §14 categories. Evidence: JSON array count + name match.
  - `rule` TR-8.2: POST Fee 2025/2026 Tuition (amt 300k), POST Fee 2026/2027 Tuition (amt 350k) → 2 separate rows, no overwrite. Evidence: 2 rows present; GET /fees returns both.
  - `rule` TR-8.3: PATCH a Fee that has linked Invoices → 409 Conflict. Clone that fee → new Fee row created with 350k amount. Evidence: status code + new row.
  - `rule` TR-8.4: DELETE FeeCategory in-use → 400 with "Cannot delete: N fees reference this category". Evidence: correct error message + N count in body.

### Task 9: Fee Assignment Engine + Invoice Generation
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 8, Task 2 (Invoice table), Task 5 (students exist)
- **Description**:
  - `FeeAssignment` model CRUD:
    - `POST /admin/fee-assignments` body { feeId, assignmentType, targetIds… } (each assignment type uses different set of required fields).
    - `GET /admin/fee-assignments` (filters: assignmentType, feeId, session).
  - `POST /admin/fee-assignments/:id/generate-invoices`:
    - Runs a student matching query: given the assignment dimensions (programme X OR dept Y OR level Z OR session W OR single-student), select all User rows (role=STUDENT, accountStatus=ACTIVE) that match.
    - For each matching student: upsert Invoice (skip if Invoice with same studentId+feeId already exists for the fee's session / NOT double-invoiced).
    - Invoice numbers generated sequentially (counter per session + safe for concurrent run via DB transaction).
  - `POST /admin/fee-assignments/student`: manual single-student override.
  - Bulk fee upload `POST /admin/fees/bulk/validate` + `/confirm` using same generic BulkImportService from Task 6. Fee import validates §40 fields + duplicate feeCode detection (both within-file and DB). Records FeeImport rows.
- **Acceptance Criteria Addressed**: AC-5, FR-E1..E4, FR-M1..M3
- **Test Requirements**:
  - `rule` TR-9.1: 100-student cohort + 1 programme assignment → exactly 100 invoice rows. Re-run generate-invoices again → 0 new invoices (skip duplicates). Evidence: DB count delta = 100 on first call, 0 on second.
  - `rule` TR-9.2: invoiceNumber matches regex /^INV-\d{4}-\d{8}$/ and is globally unique (constraint enforced). Evidence: 2 invoice rows → different numbers, both match regex.
  - `rule` TR-9.3: Manual single-student assignment invoice correctly creates 1 Invoice with correct feeId and overrideAmount if provided (instead of fee.amount default). Evidence: amountDue in DB equals overrideAmount, not fee.amount.
  - `rubric` TR-9.4: Bulk Fee Upload validates all §40 fields. Scale 1-5; 1=basic only, 3=5/9, 5=all 9 fields plus duplicate feeCode within-file AND against-DB detections working; threshold >= 4. Evidence: test CSV with intentionally bad rows for each error type.

### Task 10: Student Fee Schedule + Invoice APIs + Frontend Pages
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 9 (invoices exist)
- **Description**:
  - Backend API:
    - `GET /student/fees/schedule`: STUDENT auth. Performs Invoice aggregation GROUP BY session → returns the §16 structure: sessionHeader { session, totalBilled, totalPaid, totalOutstanding }, rows [{ feeName, feeCategory, amountDue, amountPaid, balance, status: PAID|PARTIALLY_PAID|UNPAID|OVERDUE (based on deadline) }]. Formats currency, status labels internationalized.
    - `GET /student/invoices` (filters: session, status, dateFrom/dateTo, feeId; pagination) and `GET /student/invoices/:id` (detail with items, deadline, payment history against this invoice, links to pay).
    - Ownership guard: STUDENT fetching invoice id must verify invoice.studentId === req.user.id; else 404.
  - Frontend:
    - `/student/fees/schedule`: §16-styled grouped table (per session). Card summary (Total Billed / Paid / Outstanding). Rows colored distinctly by status (green Paid / amber Part-paid / red Outstanding). Click row → go to Invoice detail.
    - `/student/invoices` list filter UI (session tabs, status filter chips, date range).
    - `/student/invoices/:id`: detailed invoice page (§19 Payment Summary data + Pay button).
- **Acceptance Criteria Addressed**: AC-16, FR-F1..F4, FR-R1, FR-S2
- **Test Requirements**:
  - `rule` TR-10.1: Given 3 invoices (1 Paid, 1 Partially Paid, 1 Outstanding) in DB → /fees/schedule returns exactly 3 rows with those 3 status labels + amounts match DB balance math (amountDue - amountPaid = balance). Evidence: deep-equal JSON to expected fixture.
  - `rule` TR-10.2: Student A accesses GET /student/invoices/:id_of_StudentB → 404 (not 403). Evidence: HTTP status 404.
  - `rule` TR-10.3: Browser DOM for /student/fees/schedule shows exactly 3 data rows + totals row (AC-16 pass condition: "table>tr counts and cell textContent comparisons match the DB"). Evidence: Playwright/Puppeteer DOM snapshot.

### Task 11: Fee Management Frontend Pages (Fee List / Fee Category / Fee Assignment Rules / Generate Invoices / Fee Bulk Upload)
- **Status**: `pending`
- **Priority**: `medium`
- **Depends On**: Task 7 (table components reusable), Task 8, Task 9
- **Description**:
  - `/admin/fees` route: Fee CRUD table, with filters + new fee modal (all §13 fields). Clone fee button.
  - `/admin/fees/categories`: simple CRUD table.
  - `/admin/fee-assignments`: assignment rules list + "New Assignment" wizard (choose type → choose cohort/target → choose fee(s) → review affected student count → create rule + "Generate Invoices now?" checkbox).
  - `/admin/fees/bulk-upload`: reuse the bulk upload wizard component from Task 7 with fee-specific validators.
- **Acceptance Criteria Addressed**: AC-4 (UI part), AC-20
- **Test Requirements**:
  - `rule` TR-11.1: All 4 new routes render. Evidence: route walkthrough 200 statuses.
  - `rubric` TR-11.2: Component reuse from Task 7 wizard. Scale 1-5; 1=total rewrite, 3=partial, 5=UploadWizard component parameterized with per-model validator plugin; threshold >= 4. Evidence: component tree.

---

## RELEASE 3 — PAYMENTS, PAYSTACK, WEBHOOK, LEDGER

### Task 12: Correct Payment Flow (Invoice→Backend Calculated Amount→Paystack→Verify→Ledger→Receipt)
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 2 (all tables), Task 4 (HMAC helpers), Task 9 (Invoices)
- **Description**:
  - Fix/augment PaystackService in `api/src/services/paystack.ts`:
    - Remove the fixed N2,000 + N2,000 hardcoded charges from initializeTransaction — they do not belong to a university fee platform's payment (the university should be charging the exact invoice.amount; if a service charge applies it must be a configurable percentage/flat via env with ledger entry, NOT a hardcoded hack).
    - Add channel support from env: PRAYSTAK_ENABLED_CHANNELS comma-split. Pass `channels` array to Paystack /transaction/initialize body per FR-Q1.
    - Verify function returns full tx object.
  - Add `api/src/services/payments.service.ts` (FEE_PAYMENT orchestration):
    - `initiatePayment(studentId, invoiceId, optionalPartialAmount?)` → FR-G1..G4.
      - Checks invoice balance (not amountDue) → computes `payableAmount = min(optionalPartialAmount, balance) || balance`.
      - Rejects if body contains standalone `amount` field (FR-G2 400).
      - Creates PENDING Transaction with PAY-YYYYMMDD-<6hex> reference (FR-G3), metadata per §22.
      - Calls Paystack initialize. Stores paystack reference on Transaction.metadata.paystackRef.
      - Returns { authorization_url, access_code, payment_reference }.
    - `verifyPayment(paystackReference)` → FR-G5..G8 + FR-I ledger writing (atomic Prisma.$transaction):
      1. Calls Paystack verify.
      2. Compares `verify.amount/100` vs Transaction.expectedAmount with tolerance 1 subunit (NGN kobo).
      3. Mismatch → set UNDERPAID/OVERPAID status; DO NOT credit ledger; DO NOT mark invoice PAID; record audit log PAYMENT_UNDERPAID.
      4. Match → update Transaction to SUCCESS (using `updateMany` with `where status=PENDING` guard for race safety).
      5. Credit Invoice.amountPaid += amountPaid; compute new balance; set Invoice.status = PAID if balance===0 else PARTIALLY_PAID if amountPaid>0 else UNPAID.
      6. Create GeneralLedger entries per FR-I2/I3 (CASH_CLEARING debit, STUDENT_RECEIVABLE credit; also if service charge was configured, credit SERVICE_CHARGE_INCOME; gateway fee (if deducted by Paystack) debit UNIVERSITY_EXPENSES_FEE). Balance after per account computed and stored.
      7. Create Receipt row (FR-J2), generate verificationToken crypto random, receiptNumber REC- format.
      8. Credit Wallet if needed (backward-compat for existing wallet-based flows; keep working).
  - Routes:
    - `POST /student/payments/initiate` (student auth) → calls initiatePayment.
    - `GET /student/payments/verify/:paystackRef` (student auth) → calls verifyPayment + redirects or returns JSON.
- **Acceptance Criteria Addressed**: AC-6, AC-7, AC-8 (partially), FR-G1..G7, FR-I1..I4, FR-J1..J2, FR-Q1..Q2
- **Test Requirements**:
  - `rule` TR-12.1: POST /student/payments/initiate with body {invoiceId, amount: 1} → 400 "field not allowed". Initiate same invoice without amount → 200 + DB expectedAmount = invoice.balance exactly. Evidence: AC-6 pass condition curl output.
  - `rule` TR-12.2: Partial payment flow: invoice 500k, pay 200k → Invoice.amountPaid=200k, balance=300k, status=PARTIALLY_PAID; second pay of 300k → status=PAID. Distinct 2 Transaction rows with unique PAY-ref. Evidence: step-by-step state dumps AC-7.
  - `rule` TR-12.3: Mock Paystack verify returns 35k (expected 350k) → tx UNDERPAID, Invoice.status unchanged, no Receipt created, audit PAYMENT_UNDERPAID logged. All 5 AC-8 invariants hold. Evidence: state assertion against AC-8 pass list.
  - `rule` TR-12.4: GeneralLedger balance correctness: for each SUCCESS payment, debits sum = credits sum (double entry). Evidence: SQL `SUM(debit) - SUM(credit) grouped by transaction` returns 0.00 for all TX processed.
  - `rubric` TR-12.5: Service charge handling correctness + channel support. Scale 1-5; 1=hardcoded fees still there, 3=removed but no config, 5=removed hardcoded N4k; service charge configurable via env as flat/percent with proper SERVICE_CHARGE_INCOME ledger entry; Paystack channels array passed correctly and stored into Receipt.paymentChannel; threshold >= 4. Evidence: config reads + Receipt db inspect.

### Task 13: Webhook Endpoint, Idempotent Persistence, BullMQ Processing Worker
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 4 (queue), Task 12 (verify service)
- **Description**:
  - `POST /api/v1/payments/webhooks/paystack` dedicated route (CORS off, raw-body, no express.json before it):
    1. HMAC verify → 401 fail.
    2. Parse event.id, event.event, event.data.reference.
    3. INSERT WebhookEvent row: paystackEventId UNIQUE (upsert with ignore if already present; if isProcessed=true → early return 200).
    4. Set isProcessed=false; persist payload JSONB.
    5. Enqueue BullMQ job `webhook:process { webhookEventId }`. (Or Redis absent: sync call processWorker(webhookEventId)).
    6. Response 200 OK empty body within 500ms.
  - Worker handler `processWorker`:
    1. Load WebhookEvent.
    2. If already processed, return ack.
    3. Switch on event.type:
      - `charge.success`: call verifyPayment(paystackRef) from Task 12; same idempotency guards.
      - `charge.failed`: update Transaction status FAILED. Audit.
      - `refund.processed`: update Refund.status PAID, mark related Transaction.amount ledger reversal, invoice.status REFUNDED if full refund.
      - `refund.failed`: update Refund.status FAILED, notes field populated with error.
    4. UPDATE WebhookEvent SET isProcessed=true, processedAt=NOW().
  - Endpoint: `GET /bursary/webhooks/events` for BURSARY to debug/reprocess failed webhooks.
- **Acceptance Criteria Addressed**: AC-9, FR-H1..H5, FR-K3 (refund processed event), FR-Q (channel from event)
- **Test Requirements**:
  - `rule` TR-13.1: Valid charge.success call → HTTP 200, time-to-last-byte < 500ms. Duplicate call 2 seconds later → no financial state change. Evidence: timing + DB counts (payment, receipt, ledger rows unchanged on call 2).
  - `rule` TR-13.2: WebhookEvent UNIQUE constraint: INSERT same eventId twice → P2002 (duplicate) handled gracefully (upsert-ignore). Evidence: test code attempts double insert with no uncaught throw.
  - `rule` TR-13.3: Wrong signature → 401. Evidence: curl status code.
  - `rule` TR-13.4: charge.failed event → Transaction.status FAILED set from PENDING. Audit FAILED_TX entry. Evidence: DB status + audit log.
  - `rubric` TR-13.5: Worker error resilience + retry. Scale 1-5; 1=single try, 3=3 retries without backoff, 5=BullMQ attempts=3 with backoff, dead-letter queue; threshold >= 4. Evidence: BullMQ Queue options object + failed DLQ row after 3 failures.

---

## RELEASE 4 — RECEIPTS, VERIFICATION, REFUNDS

### Task 14: Receipt PDF Service (Branded) + In-Browser View + Download Endpoints
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 12 (persisted Receipt rows available)
- **Description**:
  - Receipt PDF Generation (augment `services/receipt.ts`):
    - Read branding from env: UNI_NAME, UNI_LOGO_URL, UNI_ADDRESS, UNI_WEBSITE, UNI_CONTACT.
    - Use exact WAT timezone; display Date & Time formatted per §31/32 (e.g., "18 September 2026 / 14:32:08 WAT") from server-side paidAt DateTime, NEVER client clock.
    - All §31 fields present: student info, fee, session, amount, date/time, paymentRef, paystackRef, channel, status, receiptNumber, date generated, verification code.
    - QR code encodes the verify URL, e.g., `${APP_PUBLIC_URL}/public/verify-receipt/${receipt.verificationToken}`.
    - "PAID" diagonal watermark on every page; footer "This is an authorized system-generated receipt. Printed receipts do not require a signature."
    - Use no shadow/transition CSS per user profile preferences.
  - Endpoints:
    - `GET /student/receipts/:ref/download` → STUDENT ownership check OR ADMIN/BURSARY: streams PDF, Content-Type application/pdf, Content-Disposition attachment.
    - `GET /student/receipts/:ref/view` → returns in-browser rendered HTML preview (same content without PDF wrapper; has Download PDF button).
    - Authenticated `GET /admin/receipts`: filters (ref, student, date, fee, status), actions view metadata / download / resend-email.
    - Resend: `POST /admin/receipts/:ref/resend-email` — uses nodemailer; if SMTP absent, logs locally (per Assumption A2).
  - Frontend pages: `/student/receipts/:ref/view` page; Bursary Dashboard Receipt tab links.
- **Acceptance Criteria Addressed**: AC-10 (partial), FR-J3, FR-J5, FR-R1
- **Test Requirements**:
  - `rule` TR-14.1: PDF download → file size >= 30KB, starts with `%PDF-1.`, page count >= 1, all §31 fields detected in PDF text extraction (pdf-parse). Evidence: pdf-parse output string contains receiptNumber, feeName, amount, studentName, matric, PAID, verification URL.
  - `rule` TR-14.2: PDF displays server timestamp. Extract timestamp; compare with DB paidAt DateTime Africa/Lagos — they match (delta < 2 min). Evidence: compare dates.
  - `rule` TR-14.3: `/student/receipts/:wrong_student_ref/download` → STUDENT forbidden 404; ADMIN allowed 200. Evidence: status codes.
  - `rubric` TR-14.4: Branding quality. Scale 1-5; 1=unbranded text-only, 3=some fields, 5=university header with name/logo/address/contact, all 17 §31 fields, QR visible, no shadows, PAID watermark, A4; threshold >= 4. Evidence: visual screenshot.

### Task 15: Public Receipt Verification Endpoint + UI Page
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 14
- **Description**:
  - Backend: `GET /public/verify-receipt/:referenceOrToken` — NO auth required. Supports both receiptNumber (REC-2026-NNNNNN) OR verificationToken (24char random). Returns JSON containing ONLY the 7 minimum non-PII fields of FR-J4: receiptNumber, status, amount, paidAt date-only, feeName, studentInitialsOnly (first+last initials), last4OfMatric. Does NOT expose email, phone, address, internal IDs.
  - UI public route: `/public/verify-receipt/:referenceOrToken` renders a clean confirmation card: green check PAID + 7 fields. If receipt NOT found: "This receipt number is not valid" error. NO PII on the error page either.
  - Bursary UI: `/bursary/receipts/verify` page with two entry methods: (a) input receipt number / verification token directly; (b) **scanner simulation** (paste screenshot's QR decoded text manually for now; real camera scanning can be a later task).
- **Acceptance Criteria Addressed**: AC-10, FR-J4
- **Test Requirements**:
  - `rule` TR-15.1: Public endpoint JSON response contains EXACTLY the 7 allowed keys. Schema validation with zod-strict rejects any extra fields. Evidence: zod strict parse passes with 7 keys ok; `.passthrough()` count === 7.
  - `rule` TR-15.2: Grep response body for forbidden PII: full matric number (e.g., "2024/CSC/001"), "@" (email), any 10-digit phone number — all must return zero matches. Evidence: grep count = 0.
  - `rule` TR-15.3: studentInitialsOnly = "JD" for John Doe; last4OfMatric = substring(string.length - 4). Evidence: unit test against known names.

### Task 16: Refunds Workflow (Request → Approve → Paystack Refund → Ledger Reversal) + Immutability Tests
- **Status**: `pending`
- **Priority**: `medium`
- **Depends On**: Task 12, Task 13 (refund webhook event)
- **Description**:
  - Backend API:
    - `POST /bursary/refunds` (BURSARY role): creates Refund REQUESTED status.
    - `GET /bursary/refunds`: filters (status, date, student, originalTx).
    - `POST /admin/refunds/:id/approve` (ADMIN only!): status=APPROVED → calls Paystack `/refund` API; stores paystackRefundReference; sets Refund.status=PAID when webhook arrives.
    - `POST /admin/refunds/:id/reject` (ADMIN only): status=REJECTED, mandatory notes reason body.
    - Immutability middleware or controller guards for BURSARY per FR-S3: any PATCH Transaction amount/reference if Transaction.status === SUCCESS → 403 "Immutable field on completed transaction". Must use Refunds instead.
  - Frontend UI: `/bursary/refunds` table: actions (Request Refund modal on any SUCCESS transaction), `/admin/refunds` table Approve/Reject buttons w/ confirm.
- **Acceptance Criteria Addressed**: AC-11, AC-12, FR-K1..K4, FR-S3
- **Test Requirements**:
  - `rule` TR-16.1: Successful payment TX 42 → refund full; tx42.amount DB row identical before vs after (byte-for-byte original). Evidence: compare SELECT * output hex hashes pre/post refund → SHA256 match.
  - `rule` TR-16.2: New REFUND Transaction exists with type REFUND status SUCCESS linked via metadata.parentTx. Evidence: SELECT metadata parentId.
  - `rule` TR-16.3: BURSARY PATCH /bursary/transactions/:id {amount:0} with SUCCESS tx → 403; ADMIN same endpoint via restricted mutation path still 403 but allowed to CREATE a Refund (not edit). Evidence: AC-12 two-403 curl commands.
  - `rubric` TR-16.4: Refund → ledger reversal correctness: full refund debits UNIVERSITY_INCOME and credits STUDENT_RECEIVABLE; balance equations per account preserved. Scale 1-5; 1=ledger unmoved, 3=partial, 5=100% correct double-entry, Invoice.status=REFUNDED, Receipt void marker set (not deleted); threshold >= 4. Evidence: balance audit query.

---

## RELEASE 5 — ADMIN DASHBOARD + BURSARY TOOLS

### Task 17: Admin Dashboard Stats Endpoint + 16 KPI Cards + Clickable Filters
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 2 (tables with Invoice/Transaction/Fee/Student counts available)
- **Description**:
  - Backend: `GET /admin/dashboard/stats` (ADMIN only). Computes ALL §4 KPIs. Use Prisma aggregation ($transaction with 16 concurrent raw aggregations — or use views for performance).
    - Counters: totalStudents (count users role=STUDENT), activeStudents (accountStatus=ACTIVE), totalFeesConfigured (count Fee), successTx/pendingTx/failedTx/reversedTx (Transaction.status counts).
    - Money sums (Invoice aggregates): totalBilled = SUM(invoice.amountDue), totalPaid = SUM(invoice.amountPaid), totalOutstanding = totalBilled - totalPaid.
    - Date-range: todayPayments (Transaction SUCCESS createdAt = today), weekPayments (last 7 days), monthPayments (this calendar month).
    - Embedded recent lists: recentPayments (last 10 Transaction SUCCESS), recentStudents (last 10 User created DESC), recentFees (last 10 Fee created DESC).
  - Frontend `/admin/dashboard`: expand skeleton. 16 KPI cards in responsive grid. Cards are React Router Link-wrappers to `/admin/students`, `/admin/transactions?status=PENDING`, `/admin/reports/fee-collection`, etc. Every card has onClick deep-link with the appropriate query parameters mapped to that card's filter.
- **Acceptance Criteria Addressed**: AC-13, FR-N1..N3, AC-20
- **Test Requirements**:
  - `rule` TR-17.1: Stats endpoint returns 13 numeric fields. Every numeric equals manual SQL aggregation of same data (±0.01 Decimal tolerance). Evidence: SQL raw aggregates JSON vs API response JSON deep-equal with rounded money.
  - `rule` TR-17.2: Click "Pending transactions" card → URL changes to `/admin/transactions?status=PENDING`; table shows only pending; similar checks for Today/This week/This month with dateFrom filter in URL. Evidence: Playwright click + inspect URL + table rows filtered.
  - `rubric` TR-17.3: Card layout 8px alignment, edge-to-edge header, responsive works at 360px width (cards stack), up to 4K (cards fill 4 columns). Scale 1-5; 1=breaks, 3=works medium, 5=pixel-perfect alignment both ends no overflow; threshold >= 4. Evidence: 2 screenshots at 360px + 3840px widths.

### Task 18: Bursary Transaction Search (44) + Student Financial Profile (30)
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 2 (indexes), Task 5 (students), Task 12 (tx/fee/invoice joins)
- **Description**:
  - API `GET /bursary/transactions` — full §44 table:
    - Returned columns: transactionId, paymentRef, paystackRef, student name, matricNumber, feeName, amount, paystackChannel, status, date, receiptNumber, actions (view, downloadReceipt, requestRefund).
    - Filters: ALL §44 list → dateFrom/dateTo, status, feeId, session, faculty, department, programme, level, channel. Search params: q (substring match name/matric/email/phone, paymentRef exact, paystackRef exact). Pagination + sortable columns.
  - API `GET /bursary/students/search?query=...`: fuzzy (ILIKE on name,matric,email,phone), top 20 results, fields: id, name, matric, email, dept, level.
  - API `GET /bursary/students/:id/financial-profile` → §30 structure exactly: student summary (id, name, matric, programme, level, session), financialSummary{billed, paid, outstanding}, paginated paymentHistory, invoices list.
  - Frontend:
    - `/bursary/transactions` page: filter sidebar, results data table, export dropdown.
    - `/bursary/students/:id/financial-profile`: header card, summary KPI tiles, payment timeline, invoices accordion.
- **Acceptance Criteria Addressed**: AC-14, FR-O1..O3
- **Test Requirements**:
  - `rule` TR-18.1: 9 distinct filter invocations (status, feeId, session, dateFrom/dateTo, dept, programme, level, channel, q search) — each returns only matching rows; totalCount accurate. Evidence: per-filter JSON row count matches expected.
  - `rule` TR-18.2: Student financial profile: billed=SUM invoice amountDue, paid=SUM amountPaid, outstanding=billed-paid computed by endpoint matches hand-calculated SQL. Evidence: equality check.
  - `rubric` TR-18.3: Performance, 10k transactions dataset, filtered API call returns <800ms. Scale 1-5; 1=>5s, 3=2s, 5=<800ms; threshold >= 4. Evidence: timing from curl -w '%{time_total}'.

---

## RELEASE 6 — REPORTS, EXPORTS, EXISTING-FLOW REGRESSION

### Task 19: Reports Engine (8 Report Types) + 3 Export Formats
- **Status**: `pending`
- **Priority**: `medium`
- **Depends On**: Task 17 (same aggregation layer), exceljs/csv-writer/pdf puppeteer from Tasks 6/14
- **Description**:
  - Reports endpoints under `/admin/reports/*`:
    - DailyCollection, MonthlyCollection, SessionCollection, FeeCollection, DepartmentReport, FacultyReport, ProgrammeReport, LevelReport, StudentReport.
  - Each report accepts filters (§42 lists) and `?format=json|xlsx|csv|pdf` (default JSON).
  - Report service uses shared abstractions: `buildReport(reportId, filters)` → dataRows, `export(data, format)` → stream.
  - FeeCollection report matches §42 example table: | Fee | Billed | Paid | Outstanding |.
  - Frontend `/admin/reports` hub: tiles for each report type, shared filter form (dateFrom/dateTo, session, fee, dept, level, programme), format selector dropdown (JSON/XLSX/CSV/PDF), "Generate Report" button.
- **Acceptance Criteria Addressed**: AC-15, FR-P1..P3, FR-43
- **Test Requirements**:
  - `rule` TR-19.1: Fee Collection report with fixture data (5 fee types) → 3 formats: CSV has 5 data lines, XLSX opens with workbook.sheet.length=1 and row count=6 (header+5), PDF is >=10KB and header %PDF present. Evidence: 3 passes.
  - `rule` TR-19.2: Filter application: Session filter set → only rows for that session appear. Evidence: report data rows all match session column.
  - `rubric` TR-19.3: PDF report layout professional (title, filters summary row, table, totals footer, page numbers, no shadow). Scale 1-5; threshold >= 4. Evidence: screenshot.

### Task 20: Existing Flow Regression Suite + New Tests
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Every earlier task (runs at the end to confirm nothing broken)
- **Description**:
  - `npm test` setup with jest/supertest in api/:
    - Existing `health.test.ts` kept.
    - New regression tests:
      - Wallet deposit → verify → balance increases (existing flow preserved, new fee flow also works).
      - Transfer → both wallets adjust correctly.
      - Bursary approve withdrawal → wallet withdrawal success.
  - All new endpoints covered by integration tests (at least one per CRUD).
  - `npm run typecheck` updated to pass strictly.
- **Acceptance Criteria Addressed**: AC-19, FR-15 non-goals (backward compat)
- **Test Requirements**:
  - `rule` TR-20.1: `cd api && npm test` → suite PASS, no skipped tests on core 3 existing flows. Exit 0.
  - `rule` TR-20.2: Endpoint deprecation: existing aliased routes `/wallet/deposit`, `/wallet/transfer`, `/wallet/verify/:reference` still 200 OK. Evidence: 3 curl calls.
  - `rubric` TR-20.3: Test coverage >= 75% lines on services, controllers. Scale 1-5; 1=<40%, 3=60%, 5=>=75%; threshold >= 4. Evidence: jest --coverage report summary.

---

## RELEASE 7 — FINAL POLISH, REMAINING FRONTEND PAGES, FULL RBAC MATRIX

### Task 21: Remaining Student Dashboard UIs (Profile, Payments Checkout/Callback, Transfer, Withdraw)
- **Status**: `pending`
- **Priority**: `medium`
- **Depends On**: Task 5, 10, 12, 14
- **Description**:
  - `/student/profile`: view-only fields (matric, level, session) greyed; editable fields (phone, address, email) with save. Change password card (current + new + confirm).
  - `/student/payments/checkout/:invoiceId` (§19): Payment Summary page (Student, Matric, Fee, Session, Amount Due, Already Paid, Outstanding, Amount to Pay). "Proceed to Pay" confirmation. Calls initiatePayment → redirects to Paystack authorization_url.
  - `/student/payments/callback/:paystackRef`: Loading spinner → calls verify endpoint → Success card (redirect to invoice detail / receipt view) OR Failure card with reason + retry button.
  - `/student/transfer`: Existing `/wallet/transfer` endpoint UI — Form: recipient matric, amount, confirm pin/note. Confirmation modal.
  - `/student/withdraw`: Existing `/wallet/withdraw` endpoint UI — Bank details form, amount, submit. Status message + pending indicator.
- **Acceptance Criteria Addressed**: AC-20, FR-R1 (missing student pages)
- **Test Requirements**:
  - `rule` TR-21.1: All 5 new student pages render. Evidence: 5 route snapshots.
  - `rubric` TR-21.2: Paystack checkout flow E2E (with mock Paystack redirect). Scale 1-5; 1=steps missing, 3=some error states unhandled, 5=checkout→Paystack mock→callback→verify→success card works; threshold >= 4. Evidence: browser E2E recording.

### Task 22: Bursary Dashboard KPIs + Pending Withdrawals as Tab Not Only Dashboard
- **Status**: `pending`
- **Priority**: `medium`
- **Depends On**: Task 17 (same patterns), Task 18
- **Description**:
  - Bursary dashboard stats endpoint `GET /bursary/dashboard/stats`: today's/week/month's collections totals; pending withdrawal count; pending fee receivables (unpaid invoices total); successful refunds count.
  - Bursary Dashboard UI: cards + navigation tabs to Transactions, Students Search, Receipt Verification, Refunds.
  - Fix BursaryLogin PrivateRoute: allow both BURSARY and ADMIN to view `/bursary/dashboard`.
- **Acceptance Criteria Addressed**: FR-O section bursary-specific missing dashboard, AC-20, FR-A9
- **Test Requirements**:
  - `rule` TR-22.1: Admin JWT accessing /bursary/dashboard (after PrivateRoute fix) → HTTP 200, renders. Evidence: browser status.
  - `rubric` TR-22.2: Bursary KPIs correctness vs DB aggregates. Scale 1-5; threshold >= 4. Evidence: SQL vs stats JSON.

### Task 23: Full RBAC Matrix Backend Test Suite + Audit Log Browser
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 1, 5, 8, 12, 16
- **Description**:
  - Backend: `GET /admin/audit-logs` paginated, filters: action, entity, userId, dateFrom/dateTo, entityId search.
  - Frontend `/admin/audit-logs` page: filter sidebar, data table, JSON details modal for oldValue/newValue diff.
  - Full RBAC matrix supertest suite: every mutation endpoint called with STUDENT, BURSARY, ADMIN tokens. Expected 200/403/401 matrix captured in `__tests__/rbac-matrix.test.ts` and serialized as an auto-documented spec table in comments.
- **Acceptance Criteria Addressed**: FR-A9, FR-L1..L4, FR-S1..S3, AC-12 (backed by unit test)
- **Test Requirements**:
  - `rule` TR-23.1: Audit logs table non-empty after running all tests; /admin/audit-logs endpoint returns 200 + pagination metadata. Evidence: count > 0.
  - `rule` TR-23.2: RBAC matrix: every expected 403 case returns 403; ADMIN on bursary-only endpoints passes; STUDENT on all admin/bursary endpoints fails. Pass threshold 100%. Evidence: test pass/fail count.

### Task 24: Full Frontend PrivateRoute Guards Test + All 25+ Pages List Walkthrough
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Tasks 7, 11, 15, 17, 18, 19, 21, 22
- **Description**:
  - Ensure every route in App.tsx updated to cover pages, PrivateRoute roles arrays correct per spec.
  - `/admin` routes: restrictTo `ADMIN` only for admin-only (student-delete, role change, settings); BURSARY allowed for bursary-accessible pages in admin menu.
  - Missing routes added: `/unauthorized`, `/404`, public verify-receipt, student/transfer, student/withdraw, etc.
  - Add a Navbar sidebar (or top-nav dropdown) per portal linking to all pages with proper aria-current=page on active.
- **Acceptance Criteria Addressed**: AC-18, AC-20
- **Test Requirements**:
  - `rule` TR-24.1: App route count from `<Route` JSX elements >= 25 (FR-R1 list count). Evidence: grep -c "<Route" in App.tsx.
  - `rule` TR-24.2: AC-18 role-portal matrix: 6/6 portal-login reject/accept cases work. Evidence: test log matrix.
  - `rubric` TR-24.3: Dashboard card deep-links + sidebar nav aria-current correct. Scale 1-5; threshold >= 4. Evidence: click 3 dashboard cards + 5 sidebar items → URL + aria-current verified.

### Task 25: Final "Zero Diagnostics" + Final Builds + Documented Startup Script
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: All prior tasks (final integration)
- **Description**:
  - Run `npm run typecheck`, fix any remaining stray strict errors.
  - `cd api && npm test` — all passing.
  - `cd api && npm run build && cd app && npm run build` — both production builds exit 0.
  - Root `README.md` updated (only if requested by user; normally avoid creating README unless explicitly requested — but since this is SPEC MODE operational output only; if README exists we add a startup section to the EXISTING file; never create new docs unless asked).
  - Final package.json script aliases.
- **Acceptance Criteria Addressed**: AC-17, AC-19 (builds complete)
- **Test Requirements**:
  - `rule` TR-25.1: `typecheck` 0 errors 0 warnings. Evidence: captured output.
  - `rule` TR-25.2: Both `npm run build` sub-projects exit code 0. Evidence: exit codes in shell $? captured.
  - `rule` TR-25.3: app production `dist/` size: index.html + assets sum < 500KB (CSS no-shadow/transition optimization goal; met by Tailwind 4). Evidence: du -sk.

---

## Coverage Map: AC → Task Traceability Table

| AC ID  | Covered Primarily By Tasks |
|--------|----------------------------|
| AC-1   | Task 1 (TR-1.1) |
| AC-2   | Task 2 (TR-2.1..2.3), Task 5 (TR-5.1) |
| AC-3   | Task 6 (TR-6.1..TR-6.4) |
| AC-4   | Task 2 (DB), Task 8 (TR-8.1..8.4), Task 11 (UI) |
| AC-5   | Task 9 (TR-9.1..TR-9.3) |
| AC-6   | Task 12 (TR-12.1) |
| AC-7   | Task 12 (TR-12.2) |
| AC-8   | Task 12 (TR-12.3) |
| AC-9   | Task 13 (TR-13.1..TR-13.4) |
| AC-10  | Task 14 (base), Task 15 (TR-15.1..TR-15.3) |
| AC-11  | Task 16 (TR-16.1..TR-16.2) |
| AC-12  | Task 16 (TR-16.3), Task 23 (RBAC test) |
| AC-13  | Task 17 (TR-17.1) |
| AC-14  | Task 18 (TR-18.1..TR-18.3) |
| AC-15  | Task 19 (TR-19.1..TR-19.3) |
| AC-16  | Task 10 (TR-10.3) |
| AC-17  | Task 3 (baseline), Task 25 (final) |
| AC-18  | Task 1 (TR-1.5), Task 24 (TR-24.2) |
| AC-19  | Task 20 (TR-20.1..TR-20.3), Task 25 |
| AC-20  | Task 7 (admin pages), Task 11 (fee mgmt UI), Tasks 15/17/18/21/22/24 |

**Coverage Theorem**: 20/20 ACs have >= 1 explicit primary task + >= 1 rule/rubric TR. No orphan ACs.

---

## Dependency Graph (Simplified)

```
R0 (Tasks 1 2 3 4)
  |
  ├─ R1 (Tasks 5 6 7) ─ Student management
  |
  └─ R2 (Tasks 8 9 10 11) ─ Fee / Invoice
       |
       └─ R3 (Tasks 12 13) ─ Payments + Webhook + Ledger
            |
            └─ R4 (Tasks 14 15 16) ─ Receipts + Refunds
                 |
                 ├─ R5 (Tasks 17 18) ─ Dashboards + Bursary tools
                 |
                 └─ R6 (Tasks 19 20) ─ Reports + Regression
                      |
                      └─ R7 (Tasks 21 22 23 24 25) ─ Final polish
```
