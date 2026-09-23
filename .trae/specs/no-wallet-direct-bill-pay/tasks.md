# Remove Wallet + Direct Bill Payment + Bulk Bills Upload — Implementation Plan

## Task 1: Backend Prisma Schema Cleanup — Remove Wallet Models/Enums
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - Edit `api/prisma/schema.prisma`: Remove models `Wallet`, `WalletLedger`, `GeneralLedger`. Remove enums `WalletStatus`, `LedgerEntryType`, `LedgerAccount`, `LedgerType`. From `TransactionType` enum remove values `DEPOSIT`, `WITHDRAWAL`, `TRANSFER` (keep `FEE_PAYMENT`, `REFUND`). Remove all `wallet` / `ledger` relations from `User` model, `Transaction` model, `Refund` model, `Invoice` model, `Receipt` model. Keep `Fee`/`FeeCategory`/`FeeAssignment`/`Invoice`/`Receipt`/`Transaction`/`Refund` intact.
  - Run `npx prisma validate` to validate schema after edit.
  - Run `npx prisma generate` to regenerate fresh types.
  - Note: DB migration SQL file creation under `supabase/migrations` OR prisma migrations folder. If prisma migrate dev cannot run on the current frozen MySQL socket DSN, at minimum produce the correct SQL diff and update the schema file + regenerate Prisma client types so tsc compiles.
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `rule` TR-1.1: `npx prisma validate` runs exit 0.
  - `rule` TR-1.2: `cd api && npx tsc --noEmit` runs exit 0 after generate (once dependent code is updated).
  - `rule` TR-1.3: Grep schema.prisma for "Wallet" matches 0 model/enum definitions (allowed only in comments).
  - `rule` TR-1.4: Grep schema.prisma for enum TransactionType contains only `FEE_PAYMENT` and `REFUND`; matches for `DEPOSIT|WITHDRAWAL|TRANSFER` inside that enum = 0.

## Task 2: Backend — Remove Wallet Routes, Controllers, Bursary Withdrawals endpoints; Audit Controllers/RBAC
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - DELETE `api/src/routes/wallet.ts` file.
  - DELETE `api/src/controllers/wallet.ts` file.
  - Edit `api/src/app.ts`: REMOVE import and mount of wallet routes. Keep all other routes (auth, fees, feeAssignments, students, admin, bursary, academics, reconciliation, dashboard, webhook, receipts).
  - Edit `api/src/routes/bursary.ts`: REMOVE all /withdrawals endpoints (GET /withdrawals, POST approve, POST reject). Keep all bursary invoice, receipt, refund, bill/bulk-upload related endpoints.
  - Edit permissionSeed service if any of the removed routes have permission keys; remove wallet/withdrawal permissions.
  - Verify RBAC middleware still allows Bursary role access to all bill categories/definitions/assignments/bulk-upload endpoints (see AC-3 — Admin AND Bursary both need access; ensure no 403 for Bursary on /fees* and /fee-assignments*).
  - Move any Paystack webhook handler logic currently in wallet controller to reconciliation/fee controllers if needed.
- **Acceptance Criteria Addressed**: AC-1 (FR-1/4), AC-3, AC-9
- **Test Requirements**:
  - `rule` TR-2.1: File system stat on `api/src/routes/wallet.ts` returns "No such file".
  - `rule` TR-2.2: App.ts mount routes grep for "wallet" = 0.
  - `rule` TR-2.3: Bursary user JWT → POST bill category + POST bill create + POST bill assignment → all three 201/200. (Same for Admin JWT, verify equality.)
  - `rule` TR-2.4: GET /api/v1/fees → Admin 200, Bursary 200, Student → check allowed (if endpoint exists for students).
  - `rule` TR-2.5: Idempotency middleware still protects payment init for a single invoice id (existing regression test behaviour retained).

## Task 3: Backend — Student Direct Paystack Invoice Payment Flow (No Wallet)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - Payment initialize endpoint (currently in wallet or controllers) → Refactor to accept `invoiceId` (required) and optional `amount` override for PARTIALLY_PAID invoices if needed. Must:
    1. Look up Invoice by invoiceId, verify invoice.studentId === req.user.id OR caller is Admin/Bursary staff allowed to initiate.
    2. Verify invoice.status in {UNPAID, PARTIALLY_PAID}.
    3. Call Paystack initialize transaction with exact invoice remaining (or amount due if unpaid) as transaction amount; attach metadata.invoiceId, userId, transactionType=FEE_PAYMENT.
    4. Persist Transaction row type=FEE_PAYMENT, status=PENDING, reference=paystack_reference, invoiceId=invoice.id.
    5. Return { authorization_url, reference } to frontend.
  - Payment verify endpoint (post-callback): verify transaction with Paystack; mark Transaction SUCCESS; call invoice update — add amount to amountPaid, compute status (if amountPaid === amountDue → PAID else PARTIALLY_PAID), set paidAt if PAID.
  - Receipt generation: after SUCCESS, create Receipt row via existing Receipt service (reuse existing receipt flow). No WalletLedger touches anywhere (must not exist).
  - Paystack webhook handler: ensure charge.success event does the same payment success logic; no wallet-credit branch exists or is called.
- **Acceptance Criteria Addressed**: AC-2, AC-9
- **Test Requirements**:
  - `rule` TR-3.1: End-to-end via Jest: create unpaid invoice → init pay → verify callback → invoice PAID, Transaction.type=FEE_PAYMENT status=SUCCESS, Receipt row exists.
  - `rule` TR-3.2: WalletLedger row count 0 before and 0 after payment (no insert anywhere).
  - `rule` TR-3.3: Attempting to pay invoice that is already PAID → HTTP 400 with reason message.
  - `rule` TR-3.4: Paystack webhook with invalid signature → HTTP 401, invoice unchanged.
  - `rule` TR-3.5: Duplicate paystackEventId processed twice → DB counts unchanged after second delivery.

## Task 4: Backend — Student My Bills Invoice List (Row-level Security)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - Create/update endpoint `GET /api/v1/students/me/invoices` with query: `status?`, `page?`, `pageSize?`.
  - Query: Filter Invoice rows where `studentId = req.user.id`. Join with Fee (bill name, feeCode, categoryId → FeeCategory name). Return fields per invoice: id, invoiceNumber, billName, billCode, categoryName, amountDue, amountPaid, remaining (calculated = amountDue - amountPaid), status, dueDate, session, semester, paidAt, createdAt.
  - Sort default: dueDate ASC NULLS LAST, createdAt DESC.
  - Row-level security: Must not return invoices from other students (req.user.id is STUDENT; if ADMIN or BURSARY calling this endpoint they should NOT see another student's data via me endpoint — instead they have the admin/global invoices list endpoint).
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `rule` TR-4.1: Two seeded students (A, B), A has 3 invoices, B has 1. JWT A GET /me/invoices returns 3 rows with ids matching A's. JWT B returns 1 row, none of A's.
  - `rule` TR-4.2: Response schema for each row includes `remaining = amountDue - amountPaid` correctly computed (numeric precision Decimal(15,2)).
  - `rule` TR-4.3: Filter `status=UNPAID` query returns only UNPAID.

## Task 5: Backend — Bulk Bills Upload Endpoint (Excel + CSV, Dry Run + Commit)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - Add API endpoint `POST /api/v1/fees/bulk-upload`. Access allowed for ADMIN and BURSARY roles only (must not allow STUDENT). Accept multipart/form-data with fields: `file` (required, xlsx OR csv), `duplicateStrategy` (SKIP|UPDATE|ERROR default SKIP), query param `dryRun=true/false` (default true).
  - File type detection: .xlsx extension uses SheetJS XLSX.read buffer; .csv extension uses PapaParse.
  - Column aliases (case-insensitive): billCode|feeCode, name|billName, category|categoryCode, amount, currency, academicSession, semester, program|programme, department, college|faculty, level, studentType, isMandatory (y/yes/true → true else false), paymentDeadline (ISO date parse).
  - Per-row validation: categoryCode must exist; amount > 0 and numeric; academicSession non-empty; level if present integer; studentType if present enum match; deadline if present valid parseable date.
  - Duplicate detection via Fee unique constraint (feeCode, academicSession, program, level) composite. For SKIP: skip insert. For UPDATE: update categoryId, amount, description, currency, semester, deadline, isMandatory, active fields. For ERROR: add to perRowErrors, do not commit row.
  - dryRun=true: return { total, successfulCount, failedCount, duplicateCount, perRowErrors, previewSample (first 5 ok) }, NO DB write.
  - dryRun=false: transactional DB: insert or update all successful rows (rollback entire batch only if critical failure). Return same JSON plus `committed: true`.
  - Idempotent: repeated dryRun calls with same file return identical results (no side effects).
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `rule` TR-5.1: CSV 5 rows (4 unique + 1 duplicate, valid categories, amounts >0). dryRun → {total:5 successful:4 failed:0 duplicate:1}; commit with SKIP → 4 new rows inserted in prisma.fee count.
  - `rule` TR-5.2: XLSX identical content 5 rows → exact same response structure counts as CSV test (parser parity).
  - `rule` TR-5.3: Second commit SKIP with same file → 0 new rows (duplicate detection).
  - `rule` TR-5.4: UPDATE strategy: duplicate row amount changed → existing fee amount updated to new value.
  - `rule` TR-5.5: STUDENT JWT attempts upload → HTTP 403.
  - `rule` TR-5.6: Row with invalid non-existent category code → perRowErrors entry for that row, row not committed, overall batch does not rollback other valid.

## Task 6: Frontend App — Remove Wallet Pages + Sidebar Wallet Items
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None (can start parallel to Tasks 1-5)
- **Description**:
  - DELETE `app/src/pages/student/Withdraw.tsx`. DELETE `app/src/pages/student/Transfer.tsx`.
  - Edit `app/src/App.tsx`: Remove route definitions for `/student/wallet`, `/student/deposit`, `/student/withdraw`, `/student/transfer`.
  - Edit `app/src/components/PortalShell.tsx` sidebar menu items:
    - STUDENT role section: REMOVE "Wallet", "Deposit", "Withdraw", "Transfer". ADD/ENSURE menu items are: Dashboard, **My Bills** (set default landing/highlighted active first), Receipts, Profile.
    - ADMIN role section: REMOVE any "Wallets / Withdrawals / Top-ups". ADD/ENSURE: Dashboard, **Bill Categories**, **Bills**, **Bulk Upload Bills**, Students, Academics, Audit Logs, Refunds, Settings.
    - BURSARY role section: REMOVE any "Withdrawals / Wallet Ledger". ADD/ENSURE: Dashboard, **Bills**, **Bulk Upload Bills**, Invoices, Receipts, Refunds.
  - Edit `pages/student/Dashboard.tsx`: REMOVE wallet balance widget/card. ADD/UPDATE metric cards: Total Bills (count), Unpaid Bills (count), Amount Owed (sum remaining), Amount Paid (sum paid).
  - Edit `pages/admin/Dashboard.tsx`: REMOVE wallet metrics. ADD/UPDATE: Total Bills (count), Total Invoices (count), Unpaid Invoices Amount, Paid Invoices Amount, Students count.
  - Edit `pages/bursary/Dashboard.tsx`: REMOVE wallet metrics. ADD/UPDATE: Total Invoices, Unpaid Amount, Paid Amount YTD, Refunds Pending, Receipts Issued YTD.
  - Remove all case-insensitive "Wallet", "Deposit", "Top-up", "Topup", "Withdraw", "Transfer" strings from UI labels, button text, card titles, placeholders, toast messages in app/src directory. (Allow code comments with these only if not rendered.)
  - UI relabel "Fee" → "Bill" everywhere user sees it: page titles like "Fee Categories" → "Bill Categories", "Fees" → "Bills", form labels "Fee Name" → "Bill Name". Keep endpoint URLs /fees (assumption A-1 from spec).
- **Acceptance Criteria Addressed**: AC-1 (FR-5/6), AC-6, AC-7
- **Test Requirements**:
  - `rule` TR-6.1: File system for Withdraw.tsx returns not found. Transfer.tsx returns not found.
  - `rule` TR-6.2: App.tsx routes grep for /withdraw, /transfer, /deposit, /wallet → 0 matches (excluding comments).
  - `rule` TR-6.3: Grep app/src UI rendered text (string literals inside jsx, not variable names or internal comments) case-insensitive "wallet" = 0 matches. Same for "deposit", "top.?up", "withdraw", "transfer" — rendered text 0 matches.
  - `rule` TR-6.4: `/app/src/App.tsx` routes includes My Bills page for student route `/student/bills` (or similar name), matching student default redirect.
  - `rubric` TR-6.5: Sidebar/portal rebuild professionalism; dimension as per AC-6; scale 1-5; anchors 1/3/5 per AC-6; threshold >= 4; evidence: `/preview/sidebar/STUDENT`, `/preview/sidebar/ADMIN`, `/preview/sidebar/BURSARY` routes render clean.

## Task 7: Frontend — Student My Bills Page (List + Pay Now Direct Paystack)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 6, Task 4 (endpoint contract)
- **Description**:
  - Create/update page `pages/student/Fees.tsx` (existing) but RELABELLED → renamed `Bills.tsx` file OR keep file name Fees.tsx but rendered UI says "My Bills". Consistent with assumption A-1 (file naming legacy OK as long as labels change).
  - GET `/api/v1/students/me/invoices` with pagination page/pageSize. Render DataTable columns: Invoice #, Bill Name, Category, Amount Due, Amount Paid, Remaining, Status, Due Date, Actions.
  - Status Badge: UNPAID red/yellow warning, PARTIALLY_PAID amber, PAID green.
  - Actions column: UNPAID or PARTIALLY_PAID row → blue "Pay Now" button. PAID row → green "View Receipt" button (opens receipt page).
  - Click "Pay Now": confirm modal: "Are you sure you want to pay {remaining} for {billName}?" Confirm. Then calls payment init endpoint with invoiceId, gets authorization_url, redirects window.location.href to Paystack.
  - Callback route pages/student/Callback.tsx already exists; ensure handles invoiceId in metadata, shows PAID or FAILED status, links to receipt. Show success message: "Your payment for {billName} was successful! Receipt generated below" instead of any wallet credit message.
  - Payment confirmation page `PaymentConfirmation.tsx`: update to remove any wallet credit reference; show invoice paid status.
  - Empty state: "No bills found. Contact your Bursary office if you think this is an error."
- **Acceptance Criteria Addressed**: AC-2, AC-4, AC-6
- **Test Requirements**:
  - `rule` TR-7.1: Render snapshot: 3 seeded invoices (1 UNPAID, 1 PARTIALLY_PAID, 1 PAID) → My Bills table shows 3 rows, Pay Now only on first two, View Receipt on PAID.
  - `rule` TR-7.2: Pay Now click → calls API init with correct invoiceId, redirects to returned paystack authorization_url.
  - `rule` TR-7.3: Callback after successful verify → shows success status + receipt link; transaction.type=refund_or_paid.

## Task 8: Frontend — Admin & Bursary Bills CRUD + Assignments UI Labels to "Bills"
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 6
- **Description**:
  - Existing `pages/admin/Fees.tsx` → UI relabel: Page title "Bills Management", page subtitle "Create, edit and publish bills for students", column Fee Code → Bill Code, Fee Name → Bill Name, Create Fee → Create Bill.
  - Existing bill categories page (if exists under academics or separate): label "Bill Categories" instead of "Fee Categories".
  - Bill Assignments page / modal: relabel "Assign this bill" → labels to "Assign Bill to Target" (Student/Programme/Dept/Faculty/Level/Session/StudentType). Confirm assignment creates invoices per matching.
  - Add Bursary role menu links to same Bills / Bill Categories pages (shared pages no role distinction; backend access granted to both).
  - Invoice list for Admin + Bursary: relabel; keep existing filter status; keep void action; add "Download CSV" button for invoices if missing but only if easy.
- **Acceptance Criteria Addressed**: AC-3, AC-6
- **Test Requirements**:
  - `rule` TR-8.1: Admin navigate to /admin/fees → page title text says "Bills" (not Fees). Bursary to /bursary/fees → same page access (404/403 must NOT occur).
  - `rule` TR-8.2: Create bill category from bursary user → success. Create bill definition → success. Assign bill to target → success.

## Task 9: Frontend — Bulk Bills Upload Page (Wizard Flow)
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 8, Task 5 (endpoint)
- **Description**:
  - New page: accessible from Admin sidebar "Bulk Upload Bills" and Bursary sidebar "Bulk Upload Bills".
  - Wizard 4 steps:
    - Step 1 — Upload: Dropzone / file picker, accept `.xlsx,.csv`, size limit <= 10MB. Duplicate strategy radio select SKIP (default) / UPDATE / ERROR. Download sample CSV/XLSX button with minimal valid 2-row example + headers.
    - Step 2 — Preview: render table preview with columns from parsed file; show per-row errors in red; summary cards at top: Total rows, Valid, Invalid, Duplicates.
    - Step 3 — Confirm: summary of actions: "You are about to commit N new bills, skip D duplicates. Continue?" Button "Yes, Upload bills".
    - Step 4 — Result: success banner "N bills uploaded successfully. M rows failed, D skipped". Failed rows shown in collapsible accordion with per-row error.
  - Dry run call after file upload before confirm. Then commit call on user confirming.
  - Error resilience: bad file extension / unknown column → inline error without crash.
- **Acceptance Criteria Addressed**: AC-5, AC-6
- **Test Requirements**:
  - `rule` TR-9.1: Upload 5-row CSV valid → step 2 shows 5 rows summary cards (4 valid + 1 duplicate per seed). Confirm commit → step 4 result success count matches.
  - `rule` TR-9.2: Student JWT attempts visit page → PrivateRoute redirects to login/forbidden (student not allowed).

## Task 10: Zero Regressions — Tests, TypeScript, Paystack Webhook Verification
- **Status**: `pending`
- **Priority**: high
- **Depends On**: All Tasks 1-9
- **Description**:
  - Run terminal `npx tsc --noEmit` for both api and app directories. Fix any type errors from removed wallet types (change return types to omit wallet; refactor any controller that returned WalletBalance etc.)
  - Run Jest regression suite: health.test.ts, rbac-matrix.test.ts, idempotency.test.ts, email-secrets.test.ts, academic-import.test.ts, search-settings-notif.test.ts, reconciliation.test.ts, regression.test.ts. Remove wallet-specific tests ONLY if they exist and fail due to wallet remove; if any test imports wallet routes/controllers → update test. Ensure baseline 98+ non-wallet tests pass.
  - Clean up all remaining user-visible wallet strings in backend (error messages, res.json responses, console logs returned to clients). Not variable names.
  - Verify webhook flow: valid charge.success event → creates Transaction FEE_PAYMENT, marks invoice PAID, creates receipt, no unhandled rejections. Invalid signature → 401. Duplicate event → idempotent.
- **Acceptance Criteria Addressed**: AC-7, AC-8, AC-9
- **Test Requirements**:
  - `rule` TR-10.1: api tsc --noEmit exit 0, app tsc --noEmit exit 0.
  - `rule` TR-10.2: Regression Jest suite baseline passes (>= 98 test cases PASS). No wallet tests remaining if they existed (or if present updated to not reference removed routes).
  - `rule` TR-10.3: Grep api/src for user-facing strings "wallet" in response messages, res.send, res.json, err.message → 0. Same for "deposit", "withdraw", "top.?up", "transfer" user-facing messages → 0.
  - `rule` TR-10.4: Webhook signature invalid test → HTTP 401, no Invoice.status DB change. Duplicate eventId sent twice → counts for Invoice update calls: 1 only.
