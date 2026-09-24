# University Payment Platform — À-la-carte Fee Catalogue & Collections-Only: Implementation Plan

## Task 1: Backend — Catalogue endpoint scope + global-fee default
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: None
- **Description**:
  - Audit `GET /students/fees/catalogue` controller (and underlying `studentFees` service) to ensure it matches Fee.scope fields (college/department/program/level/studentType/academicSession) against the authenticated student's user fields, **plus includes all NULL-scoped Fees** regardless of student fields (global-catalogue rule).
  - Verify/ensure the Admin Fee CRUD controller (POST `/admin/fees`) creates fees with scope fields defaulting to NULL (not inherited from session or admin) when the request body omits them — i.e. do NOT force college/department/level from admin defaults.
  - Ensure catalogue only returns `isActive = true` fees; inactive fees can still be queried by admin/bursary only.
  - Add unit test verifying 5 students with different profiles all see the same scope-NULL global fee (AC-1 + AC-9).
- **Acceptance Criteria Addressed**: AC-1, AC-9
- **Test Requirements**:
  - `rule` TR-1.1: Create a fee with all scope=NULL; fetch catalogue as student1..student5 JWTs → all 5 responses include feeId in result set.
  - `rule` TR-1.2: Create fee narrowed to {level: 300, college: "Medicine"}; only Medicine-300 student sees it; others excluded; global fee still visible to all.
  - `rule` TR-1.3: Inactive fees are excluded from student catalogue; still returned in admin/bursary fee list endpoints.
- **Notes**: Edit only fee list controller + student catalogue service; no Prisma schema changes required.

## Task 2: Backend — Deferred invoice creation + idempotency (no UNPAID rows)
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 1
- **Description**:
  - Modify `ensureInvoiceForFee` / `POST /students/fees/:feeId/ensure-invoice` endpoint to enforce: (a) status always starts as `PENDING` (never `UNPAID`); (b) uniqueness check: `UNIQUE(studentId, feeId)` guarded by `WHERE status IN ('PENDING', 'PARTIALLY_PAID')` — or use the inbound `Idempotency-Key` header to deduplicate.
  - On Paystack/ALAT callback success → set status `PAID` and create Receipt row as today (existing flow); on failure/abort → set status `FAILED` or `CANCELLED`, never leave dangling `UNPAID`.
  - Ensure that merely browsing the catalogue **never** calls ensureInvoiceForFee; it is only invoked on the explicit Pay Now click from `goConfirm()` in `Fees.tsx`.
  - Add deduplication test: 3 parallel requests with same idempotency-key → exactly 1 Invoice row created, all 3 responses return the same invoiceId (AC-8).
  - Add pre-click test: after 100 catalogue GETs for a student → `SELECT count(*) FROM invoices WHERE studentId=X AND feeId=Y` is still strictly 0 (AC-2).
- **Acceptance Criteria Addressed**: AC-2, AC-8
- **Test Requirements**:
  - `rule` TR-2.1 (AC-2): Before Pay Now click, invoice row count = 0; after 1 click = 1 PENDING.
  - `rule` TR-2.2 (AC-8): 3 concurrent ensure-invoice calls → row count = 1, all responses share invoiceId.
  - `rule` TR-2.3: Status flow on failed callback → FAILED (not UNPAID); legacy UNPAID rows untouched by ensure flow.
- **Notes**: `FeeAssignment` generate-invoices path (old bulk flow) can still create UNPAID rows per existing behaviour; Task 6 will mark the flow as not-recommended.

## Task 3: Backend — Student invoice list filters UNPAID (role-aware policy)
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 2
- **Description**:
  - Update `GET /students/invoices` controller to implicitly exclude `InvoiceStatus.UNPAID` when the caller has `role = STUDENT`. If an explicit `?status=UNPAID` is passed by STUDENT → still return empty array (safe fallback).
  - For ADMIN / BURSARY callers → continue to allow UNPAID status filter via explicit query for data-retention access.
  - Preserve existing `PARTIALLY_PAID / PAID / PENDING / FAILED / CANCELLED / REVERSED / REFUNDED` visibility for all roles (these represent real payment attempts, not artificial debt).
  - Add Jest unit test with 5 invoices (one per status) → STUDENT list excludes UNPAID; ADMIN list includes UNPAID when explicitly filtered (AC-3).
- **Acceptance Criteria Addressed**: AC-3, AC-12 (pagination preserved)
- **Test Requirements**:
  - `rule` TR-3.1 (AC-3): Mixed-status seed → Student API returns 4 rows (excludes UNPAID), Admin API with ?status=UNPAID returns exactly 1 row.
  - `rule` TR-3.2: Student API with ?status=UNPAID still returns empty array and 200 OK (no errors).
  - `rubric` TR-3.3: List query performance — paginated 25/page response ≤ 200 ms with 500 invoice rows. Scale: 1–5; anchors 1= >1 s, 3=~400 ms, 5= ≤200 ms; threshold ≥ 4.
- **Notes**: Use existing Prisma `where: { status: { not: 'UNPAID' } }` for student path.

## Task 4: Backend — Collections-only Bursary endpoints (summary + trend + by-category + payout report)
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 3
- **Description**:
  - Rework `/bursary/dashboard/summary` → cards: (a) Total Collected = `SUM(transactions.amount) WHERE status=SUCCESS`, (b) Total Receipts = `COUNT(DISTINCT receipt.id) WHERE not voided`, (c) Collections Count = successful txn count, (d) Average Transaction. DELETE: `totalOutstanding`, `expectedInvoicesTotal`, collection-ratio cards entirely.
  - `/bursary/dashboard/trend` buckets `SUM(transactions.amount) WHERE status=SUCCESS` by day/week/month → ignore all failed/pending entirely (previous inclusion bug → previously could have mixed statuses; now enforce strict filter).
  - `/bursary/dashboard/by-category` → joins through Invoice → Fee → Category, still with `transactions.status=SUCCESS` where-clause; sums only collected amounts per category.
  - Create new `/bursary/reports/collections` endpoint with required payout columns: `receiptNumber, paidAt, studentName, matricNumber, college, department, program, level, feeName, feeCode, categoryCode, categoryName, paidAmount, gateway, channel, transactionReference, status`. Filters: dateFrom/dateTo (required), categoryId/facultyId/levelId/studentId (optional). Supports `format=json | csv` with correct `Content-Disposition` header + UTF-8 BOM for Excel compatibility. Server-side pagination via `page / pageSize` (AC-5, AC-6).
  - Refactor existing `bursary/reports/collections?format=csv` if it already exists to match this stricter contract.
  - Add integration tests: 3 SUCCESS + 2 FAILED + 2 PENDING → CSV = header + 3 data rows; summary-card total equals `SUM(3 success.amount)` exactly (AC-5, AC-6).
- **Acceptance Criteria Addressed**: AC-5, AC-6, AC-12
- **Test Requirements**:
  - `rule` TR-4.1 (AC-5): CSV header matches exact string; JSON row count=3.
  - `rule` TR-4.2 (AC-6): Summary card total === SUCCESS-SUM Prisma aggregate; trend-sum === SUCCESS-SUM; category-sum === SUCCESS-SUM.
  - `rule` TR-4.3: `bursary/reports/collections` with explicit `?status=FAILED` param → empty result (enforced SUCCESS-only regardless of query; reject non-success queries with 200 + empty to avoid info leak).
  - `rubric` TR-4.4 (AC-12): 10,000 receipts → endpoint ≤ 2 s. Scale 1–5 (1=>10+ s, 3=~5 s, 5≤2 s); threshold ≥ 4.
- **Notes**: MySQL indexes on `transactions(status, createdAt)`, `receipts(studentId, paidAt)` are already likely present; verify via EXPLAIN — add if missing only when needed.

## Task 5: Backend — Bursary Payments list tab default SUCCESS filter
- **Status**: `pending`
- **Priority**: `medium`
- **Depends On**: Task 4
- **Description**:
  - Audit `GET /bursary/payments` or equivalent transaction list endpoint. Ensure when no `?status=` param is passed → default is `SUCCESS` only. ADMIN/BURSARY can still override with explicit `?status=PENDING,FAILED` etc. to debug.
  - Remove any UNPAID filter options from the backend default query; keep them only when explicitly requested.
  - Keep receipt voiding + download functional.
- **Acceptance Criteria Addressed**: AC-9 (partially — backend default filter).
- **Test Requirements**:
  - `rule` TR-5.1: Default GET /bursary/payments returns only SUCCESS rows; explicit status param still works for non-success debug.
- **Notes**: Likely lives in `api/src/controllers/bursary.ts` or dedicated `payments.ts` controller.

## Task 6: Frontend — Student dashboard KPIs + landing page cleanup
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 1, Task 3 (contract changes)
- **Description**:
  - Edit `app/src/pages/student/Dashboard.tsx`:
    - Delete (or hide when computed 0) any card/language reading "Outstanding", "Total Billed", "Amount Owed", "Balance Due", or equivalent. Replace with:
      - KPI 1: "Amount Paid" (from `schedule.totalPaid` / OR new aggregated endpoint derived from SUCCESS transactions only)
      - KPI 2: "Payments Completed" (count of SUCCESS)
      - KPI 3: "Recent Activity" (last 5 payment confirmations, receipts)
    - Default open tab on Student Portal landing → redirect to `/student/payments` (Make Payment = catalogue grid). If currently Dashboard is landing, preserve it but the first prominent CTA must be "Browse Available Payments →".
    - Invoice list within Dashboard (Invoices tab): filter dropdown still shows "Unpaid" but it will return empty (backend-guarded); alternatively hide "Unpaid" from student-facing filters to reduce confusion.
  - Edit `app/src/pages/student/Fees.tsx → InvoicesPage`: Remove the "Balance" column where it would read as an owed amount; show "Amount Due + Amount Paid" alongside status (since it refers to a specific payment ATTEMPT, not a general debt). Update header labels to "Attempt Amount" / "Amount Paid" if clearer.
  - Grep `app/src/i18n/en.ts` for banned strings → remove or rename to Paid language (AC-4).
- **Acceptance Criteria Addressed**: AC-4, AC-11
- **Test Requirements**:
  - `rule` TR-6.1 (AC-4): `grep -iE "outstand|billed|amount.owed|receivable|expected total|balance.owed" app/src i18n --include=*.ts --include=*.tsx` → 0 matches after edits.
  - `rubric` TR-6.2 (AC-11): Clarity of Student landing experience. Scale 1–5 (1=debt terms still visible, 3=terms removed but views still invoice-first, 5=views catalogue-first with clean "Available Payments" language); threshold ≥ 4.
  - `rule` TR-6.3: Student `/student` default route / CTA opens Available Payments catalogue.

## Task 7: Frontend — Bursary dashboard cards + Collections report + Export
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Task 4 (summary/report endpoints)
- **Description**:
  - `app/src/pages/bursary/Dashboard.tsx`:
    - Replace `outstandingRatio`, `totalOutstanding`, `expectedInvoicesTotal` with new collections cards: Total Collected, Receipts Issued, Transactions Count, Average Amount.
    - Rename any cards reading "Expected Collections" or "Receivables" → "Collections Trend" or similar.
    - Trend chart + by-category chart now reflect SUCCESS-only data (backend already filters — ensure UI labels read "Collections Trend" not "Invoices Trend").
  - `app/src/pages/bursary/Payments.tsx` (if present, or Dashboard payout section):
    - Add a **Collections Payout Table** tab showing columns matching the new report CSV header exactly (Receipt No., Date, Student, Matric, Faculty, Dept, Level, Fee, Category, Amount, Gateway, Channel, Status). Server-side pagination page/pageSize, filters for date range / category / faculty / level; default status filter = SUCCESS with dropdown to change it for debugging.
    - Wire the existing "Export CSV" and "Export JSON" buttons to the new `/bursary/reports/collections?format=csv|json` endpoint passing the current filters; ensure Content-Disposition filename is preserved (AC-5, AC-7).
  - Grep `app/src/pages/bursary` for banned strings → replace with collections-only terminology (AC-4).
  - Browser-click smoke test: export CSV → download completes, columns match (AC-7).
- **Acceptance Criteria Addressed**: AC-4, AC-6, AC-7, AC-11, AC-12
- **Test Requirements**:
  - `rule` TR-7.1 (AC-4): Grep Bursary pages for banned terms → 0 runtime matches.
  - `rule` TR-7.2 (AC-6): Dashboard totals match mock SUCCESS-SUM data exactly.
  - `rule` TR-7.3 (AC-7): Simulate export button click → blobs contain only SUCCESS rows + correct headers.
  - `rubric` TR-7.4 (AC-11): Clarity of bursary landing (1=outstanding ratios still prominent, 3=hidden but tabs still invoice-ish, 5=collections payout default view); threshold ≥4.
  - `rubric` TR-7.5 (AC-12): Collections table pagination responsiveness (mobile width ≤ 768 px → horizontal scroll; desktop ≤1920 → no wrap). Scale 1–5; threshold ≥4.
- **Notes**: Export button was already present. You may need to add filter query params that were missing in the call to match the new endpoint contract.

## Task 8: Frontend — Admin Fees form + Assignment Wizard policy defaults + warnings
- **Status**: `pending`
- **Priority**: `medium`
- **Depends On**: Task 6
- **Description**:
  - Edit `app/src/pages/admin/Fees.tsx`:
    - Fee-form step: all scope fields (college/department/program/level/studentType/semester) default to **empty** = global scope. Update the placeholder text to say: "Leave blank — visible to all students".
    - Fee-form add an inline hint: "Scope filters narrow which students see this fee in their catalogue. You do NOT need to create an Assignment to publish this fee."
  - Assignment Wizard (Step 4 → Step 5):
    - Flip `generateNow` default initial state from `true` → `false`.
    - Add a warning alert-box below the checkbox reading exactly: "⚠️ Generate creates UNPAID invoice rows for matching students and is **not recommended** for the default a-la-carte flow. Use this ONLY if you specifically want to track pre-issued invoices per student (e.g. legacy debt rollover)." (AC-10)
    - Assignment wizard still remains fully functional; just de-emphasised.
  - Nav label tweaks: Admin sidebar "Fees" → perhaps rename to "Bills / Fee Catalogue" for clarity (also update i18n `adminFees.fees.pageTitle`).
- **Acceptance Criteria Addressed**: AC-10, AC-11
- **Test Requirements**:
  - `rule` TR-8.1 (AC-10): Open create-fee form → all scope fields = empty at mount; Generate-now checkbox = unchecked; warning alert present in wizard Step 4.
  - `rubric` TR-8.2 (AC-11): Admin workflow clarity (1=Assignment still required, 3=assignment optional but confusing, 5=clearly indicates "create fee = publish directly → assignment legacy only"); threshold ≥4.
- **Notes**: No backend change needed here; purely frontend UX defaults.

## Task 9: Full system audit pass — grep + browser smoke (AC-4 global, AC-7 end-to-end, AC-11 rubric)
- **Status**: `pending`
- **Priority**: `high`
- **Depends On**: Tasks 1–8 completed
- **Description**:
  - Repository-wide `grep -iE` for banned terms ("outstand", "billed", "owed", "receivable", "expected total|collection|amount", "balance forward") in:
    - `app/src/**`
    - `api/src/**`
    - `app/src/i18n/**`
  - Any hits → either (a) the code path is legacy/test-only, or (b) must be renamed to "Paid / Collections / Completed" language. Produce a final report listing matches, reason kept-if-any.
  - End-to-end smoke flows:
    1. Admin creates a global fee → student1..5 each: login → land → Available Payments → see card → Pay Now → mock gateway success → Receipt generated → Bursary collections report CSV includes the exact 5 new receipts with correct columns. No UNPAID invoice rows created.
    2. Bursary dashboard: export CSV with date filters → downloads, column headers match payout spec exactly, failed txns excluded.
    3. AC-11 rubric screenshots of each role landing page for review evidence.
  - Run existing Jest health tests (`cd api && npm test`) — ensure they still pass (no regressions).
- **Acceptance Criteria Addressed**: AC-4, AC-7, AC-11 (rubric score), plus general regression guard.
- **Test Requirements**:
  - `rule` TR-9.1: Final grep banned terms → 0 production matches (explicitly exclude `__tests__` + enum comments).
  - `rule` TR-9.2: E2E smoke flow 1 → CSV row count = 5 new receipts.
  - `rule` TR-9.3: Existing `api/src/__tests__/health.test.ts` passes. Any other passing tests in the suite are recorded.
  - `rubric` TR-9.4 (AC-11): Aggregate UX score across all three roles ≥ 4/5; rationale + screenshots.
- **Notes**: This task compiles evidence for all rubrics and the final global rule before entering the Review gate.
