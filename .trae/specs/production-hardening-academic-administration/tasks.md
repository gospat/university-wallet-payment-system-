# Academic Structure + Administration Hardening — Implementation Plan

## Task 1: Academic Structure audit + CanceledError/navCounters guards (FR-1 to FR-5, NFR-2, AC-1, AC-8)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - Add CanceledError/aborted signal guard catch pattern to 5 academic pages: Faculties.tsx, Departments.tsx, Programmes.tsx, Levels.tsx, AcademicSessions.tsx. Guard: `if (signal?.aborted || err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;` BEFORE any setAlert/setError in load() catch.
  - Add navCounters catch guard: `useEffect(() => { navCounters().then(setNavCounts).catch(() => setNavCounts({})); }, [])` pattern (add `navCounts: NavCounters` state + import `navCounters,NavCounters` from services/api).
  - Browser click audit: for each of 5 pages (sidebar Faculty / Dept / Prog / Level / Session): nav to page → wait 4s → browser_snapshot (main selector, maxDepth 6) → browser_console_messages. Click +Create button → modal opens → snapshot → click Cancel → modal closes. Click any Pencil Edit row button → modal opens → snapshot → click Cancel. Click Ban/Deactivate → confirm dialog opens → click Cancel → no data actually deactivated (just verify dialog).
- **Acceptance Criteria Addressed**: AC-1, AC-8
- **Test Requirements**:
  - `rule` TR-1.1: Every 5 pages grep `catch\(` blocks include err.code==='ERR_CANCELED' OR signal.aborted check → 5/5 grep hits. Evidence: grep -c output lines file.
  - `rule` TR-1.2: Every 5 pages has navCounters `.catch(() => setNavCounts({}))` (or equivalent empty fallback) — never unhandled rejection. Evidence: grep 5/5 pages hits.
  - `rule` TR-1.3: Each of 5 pages browser_console_messages returns 0 [error]/0 [warning] lines (only React DevTools info allowed). Evidence: 10 console outputs (5 pages + 5 modals) concatenated.
  - `rule` TR-1.4: Departments page snapshot includes faculty FK dropdown populated in create/edit modal (≥1 faculty option). Evidence: snapshot modal <select> options nodes.
  - `rubric` TR-1.5: Academic click audit quality. Dimension: 5-page load+modal-click thoroughness; scale 1-5; anchors:1=fails to load all 5;3=loads but only opens half the modals;5=every page navigates, creates opens, edits opens, deactivate confirms, list renders rows (or empty state if 0 rows clean); threshold ≥ 4. Evidence: snapshot nodes count per page showing table/columns/rows/pagination footer.
- **Notes**: Academic pages ALREADY use correct `r.items` key (per academicApi L77 ListResponse interface), no normalization needed — only CanceledError/nav guard additions.

## Task 2: admin.ts add Users CRUD backend routes (FR-6, FR-11, NFR-5, NFR-6, AC-2, AC-4, AC-6)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None (backend tasks independent of frontend Task 5/6/7/8/9)
- **Description**:
  - Import `catchAsync, protect, restrictTo, requirePermission, validateBody/Query/Params` already in admin.ts imports.
  - Add Zod schemas: UsersListQuery (page, pageSize, role? ∈ ADMIN|BURSARY, q?), UserCreateBody (email,firstName,lastName,role, password optional, accountStatus optional), UserUpdateBody (firstName,lastName,role,accountStatus,phone,college,department), UserIdParam (id coerce number int positive), UserResetPasswordBody, UserToggleStatusBody.
  - Routes: GET /admin/users, GET /admin/users/:id, POST /admin/users, PATCH /admin/users/:id, POST /admin/users/:id/deactivate, POST /admin/users/:id/reset-password.
  - Query: prisma.user.findMany (select: exclude password), where q email/name contains, role=filter, skip/take, count page. Mutation: bcrypt hash password if creating. auditLog CREATE_USER/UPDATE_USER/ACCOUNT_STATUS_CHANGE/PASSWORD_RESET rows write.
  - Exclude STUDENT role from users list (it's admin/bursary portal users only; students managed by Students page with different service). select role ∈ {ADMIN, BURSARY} where filter always.
  - Add requirePermission('MANAGE_USERS') middleware on all 6 routes.
- **Acceptance Criteria Addressed**: AC-2 (1/5 backends), AC-4 (backend part), AC-6
- **Test Requirements**:
  - `rule` TR-2.1: curl GET /admin/users?page=1&pageSize=25 returns HTTP 200 JSON status=success data.items array + total/page/pageSize/pageCount. Evidence: curl -i output.
  - `rule` TR-2.2: POST /admin/users body {email,firstName,lastName,role:'BURSARY'} returns 201 & id of new user; password field NEVER returned anywhere in JSON (confirmed via grep 'password' in curl response body = 0 matches). Evidence: 2 curl outputs (create + get list), grep password 0.
  - `rule` TR-2.3: POST /admin/users/:id/deactivate toggles accountStatus → GET /admin/users/:id shows updated status. Audit log action=ACCOUNT_STATUS_CHANGE present (curl /admin/audit-logs action=ACCOUNT_STATUS_CHANGE count ≥ 1). Evidence: curl + grep.
  - `rule` TR-2.4: POST /admin/users/:id/reset-password returns 200, plaintext password present in JSON response ONCE, bcrypt hash stored (SELECT password FROM user WHERE id). Evidence: curl output plain + DB SELECT hash like $2b$12$.
  - `rule` TR-2.5: tsc api EXIT 0 (no TS errors introduced). Evidence: tsc exit code 0.

## Task 3: admin.ts add Roles/Permissions backend routes (FR-7, FR-8, FR-11, NFR-6, AC-2, AC-7)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - Add Zod schemas: RoleCreateBody (name unique, description, permissions string[]), RoleUpdateBody (description?, permissions?), RoleNameParam (role z.enum ADMIN|BURSARY for list; custom roles allowed by z.string().min(2)).
  - Routes: GET /admin/roles → prisma.role.findMany w/ COUNT of rolePermission (include _count.rolePermissions). GET /admin/roles/:name → prisma.role.findUnique + include rolePermissions (include permission keys). POST /admin/roles → create new role + rolePermission entries. PATCH /admin/roles/:name → upsert rolePermissions (delete absent, add present). Exclude STUDENT role from all (STUDENT implicit locked).
  - GET /admin/permissions → PERMISSION_DEFS map, enriched w/ roles_assigned: rolePermission JOIN groupBy permissionId -> role names. requirePermission('MANAGE_ROLES').
- **Acceptance Criteria Addressed**: AC-2 (2/5 backends), AC-7 (backend validations)
- **Test Requirements**:
  - `rule` TR-3.1: curl GET /admin/roles returns 200 ADMIN+BURSARY roles (STUDENT NOT present), includes permission count field. Evidence: curl json body grep STUDENT = 0.
  - `rule` TR-3.2: POST /admin/roles {name:'TEST_ROLE', description:'X', permissions:['CREATE_STUDENT']} → 201; rolePermissions row count = 1; audit action=CREATE_ROLE present. Evidence: curl + roles/:TEST_ROLE get.
  - `rule` TR-3.3: GET /admin/permissions → returns array of 16 entries (length = PERMISSION_DEFS.length = 16), each entry has roles_assigned[] string array (non-empty for ADMIN all keys). Evidence: curl json len==16 check.
  - `rule` TR-3.4: tsc api EXIT 0. Evidence: exit code 0.

## Task 4: admin.ts add System Settings + Payment Config backend (FR-9, FR-10, FR-11, NFR-6, AC-2, AC-5)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - GET /admin/settings → SystemSettingsService.get() wrapped 200 JSON success. requirePermission('SYSTEM_SETTINGS').
  - PATCH /admin/settings → Zod SystemSettingsPatch schema (strict: allow only SEED_DATA keys — reject id/createdAt/updatedAt via omit). Call SystemSettingsService patch via prisma.systemSettings.update. Validate activePaymentGateway via SystemSettingsService.validateActivePaymentGatewayValue if included. Write audit SETTINGS_UPDATE.
  - GET /admin/payment-config → reads systemSettings activePaymentGateway; returns {activeGateway, supportedGateways:[{key:PAYSTACK,label:'Paystack', status:sandbox},{key:ALATPAY,label:'ALAT Pay by WEMA', status:sandbox}]}. requirePermission('PAYSTACK_CONFIG').
  - PATCH /admin/payment-config → Zod body { activeGateway: z.enum(['PAYSTACK','ALATPAY']) } → validate + prisma patch + audit GATEWAY_TOGGLE.
- **Acceptance Criteria Addressed**: AC-2 (4/5 backends done after Tasks 2+3+4; 5/5 with Task3 audit-logs already works), AC-5
- **Test Requirements**:
  - `rule` TR-4.1: curl GET /admin/settings returns 200 data with 13 keys from SEED_DATA (universityName, paystackLiveEnabled, activePaymentGateway etc). Evidence: grep 13/13 keys present in JSON output.
  - `rule` TR-4.2: PATCH /admin/settings body { universityName: 'Test U' } → 200 updated; GET /admin/settings reflects change; audit action=SETTINGS_UPDATE present. Evidence: curl patch + get + audit-logs.
  - `rule` TR-4.3: PATCH /admin/payment-config {activeGateway:'ALATPAY'} → 200 → GET /admin/payment-config returns activeGateway=ALATPAY. Audit GATEWAY_TOGGLE present. Toggle back PAYSTACK → back to baseline. Evidence: 2 curl toggles + audit log action=GATEWAY_TOGGLE entries ≥2.
  - `rule` TR-4.4: tsc api EXIT 0. Evidence: exit code 0.

## Task 5: Frontend adminApi.ts service file for 5 new modules (FR-17/18 preparation, AC-3)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Tasks 2,3,4 (backend API shape defined before axios calls written)
- **Description**:
  - Create `app/src/services/adminApi.ts` with interfaces + 5 API groups:
    - usersApi (list/create/get/update/deactivate/resetPassword)
    - rolesApi (list/get/create/update)
    - permissionsApi (list)
    - settingsApi (get/patch)
    - paymentConfigApi (get/save)
  - Interface types for each (UserOut, RoleOut, PermissionOut, SystemSettingsOut, PaymentConfigOut) matching backend shapes.
  - Use existing axios `api` singleton (same import as academicApi.ts).
- **Acceptance Criteria Addressed**: AC-3 (frontend wiring prerequisite)
- **Test Requirements**:
  - `rule` TR-5.1: tsc app EXIT 0 (types align between axios generics). Evidence: exit code 0.
  - `rule` TR-5.2: All 18 methods exported (users 6 + roles 4 + perms 1 + settings 2 + payment 2 = 15 methods at least). Evidence: grep `export const XApi = {` count ≥ 5 groups.

## Task 6: Build Users.tsx (FR-12, AC-3, AC-4, AC-8, NFR-1/NFR-2)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 5 (adminApi.ts service)
- **Description**:
  - Create `app/src/pages/admin/Users.tsx` at matching path.
  - Pattern: existing Faculties.tsx / AuditLogs.tsx (PortalShell wrapper, ActivePill, Field, inputCls, ConfirmState, modal state, load useCallback, CanceledError catch, navCounters guard).
  - Table columns: ID, Name, Email, Role chip (ADMIN indigo | BURSARY emerald), Account Status pill, College, Dept, Phone, Created, Actions (Edit Pencil | Reset Password Key | Toggle Status Ban).
  - Create User modal: First Name, Last Name, Email, Role Radio (ADMIN/BURSARY only — no STUDENT option), Password Input (default auto-generate strong if empty).
  - Edit User modal: Same fields except Email field `disabled` HTML attr (immutable per NFR-5).
  - Reset Password action → ConfirmAction then adminApi.resetPassword → Alert success dialog with copyable plaintext password.
  - Register route App.tsx: `/admin/users` element `<AdminUsers />` with roles=['ADMIN'] PrivateRoute wrapper.
- **Acceptance Criteria Addressed**: AC-3 (1/5 pages), AC-4 (frontend UX), AC-8
- **Test Requirements**:
  - `rule` TR-6.1: Navigate /admin/users → heading h1 "Users" present, Role chips rendered, console 0 errors. Evidence: browser snapshot heading node.
  - `rule` TR-6.2: Click +Add User → Role dropdown/radio ONLY has ADMIN + BURSARY options. Evidence: modal options nodes snapshot (STUDENT option not present).
  - `rule` TR-6.3: Click Edit → Email field has `disabled` HTML attribute. Evidence: browser_get_attribute ref=emailInput attr=disabled returns true.
  - `rule` TR-6.4: tsc app EXIT 0, GetDiagnostics [] → zero TS/lint issues. Evidence: tsc exit code 0, GetDiagnostics empty array.

## Task 7: Build Roles.tsx + Permissions.tsx (FR-13/14, AC-3, AC-7, AC-8)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 5
- **Description**:
  - Roles.tsx: Cards layout per role (ADMIN, BURSARY, any custom). Each card: Header role name badge + Description + Chip row of assigned permission short names grouped by category. Actions: Edit Pencil. Create Role modal: Name text input, Description textarea, 4 fieldset groups (Students/Fees/Payments/Admin) each heading + checkboxes labeled with human name, keys as value. Edit modal same with pre-filled checked state. Exclude STUDENT role from list entirely (never show — locked). App.tsx route `/admin/roles`.
  - Permissions.tsx: 4 collapsible sections (accordion groups) by category (Students/Fees/Payments/Admin), each card shows permission: Name, Key mono font, Description, roles_assigned as chips. No mutation (read-only). App.tsx route `/admin/permissions`.
  - navCounters guard + CanceledError catch in load().
- **Acceptance Criteria Addressed**: AC-3 (3/5 pages done), AC-7, AC-8
- **Test Requirements**:
  - `rule` TR-7.1: /admin/roles → cards for ADMIN + BURSARY present; STUDENT never appears in list (grep snapshot nodes STUDENT text appears 0 times if no student data cells; or only as role data chip in Users page not Roles page). Evidence: snapshot nodes text.
  - `rule` TR-7.2: Create Role modal has 4 visual category headings (fieldset or group) "Students", "Fees", "Payments", "Admin". Evidence: snapshot nodes 4 headings present.
  - `rubric` TR-7.3: Permissions page grouping quality. Dimension: 4 sections w/ accordion/cards per category; scale 1–5; anchors:1=flat list ungrouped;3=grouped by headings but no cards;5=accordion+name+key+description+role chips grouped; threshold ≥4. Evidence: snapshot permissions nodes.
  - `rule` TR-7.4: tsc app EXIT 0, GetDiagnostics []. Evidence: gates.

## Task 8: Build SystemSettings.tsx + PaymentConfig.tsx (FR-15/16, AC-3, AC-5, AC-8)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 5
- **Description**:
  - SystemSettings.tsx: 4 grouped cards (University, Payments, Receipts, Session). Each card has label+Field input pairs. Dirty state tracking (any field modified from original → show "Unsaved changes" confirm when navigate away). Save/Cancel sticky bar bottom right; calls settingsApi.patch after save success toast. Session card: read-only callout linking to /admin/academic/sessions (don't duplicate session editor feature). App.tsx route `/admin/settings`.
  - PaymentConfig.tsx: 2 large radio cards (Paystack | ALAT Pay). Each: heading, sub description, status (sandbox), green Active badge when selected, CTA radio button to switch. Save button at bottom → before save, ConfirmAction "Switch active gateway to {X}?". Active badge shows which is currently on when loading. App.tsx route `/admin/payment-config`.
  - navCounters guard + CanceledError catch guard.
- **Acceptance Criteria Addressed**: AC-3 (5/5 pages done, all Administration sidebar routes alive), AC-5, AC-8
- **Test Requirements**:
  - `rule` TR-8.1: /admin/settings → 4 card headings "University", "Payments", "Receipts", "Session" visible. Save click after editing universityName → PATCH success. Reload page shows new value. Evidence: 4 snapshots per card + save PATCH.
  - `rule` TR-8.2: /admin/payment-config → 2 radio cards (Paystack, ALAT Pay). Switch ALAT Pay → Save → Confirm → Reload. Active badge on ALAT Pay. Switch back PAYSTACK. Evidence: browser snapshots 4 states (Paystack active → ALATPAY active → confirm dialog → back to Paystack).
  - `rule` TR-8.3: console_messages for SystemSettings Save + PaymentConfig Switch = 0 errors. Evidence: 4 console outputs.
  - `rule` TR-8.4: tsc app EXIT 0, GetDiagnostics []. Evidence: exit codes.

## Task 9: App.tsx register 5 Administration routes (FR-17/18, AC-3)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Tasks 6,7,8 (pages must exist before routes registered)
- **Description**:
  - Add 5 import lines at App.tsx admin imports block:
    `import AdminUsers from './pages/admin/Users';`
    `import AdminRoles from './pages/admin/Roles';`
    `import AdminPermissions from './pages/admin/Permissions';`
    `import AdminSystemSettings from './pages/admin/SystemSettings';`
    `import AdminPaymentConfig from './pages/admin/PaymentConfig';`
  - Inside Admin PrivateRoute (around L345): add 5 Route components matching sidebar path URLs:
    - path="/admin/users" element={<AdminUsers />}
    - path="/admin/roles" element={<AdminRoles />}
    - path="/admin/permissions" element={<AdminPermissions />}
    - path="/admin/settings" element={<AdminSystemSettings />}
    - path="/admin/payment-config" element={<AdminPaymentConfig />}
  - Existing /admin/audit-logs route stays (already works).
- **Acceptance Criteria Addressed**: AC-3 (route registration — last piece to make sidebar links resolve)
- **Test Requirements**:
  - `rule` TR-9.1: Grep App.tsx import block: 5 new admin page imports present. Evidence: grep count=5 lines matched.
  - `rule` TR-9.2: Grep App.tsx Route path="admin/users" /admin/roles /admin/permissions /admin/settings /admin/payment-config → all 5 routes present with element. Evidence: grep 5 lines matched.
  - `rule` TR-9.3: Vite HMR live: direct nav via browser to each of 5 URLs → no "Page Not Found" graphic; every page renders its heading. Evidence: 5 snapshots heading.

## Task 10: Jest baseline gate + TSC gates re-run (AC-6)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Tasks 2,3,4,6,7,8 (all changes applied before final gates)
- **Description**:
  - Run frozen commands in order: `tsc api` → `tsc app` → Jest 8 suites (health/regression/rbac-matrix/idempotency/email-secrets/academic-import/search-settings-notif/reconciliation).
  - If tsc api fails: fix backend; if tsc app fails: fix frontend.
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `rule` TR-10.1: tsc api EXIT 0. Evidence: stdout tail + exit 0.
  - `rule` TR-10.2: tsc app EXIT 0. Evidence: stdout tail + exit 0.
  - `rule` TR-10.3: Jest ≥ 134 tests passed, 8 suites passed, 0 failures (allow 8 skipped always). Evidence: Jest tail "Tests: 134 passed, 8 skipped, 142 total" line.

## Task 11: Full browser verification for AC-1/2/3/4/5/7/8 (AC-1,AC-3,AC-4,AC-5,AC-7,AC-8; TR 1.3/1.4/1.5, 6.1/6.2/6.3, 7.1/7.2/7.3, 8.1/8.2/8.3, 9.3, AC-4 e2e Users CRUD, AC-5 e2e toggle)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Tasks 1-9 complete
- **Description**:
  - Run full browser end-to-end using Integrated Browser (admin already logged in). Click: 5 Academic pages → 6 Administration links → Users CRUD (create, edit, toggle status, reset password check) → Settings change → Gateway toggle. Per step wait 4s → snapshot + console_messages. Record browser_navigation URL before/afters.
  - Final tally: pass/fail per AC item, all evidence links in structured report, ready for review.md composition.
- **Acceptance Criteria Addressed**: AC-1, AC-3, AC-4, AC-5, AC-7, AC-8
- **Test Requirements**:
  - `rule` TR-11.1: 100% sidebar Admin links resolve to non-404 pages (18/18). Evidence: list of 18 URLs + snapshot heading per page.
  - `rule` TR-11.2: Console errors total across all visited pages = 0 (only React DevTools info allowed). Evidence: concatenated consoleMessages output with no [error]/[warning] prefix.
  - `rubric` TR-11.3: Overall admin portal professional polish. Dimension: coherence, completeness, no broken modals; scale 1-5; anchors:1=multiple broken pages;3=mostly works but 1-2 missing pages or console errors;5=every sidebar link loads, every create/edit/deactivate modal opens cleanly, every save/toggle has confirmation dialog, 0 errors throughout, pagination works; threshold ≥4. Evidence: snapshots + console outputs.
