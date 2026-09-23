# University Payment Gateway — Production Hardening Implementation Plan
## All tasks must complete in order. 3 tasks are browser-click verification; 4 are code changes + gates.

## Task 1: Fix Students list display shape mismatch + normalize pagination
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - Update Students.tsx state shape to accept { items, total, page, pageSize } or canonical fallback `data?.students ?? data?.items ?? []` wherever `.map()` row iterates in Students.tsx. Update L133 type AND/OR L148-L149 setData to normalize: `setData({ ...payload, students: payload.items ?? payload.students ?? [] })` or re-type state to `items`. Keep the existing pagination math total/from/to calculation and the header "New Student" / "Bulk Upload" URL-sync buttons untouched.
  - Additionally, wherever the existing code reads `data?.students?.length` or `data?.students?.map` etc., use the same fallback so any future backend shape tweak or API minor version won't re-break display.
  - Ensure the fix is narrow (touch Students.tsx only — do not modify Bursary/student pages unless they share identical issue; we will audit other pages via T4-T6 browser clicks and add shims only if they are found broken).
- **Acceptance Criteria Addressed**: AC-1, AC-2, NFR-1
- **Test Requirements**:
  - `rule` TR-1.1: Code diff of Students.tsx shows list key reads the same key that backend actually returns (L149 items now propagates to the map call). Evidence: `git diff app/src/pages/admin/Students.tsx`.
  - `rule` TR-1.2: `tsc app EXIT 0` with ZERO TS6133 unused warnings. Evidence: tsc app command exit code 0 + stderr empty.
  - `rule` TR-1.3: `tsc api EXIT 0` (unchanged backend; fast sanity gate that T1 didn't break shared types if Students.tsx imported wrong types). Evidence: tsc api command output EXIT 0.
  - `rubric` TR-1.4: Dimension: Narrow/Surgical Fix Quality. Scale: 1-5 (1 = touched 10+ files with risk to unrelated; 3 = 2-3 files, some redundancy acceptable; 5 = 1 file Students.tsx touched + elegant normalization, zero risk elsewhere). Threshold: ≥ 4. Evidence: file-count stat of changes.

## Task 2: Re-run tsc app + tsc api for zero warnings (double gate)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T1
- **Description**:
  - Run tsc app/api independently twice to ensure no stale cached warnings.
  - If any TS6133/any unused remain from T1 (orphaned imports, unused state variables introduced by fallback), clean them to zero.
- **Acceptance Criteria Addressed**: NFR-1
- **Test Requirements**:
  - `rule` TR-2.1: `cd api && npx tsc --noEmit` → exit 0, no stderr text containing TS6133/TS6196/TS2307.
  - `rule` TR-2.2: `cd app && npx tsc --noEmit` → exit 0, same zero warnings.

## Task 3: Browser verify — Students page shows 18 rows + deep-links work (Admin)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T1, T2
- **Description**:
  - Navigate integrated browser to `/admin/students` (HMR will reload automatically after T1 code edits) and take a snapshot showing actual student rows.
  - Then navigate successively to `/admin/students?view=create`, `/admin/students?view=upload`, `/admin/fees?tab=create` and each time snapshot to confirm Modal auto-opens per AC-6.
  - Open browser_console_messages to count Failed to load dialogs = 0 net new (background 404s for empty academic config are NOT counted as spurious if they only appear once and don't spawn user dialogs).
- **Acceptance Criteria Addressed**: AC-1, AC-6
- **Test Requirements**:
  - `rule` TR-3.1: Snapshot of /admin/students tbody contains ≥ 1 `<tr>` with student data (name/email). Pagination text shows positive N not 0-0.
  - `rule` TR-3.2: Three deep-link snapshots each show their respective Modal open with correct title.
  - `rule` TR-3.3: browser_console_messages contains zero lines matching "Failed to load" or "Internal React error: Expected static flag".
  - `rule` TR-3.4: "New Student" button click updates URL to ?view=create AND opens Modal; close Modal clears URL back to base /admin/students. Bidirectional.

## Task 4: Admin full sidebar click audit + quick action buttons
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T3
- **Description**:
  - Starting from Admin dashboard, click ALL sidebar links:
    Dashboard, All Students, Add Student (modal), Bulk Upload (modal), Import History (scroll).
    Bills group (5 tabs: Categories, Catalogue, Create Bill modal, Bulk Upload Bills, Bill Assignments).
    Payments.
    Receipts group (All Receipts, Verify Receipt).
    Academic structure: Faculties, Departments, Programmes, Levels, Academic Sessions.
    Administration group (scroll if needed): Users, Roles, Permissions, System Settings, Payment Config, Audit Logs.
    Dashboard page's 3 Quick Management buttons: Add New Student, View Transaction Reports (should deep link), System Settings.
  - Every page that has a "+ Create X" button → click to open its Modal; close. Do NOT submit forms (no data creation for audit).
  - Track each click: passed = no "Failed to load" alert dialog; failed = alert dialog appears with actionable bug.
  - Expected acceptable: Academic pages may show "0 records" (empty data) — that's fine if table structure loads. Empty data is NOT a bug; Failed to load dialog IS a bug.
- **Acceptance Criteria Addressed**: AC-3 (Admin side), AC-4 (rubric coverage)
- **Test Requirements**:
  - `rule` TR-4.1: Snapshot after each group shows page header title matches sidebar link label.
  - `rubric` TR-4.2 (AC-4): Dimension coverage pass rate. Scale 1–5; 5 = 100% sidebar items clicked + each <Modal> opens without "Failed to load"; 3 = ≥ 60% clicked; 1 = < 40%. Threshold ≥ 4.

## Task 5: Bursary full portal click audit + sidebar scope check
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: T4
- **Description**:
  - Admin logout, then login with Bursary credentials `finance@university.edu.ng / bursary123`.
  - Verify sidebar scope exactly per AC-3 Bursary: Reconciliation visible, Administration Users/Roles/Permissions hidden, Refunds hidden.
  - Click: Dashboard, Students, Bills, Payments, Receipts, Reconciliation, Profile.
  - Navigate to `/bursary/refunds` manually to confirm banner not API list.
- **Acceptance Criteria Addressed**: AC-3 (Bursary)
- **Test Requirements**:
  - `rule` TR-5.1: Bursary sidebar snapshot shows "RECONCILIATION" heading + no "Administration: Users/Roles/Permissions" links.
  - `rule` TR-5.2: /bursary/refunds shows policy banner + no Failed API list dialog + no refunds table.
  - `rule` TR-5.3: Quick dashboard summary loads without error.

## Task 6: Student portal full click audit + payment flow sanity (non-finish)
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: T5
- **Description**:
  - Bursary logout, Student login `student1@university.edu.ng / student123`.
  - Click Dashboard, Fees, Payments/Receipts, Profile.
  - On Fees page → pick any bill → Pay Now button → go as far as the Checkout page loads (no actual payment submit needed). Verify Callback.tsx mounted page component renders the generic "Secure Checkout / Verifying" state properly (matches existing Callback.tsx structure).
- **Acceptance Criteria Addressed**: FR-8 (Student portal)
- **Test Requirements**:
  - `rule` TR-6.1: Student login succeeds, Dashboard renders student stats (or 0 stats) no error dialog.
  - `rule` TR-6.2: Fees page lists assigned fees (or empty "No fees assigned" message OK, not error).
  - `rule` TR-6.3: Pay Now reaches Checkout.tsx UI with no error (gateway public keys may be missing in test env → that's expected warning, not bug; actual gateway request failure allowed because this is sandbox; component must render).

## Task 7: Jest 8 suites gate ≥ 134 passing
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: T4, T5, T6 (parallel OK actually, set Depends None since frontend changes don't touch backend)
- **Description**:
  - Run the exact frozen Jest command (health.test.ts → reconciliation.test.ts).
  - If < 134 passing, triage failures vs frontend changes.
- **Acceptance Criteria Addressed**: AC-5, NFR-2
- **Test Requirements**:
  - `rule` TR-7.1: Jest result ≥ 134 passed tests (baseline 134/142) and EXIT 0.
  - `rule` TR-7.2: No new FAIL suite vs previous session baseline (if any suite fails, root cause must be documented and unrelated to Students.tsx fix OR fixed).

## Task 8: Independent self-review pass + write evidence
- **Status**: `pending`
- **Priority**: high
- **Depends On**: T1, T2, T3, T4, T5, T6, T7
- **Description**:
  - Independent check: read T1 diff, confirm shape normalization works.
  - Review screenshots from T3-T6 and confirm AC-1 through AC-6 pass conditions are met.
  - Score AC-4 rubric from TR-4.2 evidence.
  - Write completion evidence per task into tasks.md (Status=completed sections).
  - Write review.md checkpoint results per Spec Mode template.
- **Acceptance Criteria Addressed**: All AC coverage verified
- **Test Requirements**:
  - `rule` TR-8.1: review.md file exists and lists every AC with evidence link.
  - `rule` TR-8.2: Final Review result == `pass`.
