# University Payment Gateway — Production Hardening & Students List Fix
## Product Requirements Document

## Overview
- **Summary**: Fix the Admin Students list display bug (shows "0-0 of 18" but no rows), audit and validate 3 portals end-to-end (Admin / Bursary / Student), and finalize sidebar to professionally required minimum. Ensure every remaining page, modal, filter, form-submit, and sidebar link loads cleanly with no spurious "Failed to load" dialogs.
- **Purpose**: Make the platform production-ready, professional, and bug-free per the original "simple and straightforward and robust" directive. Resolve the specific user-reported bug "18 students exist but not showing" and confirm every other screen is fully functional.
- **Target Users**: Super Admin (ADMIN role), Bursary (BURSARY role), Students (STUDENT role).

## Goals
1. **G1 — Critical Bug Fix**: Fix Admin `/admin/students` so 18 students actually appear on the table instead of "No students match your filters". The pagination counter correctly shows a total of 18, but rows never render because frontend reads `data.students` while backend service returns `{ items, total, page, pageSize, pageCount }`.
2. **G2 — Professional Lean Sidebar**: Finalize sidebar to only required navigation per the role-scoping rules. Admin sidebar: Dashboard, Students (4 links), Bills (5 links), Payments (1), Receipts (2), Academic (5), Administration (6). NO Reports, NO Refunds, NO Reconciliation for Admin. Bursary sidebar same scope plus Reconciliation, NO Administration role management. Student sidebar stays simple (Dashboard, Fees, Profile, Payments/Receipts).
3. **G3 — 3-Portal E2E Validation**: Authenticate as ADMIN then BURSARY then STUDENT. Navigate every sidebar item, open every modal, click every primary action button (New Student, Create Bill, Verify Receipt, Payment Flow, Faculty CRUD, Audit Logs). Verify zero spurious error dialogs.
4. **G4 — API Shape Consistency**: Normalize backend pagination response consumption on the frontend to use a canonical `{ items, total, page, pageSize }` contract (via shim service layer or inline normalization) so one-off direct API calls don't have row-array key mismatch bugs.
5. **G5 — TypeScript & Test Gates**: `tsc api EXIT 0`, `tsc app EXIT 0` with ZERO unused warnings. Jest 8 suite 134+ passing (unchanged baseline).

## Non-Goals
1. NG1 — No database migrations (no column renames / drops; only additive prisma changes allowed; keep using `prisma db push`)
2. NG2 — No new public marketing pages. No role changes / RBAC permission renames.
3. NG3 — No refund feature re-introduction. Policy = permanent.
4. NG4 — No student-facing gateway picker (single active gateway enforced, already done, verified, preserved).
5. NG5 — No ALAT Pay webhook flow re-test / merchant onboarding re-config (already done, inherited verified architecture from previous session).

## Background & Context
**Bug Evidence (DIAG1 completed)**:
- Backend `student.ts:L458` returns `{ items, total, page, pageSize, pageCount }`.
- Frontend `Students.tsx:L133` state type is `{ students: StudentRow[]; total; page; pageSize }` — wrong list key.
- Frontend `Students.tsx:L148-149` does `setData(res.data.data)` which sets `{ items:[18 students], total:18, ... }` into the state object typed with a `students` property.
- Result: `data.total === 18` (pagination shows "of 18") but `data.students === undefined` (no table rows).
- Other pages are already normalized via shim services (e.g., `facultiesApi.list()` returns `r.items` on L62, `auditApi.list()` L90 returns `res.items || []`). Students page is the only direct `api.get('/students')` caller WITHOUT normalizing `items → students`.

**Shape chaos identified across backend services (inherited, not a breaking change)**:
- `student.ts:L458` → `items` / `total` / `page` / `pageSize`
- `fee.ts:L365` → `fees` / `total` / `page` / `pageSize`
- `studentFee.ts:L106` → `rows` / `total`
- `academic.ts:L39` → `rows` / `total` / `totalPages` / `hasNext` / `hasPrev`
- Resolution for G4: Frontend shall READ whatever key is present via `const items = (data.students ?? data.items ?? data.rows ?? data.fees ?? [])` fallback OR create one service-layer shim. Do NOT change backend keys (risk breaking Jest/other callers).

**Sidebar (G2)**: Already trimmed in previous session (confirmed 7 groups / 18 items). G2 re-confirms via 3-portal browser audit that Admin has no Reports/Refunds/Reconciliation; Bursary has no Users/Roles/Permissions Admin-only group; Student has simple nav.

**3-portal credentials (known, inherited)**:
- Admin: `admin@university.edu.ng` / `admin123`
- Bursary: `finance@university.edu.ng` / `bursary123`
- Student: `student1@university.edu.ng` / `student123` (or any matric 2023/SCI/100N cohort if student1 password is override per TEST_STUDENT1_EMAIL).

## Functional Requirements
- **FR-1 — Students list**: Visiting `/admin/students` (authenticated ADMIN) renders a table with min(18, 25) student rows showing Name, Email, Matric, College/Dept/Program/Level/Status/Action buttons consistent with the Students.tsx component layout. Pagination footer says `1 – N of 18` (where N = 18). "No students match your filters" message only shows when `total === 0`.
- **FR-2 — Students filters work**: Search matric/name in top filter bar → after 220ms debounce → correct subset of students renders, total reflects filtered count.
- **FR-3 — Sidebar Add/Bulk/History (Students)**: Clicking Add Student → modal opens with empty form; Bulk Upload → opens 3-step wizard (Upload / Review / Confirm); History → scrolls to `#import-history` section. Sidebar-to-URL must be 2-way (on-page buttons update ?view= URL too).
- **FR-4 — Fees 5 tabs sidebar work**: Categories/Tab → categories list; Catalogue → fees list; Create → open fee form; Bulk Upload Bills → open upload step; Assignments → assignments list + wizard launch available.
- **FR-5 — Payments single list**: Filtering lives on-page (sidebar single entry only). No filter sub-items in nav.
- **FR-6 — Bursary role sidebar scope**: Logged in as BURSARY → sidebar includes Reconciliation group, excludes Administration (Users / Roles / Permissions) unless user has permission (Bursary role permissions scope is non-user-management).
- **FR-7 — No Refunds UI**: Sidebar never shows Refunds; deep-linking `/admin/refunds` or `/bursary/refunds` shows policy banner (no list API call, no error dialog).
- **FR-8 — Student portal**: Login works, dashboard loads, Fees dropdown shows bills, Checkout loads, Callback page loads (opens file user just opened Callback.tsx), PaymentResult, Profile all render.
- **FR-9 — All modal opens clean**: No React Internal Static Flag warning on any Modal open (fix already applied on Modal.tsx L20 via requestAnimationFrame, regression-check re-verify).
- **FR-10 — No spurious errors**: Every page listed in sidebar loads, `browser_console_messages` shows 0 `Failed to load` dialogs (excluding genuine expected 404 for empty academic config — such errors are documented and acceptable, and we note them not actionable).

## Non-Functional Requirements
- **NFR-1 Type Strict Zero Warn**: `tsc api EXIT 0` and `tsc app EXIT 0` with ZERO TS6133 unused var / TS6196 unused function warnings.
- **NFR-2 Baseline Tests Pass**: Jest 8 suites ≥ 134 passing (≥ 134 baseline). No regressions.
- **NFR-3 3-portal Login Load Time**: Each login < 3s dashboard render.
- **NFR-4 HMR**: Changing any TSX/TS file triggers Vite HMR, no full page reload required.
- **NFR-5 Axios interceptor**: Auth failures correctly redirect to `/login` (already built, verify).
- **NFR-6 Deep-linking Back/Forward Compatible**: Browser back/forward through ?view=create/upload/etc. or ?tab=categories/etc. → opens correct modal or section (URL as single source of truth).
- **NFR-7 Accessibility (belt)**: Modal backdrops have `role="presentation"`; focus management deferred with requestAnimationFrame; existing a11y preserved (not new work, regression pass).

## Constraints
- **Technical**:
  - Frontend: React 18, react-router v6, axios, lucide-react, Tailwind via className, Vite, TypeScript strict.
  - Backend: Node Express 4, Prisma, Zod, BullMQ, MySQL university_wallet via localhost socket /tmp/mysql.sock, JWT Authorization Bearer.
  - API auth = `Authorization: Bearer <token>` (no cookie sessions).
  - Do NOT rename backend list keys. Frontend adapts (backward compat shim only in frontend).
- **Business**:
  - NO refunds user-facing feature (sidebar link + list pages) permanently. Deep-link banner only.
  - ONE active gateway. Students see 1 checkout, NO gateway picker.
  - Reconciliation = Bursary-only page. Not in Admin sidebar.
  - Reports sidebar group = removed (navigation hidden, routes still available for deep link / bookmark admins who know URL — never delete routes to avoid 404s on saved links).
- **Dependencies**:
  - Existing `services/academicApi.ts` / `services/adminFees.ts` / `services/audit.ts` shim services pattern (follow for students if needed).
  - Existing Axios `api` instance at `app/src/services/api.ts` (baseURL = VITE_API_URL, interceptors for Authorization header attach + 401 → logout redirect).

## Assumptions
1. MySQL server still running, 18 student records present (verified with curl `/api/v1/students` → `total=18, items=18`).
2. Backend already tsc 0 / Jest ≥ 134 from previous session — frontend changes are Students.tsx shape fix only, should not touch backend.
3. Vite dev server still listening on http://localhost:5173 (IPv6 ::1, so use localhost not 127.0.0.1).
4. API dev server still listening *:3000.
5. Acceptance Criteria evidence from integrated browser snapshots / curl commands is authoritative; no physical device or production staging required for this current production-hardening pass.

## Acceptance Criteria
### AC-1: Students list table shows all 18 rows
- **Type**: `rule`
- **Given**: Authenticated Super Admin on route `/admin/students`; DB has ≥ 18 Student records (confirmed).
- **When**: Page finishes loading (loading spinner disappears).
- **Then**:
  1. Table `<tbody>` contains ≥ 1 `<tr>` with actual student data (name, email, matric columns rendered).
  2. Footer pagination text is NOT "0–0 of 18" — it shows a positive N (e.g., "1 – 18 of 18").
  3. No "Failed to load" alert dialog opens on mount.
- **Pass Condition**: Browser snapshot of `/admin/students` shows ≥ 1 non-header table row AND pagination text has "of 18" with positive from/to numbers.
- **Evidence**: TBD (browser snapshot after fix + console messages 0 errors).

### AC-2: Frontend shape-consistency shim
- **Type**: `rule`
- **Given**: Students.tsx load logic (line 133 + 148-149).
- **When**: `res.data.data` (paginated payload) arrives from backend with key `items` instead of `students`.
- **Then**: State object stores a row array under a consistent key that the `.map()` call actually iterates (either change state to `items`, OR normalize `items → students` at setData time, OR iterate using fallbacks `const rows = data?.students ?? data?.items ?? []`).
- **Pass Condition**: `tsc app` passes AND the state/list access uses the same key. Code review of Students.tsx shows the fix.
- **Evidence**: TBD (code diff + tsc 0 output).

### AC-3: 3-portal sidebar correctness
- **Type**: `rule`
- **Given**: User logs in as ADMIN then BURSARY then STUDENT.
- **When**: Viewing sidebar post-login (scroll to bottom if needed, check all groups).
- **Then**:
  - Admin side: Dashboard, Student management (All/Add/Bulk/History), Bills (5 tabs), Payments (1), Receipts (2), Academic (5), Administration (6 scrolled). NO Refunds link, NO Reports heading, NO Reconciliation heading.
  - Bursary side: Same skeleton except Administration group's Users/Roles/Permissions HIDDEN (Bursary cannot manage user access rights); Reconciliation VISIBLE; Refunds HIDDEN.
  - Student side: Dashboard, Fees, Payments/Receipts, Profile only (simple navigation).
- **Pass Condition**: 3 browser snapshots (one per role login) show the correct sidebars with / without the excluded group headings.
- **Evidence**: TBD (3 snapshots from browser).

### AC-4: 80% of Admin actions clicked + 0 failed loads
- **Type**: `rubric`
- **Dimension**: Admin sidebar link click-coverage with clean renders
- **Scale**: 1–5
  - 1 = < 40% links clicked, multiple "Failed to load" errors
  - 3 = 60% links clicked, ≤ 1 minor acceptable error (e.g., empty academic config 404)
  - 5 = ≥ 80% links clicked, 0 spurious Failed to load dialogs, all primary action buttons open their respective Modal/section cleanly
- **Pass Threshold**: ≥ 4
- **Evidence**: TBD (browser click-thru log + console_messages net new errors tally).

### AC-5: Jest baseline
- **Type**: `rule`
- **Given**: Any frontend hardening complete, tsc clean.
- **When**: Running 8-suite Jest command exactly per frozen command (health/regression/rbac/idempotency/email-secrets/academic-import/search-settings-notif/reconciliation).
- **Then**: Total passing ≥ 134; no new FAIL suite compared to baseline 134 / 142.
- **Pass Condition**: Jest output PASS.
- **Evidence**: TBD (command exit 0 with PASS counts).

### AC-6: Deep-link URL UI state (query params)
- **Type**: `rule`
- **Given**: Super Admin.
- **When**: Directly navigate to URLs:
  - `/admin/students?view=create` → Add Student editor open
  - `/admin/students?view=upload` → Bulk Upload 3-step modal open
  - `/admin/fees?tab=create` → Create Bill modal open
- **Then**: Each URL triggers the correct modal open automatically WITHOUT needing to click the header button.
- **Pass Condition**: 3 snapshots of the URLs + their respective modals open.
- **Evidence**: TBD (3 snapshots).

## Open Questions
- [ ] None. Bursary student1 credentials inherited from prior sessions (student123 default). If student account password mismatch occurs during AUDIT1 we'll handle by resetting password via admin Students:Reset Password (not a code bug).
