# University Payment Platform — Capstone (Batches A–E + Professional Sidebar) — Product Requirements Document

## Overview
- **Summary**: Close the remaining spec coverage gaps (Batches A through E per §45–§101 DoD) and replace the current top-horizontal `PortalNavbar` with a fixed, professionally-designed left sidebar navigation across all three portals (Student, Admin, Bursary).
- **Purpose**: Complete the remaining §45–§101 Definition of Done checklist, enforce spec-parity UI/UX structure across all three portals (§55 Student Portal, §56 Admin Portal), and deliver a financial-grade professional navigation shell (sidebar) instead of the current top-tab layout.
- **Target Users**:
  - Students (undergraduate/postgraduate/jupeb/part-time)
  - Administrators (full system control)
  - Bursary (finance operations; ADMIN inherits BUR-SARY scope per T22)

## Goals
1. Full §45–§101 remaining spec parity on the 6 priority gaps identified: Payment UX polish (§58/59/60/61/62/87), Email Notification Engine (§46/48/47), Academic Master Tables + cross-structure validation (§91/92), Internal vs Paystack Reconciliation System + Dashboard (§63/64), Global Search + Action Confirmations + Granular Permissions (§57/66/65).
2. Deliver a role-aligned fixed left-sidebar layout with section groups, icons, active-state indicators, badges, and role-scoped sections per §55 (Student Portal nav) + §56 (Admin Portal nav) including all submenu children listed verbatim in the spec.
3. Zero regression: maintain 98/98 Jest PASS, 0 `tsc --noEmit` errors for api+app, 0 prisma validate issues, 1832-module Vite build green, zero security degradations.

## Non-Goals
- **Not** a redesign of existing public routes (Portal chooser `/`, `/public/verify-receipt`, login screens, `/404`, `/unauthorized` — those remain as-designed).
- **Not** implementing optional §97 features (parent portal, SMS/WhatsApp, mobile app, scholarship/discounts/installments, hostel allocation, etc.).
- **Not** splitting the `users` table into separate `students` + `admin_users` tables (current convention: role-filtered User model per §2 spec constraints; that design is frozen).
- **Not** replacing the existing i18n engine (`src/i18n/en.ts` single source of truth — SSOT per user preference).
- **Not** introducing shadow/decorator types on Prisma models. Existing 14 schema tables are the canonical database contract (per §50–§51 delivered architecture, §53 DECIMAL(15,2) strategy frozen).

## Background & Context
Repository is frozen post R0 → R4 → R5 T16 → T20–T25 complete:
- 14-table Prisma schema on MySQL `university_wallet` via socket (`@`, `?socket=/tmp/mysql.sock`).
- RBAC: STUDENT / ADMIN / BURSARY. ADMIN inherits Bursary routes per PrivateRoute wrapper (`roles={['BURSARY','ADMIN']}`).
- 42/42 parametrized RBAC probes PASS (`rbac-matrix.test.ts`, 176-line serialized spec matrix).
- 56/56 core regression PASS (health 1 + 56 + 42 = **98/98 total Jest PASS**).
- Current navigation: `PortalNavbar` component renders a top-horizontal banner with optional inline tabs array. User has requested: "side pannel [sic] professionally doen" → replace with left-sidebar layout.
- Gaps remaining vs spec §45–§101 are enumerated in the Functional Requirements section below and map directly to Batches A–E in the prior coverage audit.

## Functional Requirements

### A. Payment UX Polish (Spec §58, §59, §60, §61, §62, §87)
- **FR-A1 (§58 Fee Card)**: Student invoice list / fee schedule renders cards with explicit sections: Fee Name badge, Academic Session, Amount (NGN), Paid (NGN), Outstanding (NGN) — one card per outstanding fee as written in spec.
- **FR-A2 (§59 Confirmation)**: Before redirect to Paystack, a standalone confirmation page (or modal if the user has a modal preference) shows verbatim the fields from §59: Fee name, Session, Amount, Student Full Name, Matric Number. Two explicit buttons — Cancel and Proceed to Paystack. Amount used on the confirmation page MUST come from server-side `(invoice.amountDue − invoice.amountPaid)` not frontend props.
- **FR-A3 (§60 Success)**: After callback+verify SUCCESS, a branded success page is shown with: checkmark hero, Amount (NGN), Reference (PAY-yyyy-nnnn), Receipt (REC-yyyy-nnnn), primary button Download Receipt (generates PDF + triggers browser download), secondary View Payment History (links to invoices/receipts).
- **FR-A4 (§61 Failure)**: After callback+verify FAILED/CANCELLED, a failure page is shown with: cross/warning hero, "No successful payment has been recorded" (exact spec verbiage), a [Try Again] button which re-initializes a fresh payment attempt (idempotency-safe via a new reference).
- **FR-A5 (§62 Pending)**: After callback+verify PENDING, a pending page shown with: amber warning hero, "We are waiting for confirmation from the payment processor. Do not make another payment immediately.", a [Check Payment Status] button that explicitly hits verify endpoint for the same paystack reference.
- **FR-A6 (§87 Transaction Details)**: Invoice list / payment history supports a click-through drawer or details view that shows: Receipt link, Payment Reference, Paystack Gateway Reference, Date, Time, Channel (actual returned by Paystack, not hard-coded), Status.
- **FR-A7**: Idempotency on reinitializations (§73): when a user clicks [Try Again] on an invoice that still has a PENDING transaction older than ~5 min, the backend either links the new init attempt to the existing PENDING row OR explicitly cancels/marks the old row before creating a new one — never double-book a valid SUCCESS without UNDERP/OVERPAID audit trails.

### B. Email Notification Engine (Spec §46, §47, §48)
- **FR-B1 (§48)**: New `services/email.ts` (backend) with pluggable SMTP transport using existing `.env` vars: `SMTP_HOST/PORT/SECURE/USER/PASS`, `EMAIL_FROM_NAME/FROM_ADDRESS/REPLY_TO_ADDRESS`. In dev/test where SMTP is unreachable, fall back to in-memory mail capture (return success + log the render output) so tests never require a live SMTP server (no credential commits, safe per §70).
- **FR-B2 (§46 Payment Successful)**: After `PaymentService.verifyPayment → SUCCESS + Receipt row created`, dispatch an async email to student address: Subject "Payment Successful", greeting "Dear [Firstname Lastname],", line "Your payment for [Fee Name] has been successfully received.", Amount NGN formatted, Reference PAY-xxx, Download Receipt CTA button linking to the frontend student receipt/PDF route.
- **FR-B3 (§46/§48 Extended Templates)**: Render + dispatch for: Payment Initiated (receipt not yet issued, "We are processing your payment of N"), Payment Failed ("Your payment attempt could not be completed. Please try again or contact bursary."), Payment Reversed ("A payment reversal has been applied."), Refund Processed ("Your refund request for PAY-xxx has been [status]."), Password Reset ("Click here to reset your password — valid for N minutes."), Student Account Created ("Your account has been created; matric NNN; temporary password NNN (first-login requirement)."), Payment Reminder N days before fee deadline (invoked by ad-hoc admin endpoint or scheduled bullmq job).
- **FR-B4 (§47 Admin Notifications)**: Separate channel for admin/bursary-destined in-app records + optional email: Large payment (threshold env-configurable, default ₦500,000), Failed payment, Payment anomaly (mismatched amount/UNDERPAID/OVERPAID flags on verify), Webhook failure on `webhook_events` attempts >= 3, Student import failed records >= threshold (default 10 errors per batch), Refund request submitted (new Refund row with REQUESTED status).
- **FR-B5**: All i18n strings for email templates live inside `src/i18n/en.ts email: { ... }` section following existing SSOT convention. Never hard-code literals in HTML body.

### C. Academic Master Tables + Cross-Structure Validation (Spec §91, §92)
- **FR-C1 (§91 Master Tables)**: Add five new Prisma models to the schema: `Faculty`, `Department`, `Programme`, `Level`, `AcademicSession`. Full relationships per spec: Faculty → many Departments, Department → many Programmes, Programme → many Levels. AcademicSession as a standalone row (e.g. "2026/2027" as name + startDate + endDate + isActive).
- **FR-C2**: Every new model has a system of unique constraints per §52: `Faculty.name UNIQUE`, `Department.name UNIQUE within FacultyId`, `Programme.name UNIQUE within DepartmentId`, `Level.code+programmeId` or `Level.level+programmeId UNIQUE`, `AcademicSession.name UNIQUE`.
- **FR-C3 (Backwards-safe migration)**: Existing free-text columns on User (`college`, `department`, `program`, `level`, `academicSession`) and Fee (`college`, `department`, `program`, `level`, `academicSession`) remain in place but additionally gain nullable FK columns pointing to their respective master-table rows. Admin CRUD pages can populate either; the bulk CSV import validates structure when master rows exist.
- **FR-C4 (§92 Cross-Structure Validation on Bulk Upload)**: When a bulk CSV student/fee import names a Faculty/Department/Programme/Level/Session that matches a master-table row, the import engine validates "department belongs to faculty", "programme belongs to department", "level belongs to programme" before any insert. On mismatch, emit a structured error per the spec: e.g. "Computer Science Department does not belong to selected Faculty." with row number + failed fields.
- **FR-C5 Admin CRUD**: Admin-only endpoints/pages for creating/listing/editing/deactivating (soft, not hard delete) Faculties, Departments, Programmes, Levels, Academic Sessions. Bursary gets READ-only on master tables per §65 permission matrix.
- **FR-C6 Fee Bulk Upload**: When master tables exist, a fee bulk import row that names master entries validates §92 before insert.

### D. Reconciliation System (Spec §63, §64)
- **FR-D1 (§63 Engine)**: Backend `services/reconciliation.ts` implements a structured compare run that takes a date range + optional fee filters. For each Paystack transaction in the specified window:
  1. Fetch internal `Transaction` rows (any status) by `paystackReference`.
  2. Classify each match into one of the buckets: MATCHED, AMOUNT_MISMATCH, MISSING_INTERNAL (Paystack success / not in internal success), MISSING_PAYSTACK (internal success / Paystack unsuccessful or absent), DUPLICATE_REFERENCE, REVERSED_TXN, MISSING_RECEIPT (internal SUCCESS / no Receipt row).
- **FR-D2 (§64 Dashboard)**: Admin/Bursary Reconciliation page renders the KPI card grid from the spec: System Records, Paystack Records, Matched, Amount Mismatch (count), Missing Internal (count), Missing Paystack (count) — each with delta coloring.
- **FR-D3 List+Filters**: A filterable/paginated reconciliation issues table with each classified row. Columns include: Date, Paystack Reference, Payment Reference, Classification (color-coded pill), Expected (NGN), Actual (NGN), Student (if known), Actions (Retry/Mark reconciled/Create Internal / View Paystack / View Internal).
- **FR-D4 Report Export**: Reconciliation report download endpoint (CSV + JSON) per §18 patterns (BOM, category subtotals + grand totals).
- **FR-D5 Audit Logging**: Every manual "Mark Reconciled" / "Create Internal" action is recorded in `audit_logs` with entityType RECONCILIATION + explicit old/new JSON.

### E. Global Search + Action Confirmations + Granular Permissions (Spec §57, §66, §65)
- **FR-E1 (§57 Global Search)**: Admin endpoint `GET /admin/search?q=` supports, with minimum 2 chars: matricNumber, firstName+lastName (substring), email substring, phoneNumber substring, Payment reference (reference column), Receipt number (receiptNumber column). For student-type matches return a compact profile containing: id, name, matric, email, totalFees, totalPaid, outstanding — so the admin search result drop-down or results page can immediately show "John Doe 2024/CSC/001 with 150k outstanding" with quick links: Profile / Fees / Invoices / Payments / Receipts per spec.
- **FR-E2 Search UI**: Admin portal nav exposes the global search bar within the sidebar/header (prominent). Rendered matches show iconographic type (student vs reference vs receipt) + the 5 one-click deep-links.
- **FR-E3 (§66 Dangerous-Action Confirmations)**: Introduce a typed `ConfirmAction` modal component wrapping the existing `Modal`. For student archive/fee delete/refund, show exactly the fields in §66: student name, transaction reference, formatted amount, explicit free-text Reason field for refund confirmations. Every sensitive backend route is NOT modified — the confirmation is purely a frontend UX guard, but the action itself is still atomic server-side with RBAC.
- **FR-E4 (§65 Granular Permissions)**: Introduce a `permissions` Prisma model + a junction `role_permissions` table (Role → Permission many-to-many). Seed default permission rows from §65 verbatim matrix (e.g. `VIEW_STUDENTS`, `CREATE_STUDENT`, `BULK_UPLOAD_STUDENTS`, `CREATE_FEE`, `EDIT_FEE`, `VIEW_PAYMENTS`, `VERIFY_PAYMENT`, `GENERATE_RECEIPT`, `PROCESS_REFUND`, `MANAGE_USERS`, `MANAGE_ROLES`, `SYSTEM_SETTINGS`, `PAYSTACK_CONFIG`, `AUDIT_LOGS_VIEW_FULL`, `AUDIT_LOGS_VIEW_LIMITED`). The `auth.ts JWT middleware` still resolves Role, but additionally resolves permission claims (loaded from DB at login or cached). Routes can specify a permission guard via a new `requirePermission` middleware. Existing role-based PrivateRoutes are preserved and act as broad gate; permission checks are additive (fail closed), so zero existing routes regress. Bursary is granted the §65 "limited" Audit Logs view scope (no user/role/PII columns in export).
- **FR-E5 Settings**: Admin-only `System Settings` page per §90 with sections: University Information, Payment Settings (keys masked, can reset), Receipt Settings, Academic Sessions. All sections RBAC'd via permissions.

### F. Professional Left Sidebar Navigation (§55 Student, §56 Admin Portal Design)
- **FR-F1 (Layout)**: Replace ALL current `PortalNavbar` wrappers on role-protected pages with a 2-column shell: Left column = fixed width (240–280px) professional sidebar; Right column = fluid main area with a thin top app bar (branded mini-header — contains user chip, Logout action, optional global search input) and the page content below.
- **FR-F2 (Sections per §55 Student Portal Nav)**: Student sidebar renders these exact items as a section group — Dashboard, My Fees, Make Payment (alias for invoices with outstanding filter), Payment History, Receipts, Profile, Support (disabled/placeholder — "Coming soon"), Logout.
- **FR-F3 (Sections per §56 Admin Portal Nav)**: Admin sidebar renders the exact section grouping per §56:
  - Dashboard
  - Students → dropdown/accordion group: All Students, Add Student, Bulk Upload, Import History
  - Fees → group: Fee Categories, Fee Structures, Create Fee, Bulk Upload Fees, Fee Assignments
  - Payments → group: All Payments, Successful, Pending, Failed, Reversed, Refunds
  - Receipts → group: All Receipts, Verify Receipt
  - Reports → group: Daily, Monthly, Session, Fee, Faculty, Department, Programme, Student
  - Administration (Admin-only) → group: Users, Roles, Permissions, System Settings, Payment Configuration, Audit Logs
  - Academic Structure → (from Batch C): Faculties / Departments / Programmes / Levels / Academic Sessions
  - Reconciliation → (from Batch D): Dashboard, Reports
- **FR-F4 Bursary Variant**: Bursary sidebar inherits Admin nav structure but hides Administration group (Users/Roles/Permissions/System Settings/Payment Config) per §65 matrix, shows limited scope Audit Logs link, includes Receipts, Reports, Reconciliation, Academic Structure read-only.
- **FR-F5 Visual Spec**: The sidebar follows strict design principles per user design preferences:
  - Edge-aligned, full height, no max-width constraints on the header (matches the user preference "edge-aligned, full-width header layouts without max-width constraints").
  - 8px grid system (margins, padding, icon sizes) — 8/16/24/32 increments only.
  - No shadows, no transitions, no complex gradients (user bundle size priority: ultra optimized CSS, explicit reject of visual fluff).
  - Icons: `lucide-react` icons exactly 16×16 px, monochrome (inherit text color), left-aligned in each row.
  - Active row: solid left accent bar (2px, role-tinted: blue=Student, gray=Admin, amber=Bursary), background tinted (bg role-specific tint: e.g. blue-50 for student), label text semibold.
  - Hover: background gray-50 only; NO other visual effects.
  - Badge counters: optional badge pill right-aligned on nav items (e.g. Outstanding Fees count on "Make Payment", Pending refunds count on "Refunds", Pending Webhook count on Reconciliation). Badge values are loaded via a lightweight aggregate endpoint or pulled from existing stats.
  - Responsive: Mobile `< 768px` sidebar collapses into a hamburger drawer (off-canvas). Tablet/desktop renders the sidebar permanently. 360 px screen usable; 4K usable (no fixed content max-width beyond sensible gutters).
  - WCAG: All nav links have `aria-current="page"` on active; groups labelled; focus visible outlines present; contrast ratio at minimum 4.5:1 for all rows/badges.
- **FR-F6**: Role-scope filter applied server-side + client-side — if role doesn't have permission for a nav item, the item is not rendered (fail-closed, never visually present + disabled — follow spec principles). `requirePermission` on the matching route already catches any forged URL navigation, but also the sidebar never offers it (so students can never see an Audit Logs link they can't click).
- **FR-F7**: New shell component lives at `app/src/components/PortalShell.tsx`. `PortalNavbar.tsx` remains in the repo for backwards compatibility for the duration of this capstone build, but every existing role-protected page (`AdminDashboard`, `AdminStudents`, `AdminFees`, `AdminRefunds`, `AdminAuditLogs`, `BursaryDashboard`, `BursaryRefunds`, `StudentDashboard`, `StudentFees`, `StudentProfile`, `StudentTransfer`, `StudentWithdraw`, `StudentCheckout`, `StudentCallback`) will migrate to use `<PortalShell role=...>` instead of `<PortalNavbar ... tabs=...>`.

## Non-Functional Requirements
- **NFR-1 (Zero Diagnostics Rule — frozen)**: `api` `tsc --strict --noEmit` exit 0; `app` `tsc --noEmit` exit 0; prisma validate exit 0; GetDiagnostics empty for all edited files. User frozen convention: no errors/warnings/hints in production state.
- **NFR-2 (Test Coverage Rule — frozen)**: After implementation, existing 98 Jest tests (health/regression/RBAC matrix) must continue to pass (98/98). Any new functionality has at least one rule-level Jest test per AC with independent evidence.
- **NFR-3 (SSOT — frozen per user preference)**: Single source of truth architecture: i18n literals must live exclusively in `src/i18n/en.ts`. Permission matrix seeds come from a single declarative PERMISSION_DEFS array in the seed/permission-init module. RBAC mapping is singular.
- **NFR-4 (Zero Trust / Security per §49)**: All new public endpoints have input validation via Zod, never echo raw errors to user (generic user-facing messages, detailed internal audit logs), no secret leakage into emails (§48 rule explicitly enforced: no credentials in email body — passwords can only be temporary passwords on first-created, and that template explicitly warns "please change on first login" with instructions + link to change).
- **NFR-5 (Money Storage Rule — frozen §53)**: All new amounts on Reconciliation/Notifications use DECIMAL(15,2) strategy or kobo integer for transmission to Paystack only — never floats in JS or DB.
- **NFR-6 (Idempotency — frozen §73 §74)**: All new financial mutations (reconciliation "Create Internal" actions, mark-reconciled, email dispatched for payment) are idempotent via unique reference-based upsert patterns; no duplicate rows on retries.
- **NFR-7 (CSS Size Rule — frozen per user preference)**: Produce minimal CSS bundle — no new shadow/transition/gradient CSS classes introduced; extend existing Tailwind utility classes exclusively.

## Constraints
- **Technical**: Prisma 5.22.0 on MySQL 8.x socket DSN. No schema changes to existing columns/constraints. All new columns/tables are additive; existing 14 tables remain immutable. ioredis LazyProxy pattern remains the canonical Redis singleton (frozen to prevent Jest hang). BullMQ worker `NODE_ENV=test` short-circuit preserved.
- **Business**: All successful financial transactions immutable — no hard deletes per §5 frozen constraint. Void receipts maintain 410 Gone for students but remain accessible to staff via direct lookup.
- **Dependencies**: Existing packages only where possible. For emails: add `nodemailer` (standard) if not in package.json — no other new dependencies allowed.

## Assumptions
- Browser users have cookies/localStorage enabled (JWT storage contract already implemented in AuthContext).
- SMTP credentials may be invalid in dev; the email service gracefully falls back to mock capture + 200 without crashing requests.
- Spec §92 cross-structure validation on import is only enforced when master-table rows exist for the given value. When master tables are empty (legacy), free-text columns on User/Fee continue to work without validation to avoid breaking admin UX.

## Acceptance Criteria

### AC-A1: §59 Confirm Payment renders 5 required fields before Paystack redirect
- **Type**: `rule`
- **Given**: A student has an UNPAID/PARTIALLY_PAID invoice and clicks PAY NOW on that invoice.
- **When**: The confirmation step loads before any Paystack redirect.
- **Then**: On that confirmation view it explicitly shows, verbatim from spec: Fee Name, Session, Amount, Student Name, Matric.
- **Pass Condition**: Values rendered (especially Amount) match server invoice.(amountDue − amountPaid) — confirmed via a Jest supertest endpoint that returns confirmation payload with a `serverComputedAmount` field, and a React test asserting the amount display matches.
- **Evidence**: Jest rule test + E2E DOM snapshot.

### AC-A2: Success page renders Download Receipt + Reference/Receipt numbers
- **Type**: `rule`
- **Given**: verifyPayment returned SUCCESS, receipt row REC-xyz created.
- **When**: Callback page navigates to success state.
- **Then**: Three actionable items visible: formatted amount NGN, PAY-yy reference, REC-yy receipt, and a button to actually download PDF (triggers receipt PDF endpoint).
- **Pass Condition**: Click handlers wired to correct endpoints verified via a React component test that spies on window.open or route navigation.
- **Evidence**: Jest React component test.

### AC-A3: Failure page prohibits "success" language
- **Type**: `rule`
- **Given**: verifyPayment returned FAILED/CANCELLED.
- **When**: Failure state renders.
- **Then**: No occurrence of the word "successful" or "success" in the displayed copy; exact phrase "No successful payment has been recorded." rendered.
- **Pass Condition**: Axe-dom or jest-dom text-match test.
- **Evidence**: Component test + screenshot.

### AC-B1: Payment successful email dispatches after Receipt row exists
- **Type**: `rule`
- **Given**: verifyPayment → SUCCESS path in `PaymentService`.
- **When**: GeneralLedger + Receipt rows are committed inside the existing $transaction.
- **Then**: AFTER that transaction commits (never inside, to avoid rollback coupling), the email service async-dispatches a Payment Successful email containing Fee Name, Amount (formatted NGN), PAY reference, Download Receipt link.
- **Pass Condition**: Jest test with SMTP transport mocked captures exactly 1 sent email with correct template text + no secrets.
- **Evidence**: Jest mock + i18n strings match.

### AC-B2: Emails never leak credentials
- **Type**: `rule`
- **Given**: All 7 email template variants.
- **When**: Rendered with any combination of user data and test fixtures.
- **Then**: The resulting rendered HTML/plaintext body never contains Paystack secret keys, JWT secrets, full password hashes, or the full value of a user's existing password (temporary "please change on first login" password IS allowed only on Student Account Created template, explicitly labeled temporary).
- **Pass Condition**: Static audit + Jest string-match tests on every template render output.
- **Evidence**: Jest test suite for email renderer.

### AC-C1: Academic Session + 4 hierarchy Master Tables created with correct UNIQUE constraints
- **Type**: `rule`
- **Given**: Post-migration Prisma schema.
- **When**: Run `prisma validate` + `prisma migrate diff` (validated).
- **Then**: Exactly 5 new tables exist with correct FK chains (Faculty -> Department -> Programme -> Level) and AcademicSession standalone; unique constraints match §52+§91 requirements.
- **Pass Condition**: prisma validate exit 0; Schema inspection confirms 5 new models + unique indices present.
- **Evidence**: prisma validate output + schema.prisma grep.

### AC-C2: Department-not-in-Faculty import rejection works
- **Type**: `rule`
- **Given**: A master Faculty "Science" exists with only Department "Computer Science".
- **When**: A CSV student row upload names Faculty="Science" + Department="Mass Communication".
- **Then**: The import engine classifies this row as INVALID with the exact error message pattern: "Computer Science Department does not belong to selected Faculty." (generalized per correct names).
- **Pass Condition**: Jest import-service unit test returns row error with correct code/message.
- **Evidence**: Jest service-layer test.

### AC-D1: Reconciliation classification bucket counts correctly
- **Type**: `rule`
- **Given**: A seeded fixture of 10 test payments (6 matched, 1 amount mismatch, 1 Paystack-only, 1 internal-only, 1 duplicate reference, 1 reversed, 1 missing receipt — edge overlaps combined).
- **When**: Reconciliation engine `run(DateRange)` executes.
- **Then**: Classification counts for each bucket (Matched, Mismatch, Missing Internal, Missing Paystack, Duplicate Reference, Reversed, Missing Receipt) exactly match the seeded expected counts.
- **Pass Condition**: Jest test asserts every bucket count.
- **Evidence**: Jest reconciliation.spec.ts with seeded fixtures.

### AC-D2: Reconciliation dashboard shows the 6 spec KPI cards
- **Type**: `rubric`
- **Dimension**: KPI visual parity with §64 spec layout
- **Scale**: 1–5
- **Anchors**: 1 = random layout no grid, 3 = grid layout no label/count structure, 5 = exact label names from §64 (System Records · Paystack Records · Matched · Amount Mismatch · Missing Internal · Missing Paystack) + colored pill deltas next to each count, alignment 8px grid
- **Pass Threshold**: >= 4
- **Evidence**: Browser screenshot of /bursary/reconciliation + DOM snapshot.

### AC-E1: Global search responds to matric substring with 5 links
- **Type**: `rule`
- **Given**: A seeded student `John Doe / 2024/CSC/001 / outstanding=150,000 NGN`.
- **When**: `GET /admin/search?q=2024/CSC/001` executes with admin JWT.
- **Then**: Response payload includes student John Doe, with the 5 spec deep-links (Profile / Fees / Invoices / Payments / Receipts) + outstanding balance displayed correctly on the results row.
- **Pass Condition**: Jest supertest asserts response shape, links, and balance.
- **Evidence**: Jest e2e + frontend component render with link buttons.

### AC-E2: Refund confirmation modal requires reason text field
- **Type**: `rule`
- **Given**: Admin is on Refunds page → clicks Process Refund on a REQUESTED row.
- **When**: Clicks [Confirm Refund] without entering a reason.
- **Then**: Confirm button stays disabled OR a validation error appears; a submit does NOT occur.
- **Pass Condition**: React test with form validation enabled on submit.
- **Evidence**: Jest component test.

### AC-E3: Granular permission fail-closed for Bursary on MANAGE_USERS
- **Type**: `rule`
- **Given**: Bursary JWT but permission MANAGE_USERS is absent from role_permissions for BURSARY role (seed default).
- **When**: A Bursary JWT hits GET /admin/users (route now protected with requirePermission('MANAGE_USERS')).
- **Then**: HTTP 403.
- **Pass Condition**: rbac-matrix.test extended with new probe for Bursary on Admin Users route.
- **Evidence**: Jest rbac-matrix test output showing additional green PASS lines.

### AC-F1: PortalShell left sidebar layout with Student/Admin/Bursary sections
- **Type**: `rubric`
- **Dimension**: Sidebar professional design parity vs §55/§56 verbatim spec nav structure
- **Scale**: 1–5
- **Anchors**:
  1 = No sidebar or sections missing structure;
  3 = Sidebar exists but some groups missing or flat (no accordion groups);
  5 = Exact section grouping as §55 for Student (8 items Dashboard→Logout), exact §56 grouping for Admin (Dashboard/Students 4/Fees 5/Payments 6/Receipts 2/Reports 8/Administration 6/Academic 5/Reconciliation 2) plus role-scoped Bursary variant with Administration hidden and limited scope links; every nav item has a 16×16 lucide icon; active state rendered with left accent bar + role-tinted background; 8px grid everywhere; no shadow/transitions/gradients; badges present where counts exist.
- **Pass Threshold**: >= 4
- **Evidence**: Browser full-page screenshots of Student / Admin / Bursary dashboards with sidebar visible + component DOM snapshot.

### AC-F2: Role filtering fail-closed on nav items
- **Type**: `rule`
- **Given**: Bursary user logged in.
- **When**: PortalShell renders nav for Bursary.
- **Then**: No DOM element is present for any Administration subsection (Users, Roles, Permissions, System Settings, Payment Configuration, Paystack Config). i.e. no `display:none` hack — the node is never created.
- **Pass Condition**: React render test with role=BURSARY + querySelector for those nav returns null.
- **Evidence**: Jest React test + snapshot.

### AC-F3: 360px / 4K viewports usable (responsive extreme)
- **Type**: `rubric`
- **Dimension**: Responsive behavior on extreme viewports
- **Scale**: 1–5
- **Anchors**: 1 = 360px broken horizontal scroll required; 3 = usable at desktop but small/large break points awkward; 5 = 360px has full-height hamburger drawer with close affordance; 4K (3840px) keeps sidebar fixed width, main area fluid but content area capped at readable width; zero horizontal scroll on both extremes
- **Pass Threshold**: >= 4
- **Evidence**: Browser screenshots at 360×720 and 3840×2160 viewports.

### AC-F4: `aria-current="page"` on active nav
- **Type**: `rule`
- **Given**: User navigates to /admin/students.
- **When**: React page renders.
- **Then**: The "All Students" nav item (or active group) has the attribute aria-current="page".
- **Pass Condition**: jest-dom getByRole('navigation') query within the sidebar matches.
- **Evidence**: React component test with jest-dom assertion.

### AC-OV1: Zero regression on existing 98 Jest tests + zero tsc/prisma diagnostics
- **Type**: `rule`
- **Given**: Implementation complete.
- **When**: Run:
  ```
  cd api && npx prisma validate
  cd api && npx tsc --noEmit
  cd app && npx tsc --noEmit
  cd api && NODE_ENV=test npx jest health.test.ts regression.test.ts rbac-matrix.test.ts --runInBand --detectOpenHandles
  cd app && npm run build
  cd api && npm run build
  ```
- **Then**: All commands exit 0; Jest shows exactly 98/98 tests PASS (or more if new tests added — minimum 98).
- **Pass Condition**: All commands 0 exit + test count pass.
- **Evidence**: Command outputs captured in tasks.md completion evidence.

## Open Questions
- [ ] §90 System Settings UI — should University Information fields (Name, Logo, Address, Phone, Email, Website) be persisted in a new `SystemSettings` singleton table (recommended) OR via env config only? Assumption: **`SystemSettings` singleton table, Admin-only edit** — plan accordingly; flag if needs override.
- [ ] §46 "Send email" async dispatch after Receipt commit — dispatch via direct Promise.then(non-await) or via BullMQ queue (recommended: add `email` BullMQ queue so retries + idempotency work automatically)? Assumption: **BullMQ queue job `dispatchEmail`** with idempotency key `emailType:reference:recipientId`. Confirm or override before Approve.
- [ ] §63 Reconciliation compare mechanism — should Paystack transaction list be fetched live via Paystack list API during reconciliation run, or accept an uploaded CSV/JSON of Paystack exports? Assumption: **LIVE via Paystack list endpoint**, with date-range pagination, and CSV upload fallback for offline reconciliation.
- [ ] §55/§56 Sidebar exact top icon "brand logo" — does university have a logo URL, or should the brand block simply be the platform name (text-only per §88 Receipt design)? Assumption: **text brand block** (user design preference: minimal bundle, no images) unless logo URL provided via System Settings from above.
