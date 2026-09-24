# University Payment Platform — À-la-carte Fee Catalogue & Collections-Only Reporting

## Overview
- **Summary**: Replace the per-student "outstanding invoices / billed receivables" mental model with a simple **Fee Catalogue → Student picks → Pay → Collections report** workflow. No student is ever "billed" in advance; they simply pay for the published fees they choose (within their scope). Reporting becomes **100% collections-based** — only successful payments appear in Bursary reports, with no "expected vs outstanding" variance language.
- **Purpose**: Align the platform with the university's actual operating process: the Bursary publishes charges, students self-serve pay the ones applicable to them, and Finance sees a clean "payroll-style" payout list of what was actually collected. Removes the misleading "Outstanding Receivable" KPI that incorrectly implied debt when students were never formally invoiced.
- **Target Users**: Admin (creates Fee catalogue items), Bursary (views collections report & per-transaction payout), Students (browse catalogue → select → pay).

## Goals
- Publish a **global Fee Catalogue** where newly created fees are visible to **all students by default**; scope filters (Faculty / Dept / Programme / Level / Session / Student Type) are **optional narrows**.
- **No Invoice rows are created until a student initiates payment** by clicking "Pay Now"; no pre-generated bulk UNPAID invoices exist anywhere.
- Abandon all "Outstanding / Billed / Amount Owed / Expected Total" KPIs, widgets, and labels on every role dashboard.
- Bursary payout report = **collections-only, payroll-style**: rows of successful payments (Receipt #, Date, Student, Matric, Faculty/Dept/Level, Fee Category & Name, Amount, Gateway Channel, Status = SUCCESS). Totals by Fee Category / Faculty / Date range. CSV and JSON export.
- Student Portal default entry point is **"Available Payments"** (catalogue grid). Payment history only shows invoices that have been actually paid / attempted (no UNPAID filter or "Balance" column).
- Preserve scope filtering semantics: a fee narrowed to "300 Level / Medicine" only appears to matching students, but still never creates an invoice until the student elects to pay.

## Non-Goals
- No payment plans, instalments, or part-payment logic changes (existing `PARTIALLY_PAID` status remains, but it is not exposed as an "Owed" KPI).
- No automatic reminders, SMS, or collection dunning.
- No new authentication, gateway, or PDF-receipt logic beyond KPI/report changes.
- No student bulk-import or role permission changes.
- No "financial aid", "scholarship", or "waiver" workflows in this spec.
- Not removing the `Invoice` / `FeeAssignment` Prisma models or existing DB rows (backwards compatible; behaviour is enforced in controllers + UI only).

## Background & Context
- Current codebase already contains a functioning catalogue in `app/src/pages/student/Fees.tsx → BrowseCataloguePage` and assignment-wizard + generate-invoices logic in `app/src/pages/admin/Fees.tsx`.
- `Bursary Dashboard` (`app/src/pages/bursary/Dashboard.tsx:L309-L314`) currently renders a `totalOutstanding` ratio + `expectedInvoicesTotal` KPI — the user explicitly wants these removed / replaced with collections-only metrics.
- Schema already supports `Fee.level / program / college / department / studentType / academicSession` fields on the `Fee` model directly (`schema.prisma:L230-L239`), so scope filters are stored on the Fee itself without requiring an Assignment join.
- `InvoiceStatus` enum currently supports `UNPAID / PARTIALLY_PAID / PAID / PENDING / FAILED / REVERSED / REFUNDED / CANCELLED`. Backend policy changes: only `PENDING` + `SUCCESS` paths create invoices; student invoices list filters out `UNPAID` unless explicit per-request override.

## Functional Requirements
- **FR-1 Catalogue default visibility**: When an Admin creates a Fee, all scope fields (college, department, program, level, studentType) default to NULL/"global", meaning every student sees it. Filling any scope field narrows visibility to the intersection of those filters.
- **FR-2 Catalogue backend**: `GET /api/v1/students/fees/catalogue` filters active Fees by the logged-in student's User fields AND returns ONLY fees whose `isActive = true`, without creating/returning any Invoice row or balance.
- **FR-3 Deferred invoice creation**: `ensureInvoiceForFee(feeId)` (or its controller equivalent) creates a new Invoice row ONLY when called during a Pay Now click. Status starts as `PENDING`. If gateway callback confirms success → `PAID`; fails/cancels → `FAILED` or `CANCELLED`. No row is ever persisted as `UNPAID`.
- **FR-4 Student invoice/history list**: `GET /api/v1/students/invoices` hides any row with `status = UNPAID` by default. New allowed statuses in the history view are `PENDING, PARTIALLY_PAID, PAID, FAILED, REVERSED, REFUNDED, CANCELLED`. Balance columns that show "owed" are removed; only Amount Paid + Amount Due per attempted invoice are shown contextually.
- **FR-5 Remove "Billed / Outstanding" KPIs from Student dashboard**: Delete the "Total Billed" card and any `amountDue - amountPaid` owed language. Keep only "Amount Paid" aggregate computed from transactions with `status = SUCCESS`.
- **FR-6 Remove "Outstanding / Expected" KPIs from Bursary dashboard**: Replace `totalOutstanding / expectedInvoicesTotal / collected vs expected ratio` with: (a) Total Collected in date range, (b) Count of successful transactions, (c) Top Fee Categories by collections, (d) Collections trend chart — all derived from successful Transaction + Receipt joins.
- **FR-7 Collections Payout report**: New or enhanced `GET /api/v1/bursary/reports/collections` endpoint returning SUCCESS rows only. Columns: receiptNumber, paidAt timestamp, student full name, matricNumber, college, department, program, level, feeName, feeCode, category (name + code), paidAmount, gateway (PAYSTACK/ALATPAY), channel, transactionReference. Filterable by dateFrom/dateTo, category, faculty, level. Returns JSON and CSV via `format=csv`.
- **FR-8 Collections UI export**: Bursary Dashboard "Export CSV/JSON" buttons (already exist) must hit the new collections-only endpoint and must NOT include any non-successful transactions or "expected amount" columns.
- **FR-9 Bursary Payments list tab**: `app/src/pages/bursary/Payments.tsx` (if present, or PortalShell nav) must default to SUCCESS-status filter only and remove any "unpaid invoice" search filters.
- **FR-10 Fee Assignment wizard de-emphasised**: Admin "Assignments" tab remains functional but is **no longer required** to publish a fee. The create-fee form's built-in scope fields are the primary way to limit visibility. The Assignment Wizard's `generateNow` checkbox defaults to FALSE (no longer auto-generates pre-invoices) and warns: "Generate creates UNPAID invoices for matching students and is not recommended for a-la-carte flows."
- **FR-11 Student landing redirect**: Student role routes — `/student` default page — should render `Make Payment` tab as default landing view, not an invoices/overview page.
- **FR-12 Payment status drift safety**: Legacy `UNPAID` invoices (created before this spec) must be hidden from current-student UI views, but remain queryable by Admin/Bursary via explicit status filter only for data-retention purposes.

## Non-Functional Requirements
- **NFR-1 Backward compat**: Existing DB rows, Prisma schema, and Receipt PDF flow must NOT break. No `prisma migrate dev` changes are required unless strictly needed (prefer controller/view-layer policy only).
- **NFR-2 Performance**: Catalogue endpoint must load ≤ 500 active fees in under 400 ms on localhost (index on Fee.isActive + Fee.academicSession already per schema.prisma). Collections report on 10 k transactions ≤ 2 s.
- **NFR-3 Idempotency**: Deferred invoice creation during Pay Now must be **idempotent per fee per student per attempt** (unique constraint `UNIQUE(studentId, feeId, attemptKey)` not required — use `Idempotency-Key` header already required on wallet deposit; extend the same header to ensureInvoiceForFee so double-clicks don't create duplicate pending invoices).
- **NFR-4 Security / RBAC**: Collections report, Bursary dashboard KPIs, and fee-catalogue CRUD continue enforcing existing role guards. Students can NEVER list another student's catalogue scope or invoice history.
- **NFR-5 Usability**: No dashboard anywhere should contain words like "Outstanding", "Billed", "Amount Owed", "Expected Collections", or "Receivables" when they would be computed from UNPAID invoice rows. Use "Collections", "Successful Payments", "Amount Paid" instead.

## Constraints
- **Technical**:
  - Prisma schema MySQL `@db.Decimal(15,2)` for all money values (reuse existing).
  - API port = 3001, frontend port = 5173.
  - Frontend Vite + React 18, Backend Express + ts-node.
  - MySQL + Prisma ORM, ALAT Pay + Paystack gateways already integrated.
- **Business**:
  - One active payment gateway at a time (existing constraint preserved).
  - Refund UI still shows disabled banner as before; status shown only after Bursary manually processes one (no change).
- **Dependencies**:
  - Dashboard summary endpoints (`/bursary/dashboard/summary`, `/bursary/dashboard/trend`, `/bursary/dashboard/by-category`) are already called by Bursary Dashboard; return shape changes require frontend card changes.
  - Student `studentFees.ts` service methods `catalogue(), listInvoices(), schedule(), ensureInvoiceForFee()` are integration points whose contract (filter/return values) may change.

## Assumptions
- Admin will still use Fee Categories and the Fee CRUD form as before; only defaults + language change.
- Prior UNPAID / PARTIALLY_PAID legacy data is expected to exist; hiding it at query layer satisfies the business requirement without data loss.
- Student `User.level` / college / department / program / academicSession fields are populated at student-creation time (Admin Add Student form already supports them per prior seed/Admin work), so scope filtering against Fee fields is possible without joins to academic tables.
- Collections export CSV requires a header row that matches payroll conventions of Bursary (Receipt No., Date, Student Name, Matric, Faculty, Dept, Level, Fee, Amount, Channel, Status).

## Acceptance Criteria

### AC-1: Fee Catalogue visibility default is global
- **Type**: `rule`
- **Given**: Admin creates a new Fee in Admin Fees tab filling only feeCode, name, category, session, amount (leaving scope blank)
- **When**: Any active student opens `/student/payments` (Available Payments tab)
- **Then**: The new fee appears with correct amount, session, category badge, "Pay Now" button for EVERY student regardless of Faculty/Dept/Programme/Level
- **Pass Condition**: 5 distinct seed students (different colleges/depts/levels from seed.ts) can see the same newly created global fee card on their catalogue page (verified via catalogue API response for each student JWT).
- **Evidence**: (a) Postman/axios POST admin creates fee with null scope → (b) GET catalogue for student1..student5 all include the fee.id.

### AC-2: No Invoice rows created until Pay Now click
- **Type**: `rule`
- **Given**: A fee exists in the catalogue and is visible to a student, and the student has NOT clicked Pay Now
- **When**: `SELECT COUNT(*) FROM invoices WHERE studentId = X AND feeId = Y` runs immediately after catalogue view
- **Then**: Count is strictly 0
- **Pass Condition**: Post-view SELECT returns 0; after a Pay Now call, a single PENDING invoice is created with matching studentId+feeId (verified via idempotency-protected POST to ensureInvoiceForFee endpoint, followed by SELECT returning exactly 1).
- **Evidence**: SQL row counts before & after Pay Now in test script + server log.

### AC-3: Student Invoice History excludes UNPAID by policy
- **Type**: `rule`
- **Given**: Legacy or test data exists with `status IN ('UNPAID', 'PENDING', 'PAID', 'FAILED', 'CANCELLED')` for a student
- **When**: Student calls `GET /students/invoices` without explicit `status` query param
- **Then**: Response `invoices[]` contains ZERO rows where `status === 'UNPAID'`; the PENDING/PAID/FAILED/CANCELLED rows remain present and correctly paginated
- **Pass Condition**: Seed test creates 5 invoices with mixed statuses → default list API filters UNPAID out, but specific query `?status=UNPAID` (when called by ADMIN role only) returns them. For STUDENT role, ?status=UNPAID returns empty array.
- **Evidence**: Integration test in `api/src/__tests__/` asserting invoice list filtering by role.

### AC-4: No "Outstanding Receivable / Billed" label remains anywhere
- **Type**: `rule`
- **Given**: The freshly built app is opened in browser with Admin, Bursary, and Student roles logged in
- **When**: Full-text search (case-insensitive) across all rendered DOM text and all `i18n/en.ts` strings and all `*Dashboard.tsx / Fees.tsx` TSX files for the patterns "outstand", "billed", "amount owed", "receivable", "expected total", "balance forward"
- **Then**: Zero matches, EXCEPT where the match is a dead code path not rendered at runtime, OR refers to "Paid / Amount Paid", OR is a legacy DB enum comment
- **Pass Condition**: Grep across app/src + api/src returns 0 runtime matches; visual spot-check of Student + Bursary dashboards shows only "Amount Paid / Collections / Successful Payments".
- **Evidence**: `grep -iE "outstand|billed|amount.owed|receivable|expected total|balance" app/src api/src --include=*.ts --include=*.tsx --include=*.md` returns 0 production matches.

### AC-5: Collections report is SUCCESS-only with payroll columns
- **Type**: `rule`
- **Given**: 3 SUCCESS transactions + 2 FAILED + 2 PENDING exist for a date range
- **When**: Bursary role calls `GET /bursary/reports/collections?dateFrom=X&dateTo=Y` (default) and `?format=csv`
- **Then**: JSON response contains exactly 3 rows; CSV contains 3 data rows + 1 header; every row has `status == 'SUCCESS'` (or equivalent transaction SUCCESS status) and the full payroll columns set
- **Pass Condition**: JSON length = 3; CSV header equals `Receipt No.,Date,Student Name,Matric No.,Faculty,Department,Level,Fee Name,Fee Code,Category,Amount,Gateway,Channel,Reference,Status`; failed/pending transactions excluded.
- **Evidence**: Integration test + manual curl with CSV header match.

### AC-6: Collections dashboard KPIs derive from SUCCESS only
- **Type**: `rule`
- **Given**: Mix of successful (NGN 500,000 total) and failed (NGN 100,000) transactions in range
- **When**: Bursary dashboard calls `/bursary/dashboard/summary?dateFrom=...`
- **Then**: The total-collections card value equals 500,000 exactly; trend chart buckets sum to same 500,000; by-category bars sum to 500,000; failed transaction amounts never appear in any Bursary KPI
- **Pass Condition**: KPI numeric equality test.
- **Evidence**: Curl summary → compare numeric fields to Prisma aggregate query filtered by `Transaction.status = SUCCESS`.

### AC-7: Bursary CSV/JSON export uses collections-only endpoint
- **Type**: `rule`
- **Given**: Bursary opens the dashboard, selects date range containing 2 SUCCESS + 3 FAILED payments, clicks "Export CSV"
- **Then**: Downloaded CSV contains exactly 2 non-header rows, neither of which has Status = FAILED; no "Balance Owed" or "Expected" columns
- **Pass Condition**: End-to-end browser click → download → parse CSV → row count + header verification.
- **Evidence**: Manual export via puppeteer / browser snapshot; CSV downloaded to disk & inspected.

### AC-8: Pay Now creates no duplicate pending invoices
- **Type**: `rule`
- **Given**: A student clicks Pay Now on the same fee 3 times in rapid succession using the same `Idempotency-Key` header (or without changing it within 60 seconds)
- **When**: `SELECT COUNT(*) FROM invoices WHERE studentId=X AND feeId=Y AND status='PENDING'` runs
- **Then**: Count = 1; all 3 HTTP calls return the same invoiceId
- **Pass Condition**: Rapid-fire test script → SQL count + response equality.
- **Evidence**: Jest / smoke script hitting endpoint 3× concurrently.

### AC-9: Fee scope narrows catalogue visibility correctly
- **Type**: `rule`
- **Given**: Admin creates 3 fees: (A) Global, (B) narrowed to level=300, (C) narrowed to college="College of Medicine". Students: S1 (200 Law), S2 (300 Medicine), S3 (400 Engineering)
- **When**: Each student calls catalogue
- **Then**: S1 sees {A} only; S2 sees {A, B, C}; S3 sees {A} only
- **Pass Condition**: Per-student catalogue API responses match the set exactly (no extras, no missing).
- **Evidence**: Seed data + API tests.

### AC-10: Assignment wizard generate-now is off-by-default & warns
- **Type**: `rule`
- **Given**: Admin opens Assignment Wizard at Step 4
- **When**: UI renders
- **Then**: "Generate invoices immediately" checkbox defaults to **unchecked**; inline warning text says generation creates pre-invoices and is NOT recommended for a-la-carte flows; Fee default scope on Fee create page has no Assignment dependency
- **Pass Condition**: React render check + DOM snapshot.
- **Evidence**: OpenPreview snapshot + code property check `generateNow === false`.

### AC-11: UX clarity across all portals
- **Type**: `rubric`
- **Dimension**: Language & navigation clarity for end-users (students + bursar + admin)
- **Scale**: 1–5
- **Anchors**:
  - 1 = Confusing wording remains; student can still see an "owed amount" on landing; bursar still sees Expected vs Outstanding ratio
  - 3 = Words cleaned up, but default landing still shows history/invoices over catalogue; export still has ambiguous column names
  - 5 = Every default view opens to the correct role-centric page; every label explicitly says Paid / Available / Successful / Collections; zero "owed" language; export columns match Bursary payroll conventions
- **Pass Threshold**: ≥ 4
- **Evidence**: UI walkthrough checklist + rendered screenshots of each role's default landing screen.

### AC-12: Collections report responsiveness + pagination
- **Type**: `rubric`
- **Dimension**: Usability & performance of Bursary collections list/export at realistic scale
- **Scale**: 1–5
- **Anchors**:
  - 1 = Report times out on 500 rows; columns misalign on tablets/phones; no filters
  - 3 = Works for 1 k rows, pagination present but slow; filters subset of category/date only
  - 5 = Smooth ≤ 10 k rows with server-side pagination/date+category+faculty+level filters, CSV export streams, mobile-responsive (scrolls horizontal)
- **Pass Threshold**: ≥ 4
- **Evidence**: Seed 10 k receipts → API latency metric; browser viewport resize to 768 px.

## Open Questions
- [ ] NONE — user clarified all 4 key decision points via structured Q&A on 2026-09-23.
