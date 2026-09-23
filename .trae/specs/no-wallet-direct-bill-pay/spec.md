# Remove Wallet System + Direct Bill (Fee) Paystack Payment + Bulk Bills Upload — Product Requirements Document

## Overview
- **Summary**: Delete the University Wallet subsystem (wallets, wallet ledger, general ledger, deposits, withdrawals, transfers, wallet balance) entirely. Simplify the platform to a direct, admin-created bills system: Admin / Bursary staff create and assign "bills" (existing Fee/FeeCategory/FeeAssignment Prisma models are re-branded and re-used as-is without schema rename), students see a list of bills applicable to them based on their profile (level, department, programme, faculty, session, student type), click "Pay" on any bill, and pay **directly via Paystack card/bank** with NO intermediate wallet top-up step. Admin/Bursary can bulk-upload bill definitions in Excel (.xlsx) OR CSV format. Reconstruct ALL 3 role dashboard flows (Admin, Bursary, Student) to match the new simplified UX.
- **Purpose**: Remove the complex wallet middleman that users do not want. Make the student payment flow dead-simple: "see your bills → click pay for one → pay directly". Reduce bugs and support load from wallet/withdrawals/deposits.
- **Target Users**: 1) University Admin role, 2) Bursary/Finance role, 3) Students (paying bills).

## Goals
- **G-1**: Remove every wallet concept (Wallet model, WalletLedger, GeneralLedger, balance, deposit, withdrawal, transfer, wallet menu, wallet pages, wallet routes/controllers). Nothing labeled "Wallet" survives anywhere in UI or backend API.
- **G-2**: Direct Paystack payment for invoices. Student clicking "Pay" on a bill → immediately redirected to Paystack checkout for that EXACT invoice amount. No intermediate "top up wallet first" step, no "wallet balance", no "select from wallet balance during payment" branch.
- **G-3**: Admin and Bursary roles both can: create/edit bill categories, create/edit bill definitions (existing Fee model → UI relabel as "Bill"), assign bills to student/level/dept/faculty/programme/session/student-type, bulk upload bill definitions via Excel/CSV, view invoices by status, void invoices, view receipts, manage refunds.
- **G-4**: Student login sees a single "My Bills" list showing all bills assigned to them. Each row shows: bill name, category, amount, due date, status (UNPAID / PARTIALLY_PAID / PAID). Student clicks "Pay Now" on any UNPAID or PARTIALLY_PAID row → goes to direct Paystack checkout.
- **G-5**: Bill Bulk Upload UI + API. Admin/Bursary uploads a single .xlsx OR .csv file. Each row = 1 new bill definition (existing Fee model columns). Parse, validate per-row, show preview + error summary, then commit successful rows. Idempotent by feeCode+academicSession+program+level unique index.
- **G-6**: Zero regressions. All existing non-wallet functionality preserved: authentication/JWT, Paystack webhook signature verif, receipt generation + public verify URL, receipts PDF/QR if any, student CSV/Excel import, academics (faculty/dept/programme/level/session) CRUD, audit logs, CORS, RBAC matrix, rate limit, idempotency keys, email delivery scaffold, dashboard metrics. All existing Jest tests that do not test wallet flow continue to pass.

## Non-Goals
- **NG-1**: No schema rename of `Fee` model/table to `Bill`. UI labels (sidebar, page titles, button text) say "Bills" but Prisma model names stay `Fee` / `FeeCategory` / `FeeAssignment`. Rationale: rename = heavy migration + breaks existing running data.
- **NG-2**: No new wallet-like concept "account credit" or "advanced payment" stored. Overpayments during Paystack flow (if any) stay tracked on Transaction `status=OVERPAID` and handled per existing reconciliation logic but are NOT credited to a "wallet".
- **NG-3**: No new bill instalment / split pay feature beyond existing PARTIALLY_PAID InvoiceStatus.
- **NG-4**: No Paystack transfer / bank payout withdrawal features remain. Withdrawal approval/rejection (in bursary) pages deleted.
- **NG-5**: No student-uploaded bills. Only Admin/Bursary creates bill definitions + assignments.

## Background & Context
The project started with a "University Wallet" design: students top-up a wallet balance (DEPOSIT transaction), see a running balance, then use wallet balance to pay fees, could withdraw balance via a withdrawal request approved by bursary, transfer to other students, wallet ledger + general ledger for double-entry. The user has EXPLICITLY requested (VERBATIM): "remove the wallet system totally from the application there is no wallet system and there is no wallet withdrawal remove all the wallet system ... admin set all the payment and when student click make payment the student see all the payment that have been created by the admin and then pick which ever is applicable to them and they make payment for it it's that simple". Clarifying questions 2026-09-20 confirmed FULL wallet removal (drop Wallet/WalletLedger/GeneralLedger tables), re-use existing Fee model as "Bills" in UI, Excel+CSV bulk upload, Admin+Bursary both can create bills. Baseline frozen 142 Jest tests (from prior batches-a2e capstone) was 142/142 PASS; baseline terminal tsc api=0 app=0 clean. Baseline servers running api:3000/vite:5173.

## Functional Requirements
### Wallet Removal (F-WALLET-REMOVE)
- **FR-1**: Delete API route `/api/v1/wallet/*` entirely (balance, deposit, verify deposit, withdrawal, transfer, wallet webhook) and its controller `controllers/wallet.ts`.
- **FR-2**: Delete Prisma models `Wallet`, `WalletLedger`, `GeneralLedger`; delete enums `WalletStatus`, `LedgerEntryType`, `LedgerAccount`, `LedgerType`; remove all Wallet relations from `User` and `Transaction` models.
- **FR-3**: Clean `TransactionType` enum: remove values `DEPOSIT`, `WITHDRAWAL`, `TRANSFER`. Keep values `FEE_PAYMENT`, `REFUND`.
- **FR-4**: Delete all wallet-related Bursary endpoints from `routes/bursary.ts`: `/withdrawals`, `/withdrawals/:id/approve`, `/withdrawals/:id/reject`.
- **FR-5**: Delete app pages: `pages/student/Withdraw.tsx`, `pages/student/Transfer.tsx`. Remove wallet menu items, balance cards, deposit/top-up buttons, "Wallet" section from sidebar for all roles.
- **FR-6**: Remove wallet balance display from `pages/student/Dashboard.tsx`. Remove any "wallet balance" card from Admin and Bursary dashboards.

### Direct Bill/Invoice Payment (F-DIRECT-PAY)
- **FR-7**: Student "My Bills" page: API call returns all `Invoice` rows for the authenticated student, joined with `Fee` (bill name, category), sorted by dueDate ASC then createdAt DESC. Each invoice: status, amountDue, amountPaid, remaining = amountDue - amountPaid.
- **FR-8**: "Pay Now" button on UNPAID/PARTIALLY_PAID invoice: calls existing Paystack initialize endpoint but with the EXACT invoice id + amount due (or remaining) and `callback_url` pointing to student payment confirmation + paystack verify. NO wallet branch.
- **FR-9**: Paystack webhook handler (existing `controllers/reconciliation.ts` or `controllers/wallet` webhook moved to reconciliation) → on charge.success: update Invoice status, mark Transaction FEE_PAYMENT SUCCESS, create Receipt via existing Receipt service, return 200 to Paystack.
- **FR-10**: Student payment confirmation page (existing) shows PAID/FAILED status with receipt link, no wallet credit message.

### Bills Management (Admin + Bursary, F-BILLS-MGMT)
- **FR-11**: Bill Categories (existing FeeCategory): Admin AND Bursary roles can CRUD. UI labels read "Bill Categories" instead of "Fee Categories".
- **FR-12**: Bill Definitions (existing Fee model): Admin AND Bursary roles can CRUD. UI labels "Bills" instead of "Fees". Columns: billCode (feeCode), name, description, category, amount, currency, academic session, semester, level, programme, department, faculty, student type, mandatory flag, payment deadline, active flag.
- **FR-13**: Bill Assignment (existing FeeAssignment): Admin AND Bursary can assign a bill to STUDENT / PROGRAMME / DEPARTMENT / FACULTY / LEVEL / SESSION / STUDENT_TYPE target types. Trigger assignment generates Invoice rows per matching students (existing assignment behaviour retained).
- **FR-14**: Invoices list page: Admin/Bursary see all invoices filterable by status, student, session, category. Actions: View Receipt, Void Invoice (already existing).
- **FR-15**: Refund flow (kept as non-wallet): Admin/Bursary can request refund against a PAID invoice/transaction — refund goes through existing Refund model with status REQUESTED/APPROVED/REJECTED/PAID/FAILED and approval. No "refund back to wallet balance" — refund is external manual payout.

### Bulk Upload Bills (F-BULK-UPLOAD)
- **FR-16**: Backend endpoint `POST /api/v1/fees/bulk-upload` (available to Admin AND Bursary roles):
  - accepts `multipart/form-data` with `file` field (.xlsx OR .csv), `duplicateStrategy` = SKIP | UPDATE | ERROR (default SKIP)
  - expected columns (case-insensitive, order agnostic): `billCode`|feeCode, `name`|billName, `category`|categoryCode, `amount` (number), `currency` (optional NGN default), `academicSession`, `semester` (optional FIRST/SECOND), `program`|programme (optional), `department` (optional), `college`|faculty (optional), `level` (int, optional), `studentType` (optional), `isMandatory` (bool Y/N or true/false), `paymentDeadline` (ISO date string optional)
  - validates per row: amount > 0, category code exists, session non-empty, unique (feeCode, academicSession, program, level) constraint idempotency
  - returns preview JSON: `{ total, successfulCount, failedCount, duplicateCount, perRowErrors: [{row, errors}], previewSample: [first 5 ok] }` before commit if `?dryRun=true`; `?dryRun=false` commits successful rows
- **FR-17**: UI page "Bulk Upload Bills" under Admin and Bursary Bills menu. Step 1: Upload file (.xlsx/.csv) → Step 2: Show preview table + per-row errors summary → Step 3: Choose duplicate strategy (SKIP/UPDATE/ERROR default) → Step 4: Confirm commit → Step 5: Result "N bills created successfully, M failed, D skipped duplicates".
- **FR-18**: Graceful parsing: XLSX via SheetJS `XLSX.utils.sheet_to_json` (already in studentImport) and CSV via PapaParse. Column aliases in FR-16 apply. Non-required empty fields → omit from create.

### Role Dashboard Refactors (F-DASHBOARDS)
- **FR-19**: Student dashboard sidebar/menu: REMOVE "Wallet", "Deposit", "Withdraw", "Transfer". KEEP: "Dashboard", "My Bills", "Receipts/Payments", "Profile". Add "My Bills" as the highlighted default landing page after login.
- **FR-20**: Student Dashboard top metrics cards: Total Bills (count), Unpaid Bills (count), Amount Owed (sum of remaining), Amount Paid (sum). No balance card.
- **FR-21**: Admin Dashboard sidebar/menu: REMOVE anything wallet, withdrawals, wallet ledger. KEEP: Dashboard, Bills, Bill Categories, Bulk Upload Bills, Students, Academics, Audit Logs, Refunds, Settings.
- **FR-22**: Admin Dashboard top metrics cards: Total Bills, Total Invoices, Unpaid Invoices amount, Paid Invoices amount, Students count.
- **FR-23**: Bursary Dashboard sidebar/menu: REMOVE Withdrawals approval/wallet. KEEP: Dashboard, Bills, Bulk Upload Bills, Invoices, Receipts, Refunds.
- **FR-24**: Bursary Dashboard top metrics cards: Total Invoices, Unpaid amount, Paid amount YTD, Refunds pending, Receipts issued YTD.

### Zero Regressions (F-REGRESSION)
- **FR-25**: All existing auth (login/logout, JWT verify, role middleware, RBAC matrix, rate limiter, idempotency on payment init, helmet CORS, Paystack webhook HMAC signature verify, receipt public verification URL, student bulk import, academics CRUD, audit logs, email sending scaffold) remain functional after changes.
- **FR-26**: `terminal tsc --noEmit api=0` and `terminal tsc --noEmit app=0` (authoritative zero real type errors) after all changes applied.
- **FR-27**: Jest test suite passes non-wallet tests. (Wallet-related tests, if any, are removed gracefully; remaining 98+ baseline tests PASS.)

## Non-Functional Requirements
- **NFR-1**: Bills list page for Student loads <= 1.5s on 100 invoices (per pagination API, existing page/pageSize).
- **NFR-2**: Bulk upload 500 bills preview <= 3s, commit <= 5s (with per-row validation).
- **NFR-3**: Terminal `tsc --noEmit` both projects = 0 TypeScript errors (no regressions from refactor).
- **NFR-4**: Hardened Paystack webhook: only FEE_PAYMENT transactions allowed to update invoice; any other event type ignored (existing).
- **NFR-5**: No hardcoded Paystack/JWT secrets in source code; all env-loaded (existing security audit).
- **NFR-6**: UI labels, sidebar nav, and breadcrumbs use "Bills" consistently. No lingering UI text that says "Wallet", "Deposit", "Top-up", "Withdraw", "Transfer", or "Wallet Balance".

## Constraints
- **Technical**:
  - Existing Prisma `Fee` / `FeeCategory` / `FeeAssignment` / `Invoice` / `Receipt` / `Transaction` / `Refund` models MUST be re-used as-is for "Bills" (UI only relabel). No dropping tables `fees`, `fee_categories`, `fee_assignments`, `invoices`, `receipts`, `transactions`, `refunds` — they are the core data model for the new "Bills" flow.
  - MUST drop tables: `wallets`, `wallet_ledger`, `general_ledger`. MUST drop enums `WalletStatus`, `LedgerEntryType`, `LedgerAccount`, `LedgerType`. MUST drop enum values `DEPOSIT/WITHDRAWAL/TRANSFER` from `TransactionType` (per Prisma add-then-migrate pattern if needed).
  - Bulk upload MUST reuse existing XLSX library (`xlsx` package in api/package.json) and PapaParse which are already installed; no new parsers.
  - Existing Paystack initialize / verify / webhook pattern MUST be reused; no new payment gateway.
  - UI app uses React Router 7 + Vite + Tailwind (already set up). PortalShell sidebar component reused.
- **Business**:
  - Students CANNOT see bills not assigned to them (row-level security per invoice.studentId = req.user.id).
  - Admin + Bursary both can create bills and bulk upload; no SoD separation between these two roles (explicit user-approved).
  - No "partial wallet pay" option: every Paystack init is for a single specific invoice id and amountDue or remaining.
- **Dependencies**: MySQL localhost socket DSN (frozen), no Redis needed (QUEUE_DISABLE_WORKERS=true as current running config), paystack test keys env-only, BullMQ graceful sync fallback continues.

## Assumptions
- **A-1**: Fee to "Bill" rename is UI-only. All API endpoints remain `/api/v1/fees/*`, `/api/v1/fees/assignments/*`, `/api/v1/invoices/*` with no route rename (avoids huge frontend route churn and broken link bookmarks in current app).
- **A-2**: Transaction table kept; TransactionType narrowed to FEE_PAYMENT + REFUND only (no DEPOSIT/WITHDRAWAL/TRANSFER). Transaction stores the Paystack reference per invoice exactly as before.
- **A-3**: Refund flow UI kept but no longer references "credit back to wallet". UI text reads "Refund will be processed via bank transfer manually by Bursary".
- **A-4**: The existing Jest regression suite 142 tests includes some wallet tests (deposit/withdraw) that will be detected and removed/updated during implementation; the non-wallet baseline 98 tests from frozen archive must still pass.

## Open Questions
All open questions resolved via user answers 2026-09-20:
- [x] Wallet removal scope: **FULL removal, drop tables/models/enums**
- [x] Fee vs Bill: **Re-use Fee models, UI-only relabel to Bills**
- [x] Bulk upload format: **Excel .xlsx + CSV both supported**
- [x] Role bill creation: **Admin + Bursary BOTH can create bills, categories, assignments, bulk upload**

## Acceptance Criteria

### AC-1: Wallet model/enum/route/UI full removal
- **Type**: `rule`
- **Given**: Fresh prisma migrate applied after changes, AND app bundles compiled
- **When**: Grep full repo (excluding node_modules/.trae) for wallet references
- **Then**: 1) No Prisma model `Wallet`, `WalletLedger`, `GeneralLedger` exists in schema. 2) No enum `WalletStatus`, `LedgerEntryType`, `LedgerAccount`, `LedgerType` exists. 3) Enum `TransactionType` has values `FEE_PAYMENT`, `REFUND` only — NO `DEPOSIT`, `WITHDRAWAL`, `TRANSFER`. 4) `routes/wallet.ts` file deleted, `app.ts` does NOT mount `wallet` routes, `routes/bursary.ts` has 0 `/withdrawals` routes. 5) App files `pages/student/Withdraw.tsx`, `pages/student/Transfer.tsx` deleted; `App.tsx` routes contain no /withdraw or /transfer paths. 6) App sidebar/PortalShell has 0 menu items labeled "Wallet", "Deposit", "Top-up", "Withdraw", "Transfer". 7) Case-insensitive grep in `app/src` for "wallet" string in UI labels (excluding comments and route definitions) = 0 matches.
- **Pass Condition**: All 7 sub-conditions simultaneously true
- **Evidence**: Grep output counts + Prisma schema lines + App.tsx routes output + sidebar menu items inspected

### AC-2: Direct invoice Paystack payment flow (no wallet step)
- **Type**: `rule`
- **Given**: Student logged in, has 1 UNPAID invoice for bill "School Fees 2023/24" with amount NGN 50,000
- **When**: Student clicks "Pay Now" for that invoice
- **Then**: 1) Payment initialize API is called for that invoiceId and exact NGN 50,000 amount; NO wallet balance check; NO wallet credit deduct branch; 2) Paystack checkout redirect URL returned contains invoiceId reference (in metadata or callback); 3) callback page after payment marks invoice PAID, creates receipt via existing Receipt service; 4) NO wallet balance is modified anywhere in flow (no WalletLedger rows); 5) Transaction row created with `type=FEE_PAYMENT` and `status=SUCCESS` after webhook.
- **Pass Condition**: All 5 conditions true when walking through flow manually (or via equivalent existing Jest regression for paystack charge.success handler on invoice).
- **Evidence**: Payment initialize + verify calls audit + Transaction + Invoice row states after flow

### AC-3: Admin + Bursary both can create bill definitions + assignments
- **Type**: `rule`
- **Given**: Admin user JWT, and separately Bursary user JWT (both valid accounts in seed)
- **When**: Each role calls (1) POST bill category create, (2) POST bill definition create, (3) POST bill assignment to STUDENT target type, (4) POST invoice list view
- **Then**: All 4 endpoints return HTTP 200/201 for BOTH Admin and Bursary roles (no 403 RBAC denied for bills/categories/assignments on Bursary role).
- **Pass Condition**: RBAC middleware allows bills/categories/assignments access for both roles; 8 HTTP calls (4 × 2 roles) all succeed.
- **Evidence**: Existing rbac-matrix.test.ts updated for bill endpoints and PASS; OR separate curl script output for 8 calls 200/201.

### AC-4: Student sees only applicable bills, can click Pay Now for each
- **Type**: `rule`
- **Given**: Student A in dept CS, level 300, session 2023/24, studentType=UG; has 3 assigned invoices: (a) "Tuition NGN100k UNPAID", (b) "Dept dues NGN10k PAID", (c) "Faculty dues NGN5k UNPAID". Student B in dept Math, has 0 invoices from those 3 assignments.
- **When**: Student A GET /api/v1/students/me/invoices. Separately Student B GET /api/v1/students/me/invoices.
- **Then**: 1) Student A list has 3 rows with invoice status, bill name, amount due, amount paid, remaining. 2) Each UNPAID row has clickable "Pay Now" button wired to direct Paystack for that invoiceId. 3) PAID row has greyed "View Receipt" no Pay Now button. 4) Student B sees EMPTY list (0 rows, none of A's invoices leak). 5) No wallet step before checkout.
- **Pass Condition**: All 5 sub-conditions true
- **Evidence**: API response payloads for A/B + rendered React snapshots of "My Bills" page

### AC-5: Bulk bill upload Excel + CSV works, preview, commit, idempotent
- **Type**: `rule`
- **Given**: CSV file 5 rows bill definitions; XLSX same data. Admin user authenticated. All 5 rows have valid data + category codes exist; 1 row duplicate (feeCode+session+program+level same as existing bill)
- **When**: (1) dryRun=true upload CSV, (2) dryRun=false commit CSV, (3) re-upload SAME CSV with SKIP strategy, (4) dryRun=true upload XLSX, (5) commit XLSX with UPDATE strategy on duplicate
- **Then**: 1) CSV preview returns total=5 success=4 fail=0 duplicate=1; 2) commit creates 4 new bills (duplicate skipped with SKIP); 3) second upload with SKIP creates 0 new bills; 4) XLSX preview shows identical per-row success/errors; 5) UPDATE strategy overwrites amount/deadline/active fields for duplicate bills matching unique key.
- **Pass Condition**: All 5 sub-conditions true.
- **Evidence**: Upload endpoint JSON responses for each step + Prisma DB counts of fee table before/after.

### AC-6: Sidebar and dashboard rebuilt correctly for 3 roles
- **Type**: `rubric`
- **Dimension**: Professional left-sidebar consistency, role-appropriate menus, removal of all wallet UI mentions, alignment with the new simplified direct-bill UX
- **Scale**: 1-5
- **Anchors**: 1 = many wallet menu items still present, dashboard broken; 2 = most wallet items removed, one or two "Deposit/Withdraw" remain visible, dashboard metrics not updated; 3 = all wallet menu items removed, student "My Bills" default landing, metrics cards show bill/invoice counts but text labels still say "Fee" in some places; 4 = all UI text relabel to "Bills", dashboard metrics match role (Student: unpaid bills/amount owed; Admin/Bursary: invoices totals), sidebars are consistent, professionally spaced, active page highlighted; 5 = level-4 AND a) PortalShell sidebar labels/counts/icons match professional design guidelines, b) empty states present for "no bills", c) breadcrumbs read "Dashboard / Bills / ..." correctly.
- **Pass Threshold**: >= 4
- **Evidence**: Rendered screenshots or /_preview/sidebar/{STUDENT,ADMIN,BURSARY} route inspection + UI text case-insensitive "wallet"/"deposit"/"withdraw"/"transfer" greps = 0 in `app/src`.

### AC-7: No wallet references in backend error messaging / seed / docs strings (user-visible strings)
- **Type**: `rule`
- **Given**: All backend source files compiled
- **When**: Case-insensitive grep api/src for strings: "wallet", "deposit", "top-up", "topup", "withdraw", "transfer"
- **Then**: 0 matches in user-visible strings (error messages, API response body messages, console logs returned to users, email templates).
  Allowed matches: internal comments/code references we are unable to clean up, and variable names `transactionId` not containing wallet words.
- **Pass Condition**: 0 offending user-visible strings.
- **Evidence**: Grep api/src output for the 6 keywords, listing matches, and each reviewed & confirmed not user-visible.

### AC-8: Terminal TypeScript zero errors, no test regressions for non-wallet baseline
- **Type**: `rule`
- **Given**: All changes applied, package installs up to date
- **When**: Run terminal authoritative type checks and tests
- **Then**: 1) `cd api && npx tsc --noEmit` exit code 0 (0 real errors); 2) `cd app && npx tsc --noEmit` exit code 0 (0 real errors); 3) Jest non-wallet suite: existing baseline regression tests that do not test wallet (health.test, rbac-matrix, idempotency, email-secrets, academic-import, search-settings-notif, reconciliation) all PASS.
- **Pass Condition**: All 3 sub-conditions true.
- **Evidence**: Command exit codes and Jest PASS/FALSE tally.

### AC-9: Paystack webhook security and idempotency preserved
- **Type**: `rule`
- **Given**: Stale webhook event with known signature replayed twice, invalid signature event, valid charge.success for an invoice.
- **When**: Events hit webhook endpoint
- **Then**: 1) Invalid signature returns 401 immediately, never touches DB; 2) Valid duplicate event (paystackEventId) processed only once, second call returns 200 but no DB change; 3) Valid charge.success creates exactly ONE Transaction with FEE_PAYMENT type, marks invoice PAID, creates exactly ONE Receipt.
- **Pass Condition**: All 3 subconditions true.
- **Evidence**: Webhook handler test output or curl script results.
