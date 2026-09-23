# Academic Structure + Administration Hardening — Product Requirements Document

## Overview
- **Summary**: Harden the 5 existing Academic Structure Admin pages (Faculties, Departments, Programmes, Levels, Academic Sessions) via full professional click audit, then build 5 missing Administration modules (Users, Roles, Permissions, System Settings, Payment Configuration) — complete backend REST routes + frontend CRUD pages — so that all 6 sidebar Administration links (Users/Roles/Permissions/System Settings/Payment Config/Audit Logs) load correctly with 0 404s, professional quality.
- **Purpose**: Fix the current Admin → Administration sidebar where 5/6 links are dead 404s, and professionally validate all 5 Academic Structure pages click through cleanly end-to-end with 0 console errors, 0 spurious modals.
- **Target Users**: Admin role only (except Payments config also Bursary-lite: view-only) — matches PortalShell role-gated Administration if-block and requiresPermission filters already in place.

## Goals
- **G1**: Professional click audit and hardening of all 5 Academic Structure pages (Faculties, Departments, Programmes, Levels, Academic Sessions).
- **G2**: Build 5 full backend Admin REST API groups (Users CRUD, Roles CRUD, Permissions list, System Settings read+patch, Payment Config read+save toggle) with Zod schema validation, protect/restrictTo role gates, audit log writes on every mutation.
- **G3**: Build 5 matching frontend Admin pages with list/search/pagination tables, create/edit modals, confirmation dialogs, clean loading+empty states, 0 spurious dialogs.
- **G4**: Register all 5 new routes in App.tsx so sidebar Administration links are no longer dead 404s.
- **G5**: 100% TypeScript zero-warn gates (tsc api EXIT 0, tsc app EXIT 0, GetDiagnostics []).
- **G6**: Jest baseline ≥134 tests still pass (additive only — no schema renames, no route deletes).

## Non-Goals
- NO wallet reintroduction (zero references to wallet/walletLedger anywhere).
- NO refunds UI (Refunds pages remain policy-banner only; never resurrect refund processing UI).
- NO student-side payment flow changes (this spec is Admin-only Admin menu).
- NO Paystack/ALATPAY public key secret rotation or provider code changes (Payment Configuration page toggles active gateway only; never reads/writes raw secrets — use env-vars for keys as frozen baseline).
- NO sidebar structure changes (PortalShell Administration links stay exactly as-is — we just make them resolve to real pages).

## Background & Context
Prior spec `production-hardening-students-list-fix` delivered Students list normalization (18 rows), Modal Laws-of-Hooks fix (eliminated Internal React static flag), Students CanceledError guard (eliminated spurious Failed dialog), 3 deep-link URL verification, Jest 134 gate, tsc 0/0 gates, no-wallet callback UX, seed wallet ref cleanup. Verified Admin sidebar has 7 groups: Dashboard / Students (4) / Bills (5) / Payments (1) / Receipts (2) / Academic Structure (5) / Administration (6).

Current Administration sidebar links (PortalShell L214-L219):
1. `/admin/users` → requiresPermission MANAGE_USERS → **404 (dead link ❌)**
2. `/admin/roles` → requiresPermission MANAGE_ROLES → **404 ❌**
3. `/admin/permissions` → requiresPermission MANAGE_ROLES → **404 ❌**
4. `/admin/settings` → requiresPermission SYSTEM_SETTINGS → **404 ❌**
5. `/admin/payment-config` → requiresPermission PAYSTACK_CONFIG → **404 ❌**
6. `/admin/audit-logs` → requiresPermission AUDIT_LOGS_VIEW_FULL → **works ✅ (AuditLogs.tsx)**

Academic Structure pages already exist and appear structurally professional (Faculties, Departments with faculty FK loaded, Programmes, Levels, Sessions w/ startDate/endDate/isCurrent). Backend academic routes exist in academic.ts w/ Zod ListQuerySchema, protect, restrictTo(ADMIN,BURSARY). Frontend academicApi.ts uses ListResponse<T>{items,T[]} consistent key — already normalized, so no rows bug.

Existing backend pieces ready to reuse:
- SystemSettingsService (services/systemSettings.ts) → get() + update() + SEED_DATA with 13 settings keys + validateActivePaymentGatewayValue(PAYSTACK/ALATPAY).
- permissionSeed.ts PERMISSION_DEFS → 16 permission keys grouped by Students/Fees/Payments/Admin, seedPermissions() + BURSARY exclusion map.
- auth.ts login already looks up permissions per role.
- Prisma schema already has User, Role, Permission, RolePermission, SystemSettings models (confirmed via grep of /admin/audit-logs includes.user working).

## Functional Requirements
### Academic Structure (Audit + Harden, FR-1 … FR-5)
- **FR-1**: Faculty page loads data, search, page size 50, +Faculty create modal opens, edit opens from Pencil, Deactivate opens ConfirmAction, console 0 errors.
- **FR-2**: Department page loads faculty FK dropdown for create/edit (Departments L42 already `facultiesApi` loads w/ pageSize 500 isActive), 0 console errors.
- **FR-3**: Programme, Level, Academic Session pages — each: list loads, create modal, edit from pencil, deactivate/confirm, 0 dialog errors.
- **FR-4**: CanceledError guard: every `catch(err)` in 5 pages uses `if (err?.code === 'ERR_CANCELED' || signal?.aborted) return;` (strict axios cancel + abortSignal guard, mirroring Students.tsx fix). Alert dialog only shown for REAL non-cancel errors.
- **FR-5**: navCounters promise catch guard: every page's `useEffect(() => navCounters().then(setNavCounts).catch(() => setNavCounts({})))` — never let nav counters rejection surface Failed dialog (same pattern as Students fix).

### Administration Backend (FR-6 … FR-10)
- **FR-6 Users CRUD (admin.ts routes, protect + restrictTo ADMIN):**
  - GET /admin/users → paginated (page, pageSize, role filter, q search email/name) → `{items:UserRow[], total, page, pageSize, pageCount}` consistent key `items`. Fields: id, email, firstName, lastName, role, accountStatus, phone, college, department, createdAt. Never return password hash.
  - GET /admin/users/:id → single user w/ role+permissions summary.
  - POST /admin/users → create ADMIN or BURSARY users only (never STUDENT via Admin user page; use Students page for that). Validate: email unique, password 8+ chars auto-generate if not provided, return auto-generated password in response for UI display once. Write CREATE USER audit log.
  - PATCH /admin/users/:id → update name/role/accountStatus; never allow email change (email immutable). Write UPDATE USER audit log.
  - POST /admin/users/:id/deactivate → toggles accountStatus between ACTIVE / SUSPENDED. Write ACCOUNT_STATUS_CHANGE audit log.
  - POST /admin/users/:id/reset-password → auto-generate new strong password, hash+save, return password in response (UI only); write PASSWORD_RESET audit log.
- **FR-7 Roles CRUD:**
  - GET /admin/roles → list ADMIN/BURSARY (STUDENT hidden from Admin UI — students auto-created w/ fixed STUDENT role, never in role editor). Include permissions count per role.
  - GET /admin/roles/:name → single role w/ assigned permission keys array.
  - POST /admin/roles → allow create NEW custom roles (name unique, description, permissions array). Write CREATE ROLE audit log.
  - PATCH /admin/roles/:name → patch description + permission keys assignment (use permissionSeed key validations). Write UPDATE ROLE audit log.
- **FR-8 Permissions list (read-only):**
  - GET /admin/permissions → return PERMISSION_DEFS entries enriched with roles_assigned array (per permission key → list of role names that have it, via rolePermission JOIN). Never allow mutation; permissions are seeded fixed.
- **FR-9 System Settings:**
  - GET /admin/settings → returns SystemSettingsService.get() full row (all 13 fields + updatedAt).
  - PATCH /admin/settings → accepts partial SystemSettingsPatch, passes SystemSettingsService.patch(req.body), validates activePaymentGateway enum, disallows writing id/createdAt/updatedAt directly. Write SETTINGS_UPDATE audit log w/ changed keys.
- **FR-10 Payment Configuration toggle:**
  - GET /admin/payment-config → returns { activeGateway: string (PAYSTACK|ALATPAY), gatewayEnvLabel (sandbox/live), supportedGateways: [ { key, label, status } ] } (reads directly from SystemSettings activePaymentGateway).
  - PATCH /admin/payment-config → validates val with validateActivePaymentGatewayValue, passes patch to SystemSettingsService.patch({activePaymentGateway}). Write GATEWAY_TOGGLE audit log.
- **FR-11**: All mutations (POST/PATCH/POST deactivate/reset) in admin.ts new route groups write audit logs via prisma.auditLog.create (same pattern as /admin/audit-logs existing `prisma.auditLog.findMany`).

### Administration Frontend (FR-12 … FR-16)
- **FR-12 Users.tsx**: 12-column searchable table (id, Name, Email, Role chip, Account Status pill, College, Dept, Phone, Created, Actions: Edit / Reset Password / Toggle Status). Create User modal w/ role dropdown (ADMIN/BURSARY only), password auto-filled strong default if left blank; Edit modal immutable email; Reset Password returns new password in Confirmation dialog; Toggle Status uses ConfirmAction.
- **FR-13 Roles.tsx**: Cards per role (role name, description, chip row of all assigned permission short names, badge count). Create Role modal (name, description, 16 permission checkboxes grouped by Students/Fees/Payments/Admin). Edit Role modal same fields.
- **FR-14 Permissions.tsx**: Grouped accordion by category (Students, Fees, Payments, Admin). Each card: key, name, description, roles assigned badge chips. No mutation (read only — informative page).
- **FR-15 SystemSettings.tsx**: 4 grouped cards: University (name, logoUrl, address, phone, email, website), Payments (liveEnabled checkbox, largePaymentThreshold number, importErrorThreshold number), Receipts (footerText multiline, receiptPrefix, paymentRefPrefix), Session (links out to Academic Sessions — not duplicated here). Save/Cancel button bar. PATCH submit on save; confirm dirty-state on route leave if unsaved.
- **FR-16 PaymentConfig.tsx**: 2 radio gateway cards (Paystack, ALAT Pay) with Active badge on current, description per gateway (from frozen doc URLs), Save button → ConfirmAction "Switch active gateway to {X}?" confirmation. Never render raw keys (secrets stay in env).

### App Routing
- **FR-17**: App.tsx adds 5 new routes inside Admin PrivateRoute (roles=[ADMIN]):
  - /admin/users → AdminUsers
  - /admin/roles → AdminRoles
  - /admin/permissions → AdminPermissions
  - /admin/settings → AdminSystemSettings
  - /admin/payment-config → AdminPaymentConfig
- **FR-18**: App imports (top of App.tsx) add 5 new page component imports.

## Non-Functional Requirements
- **NFR-1 (Strict TS)**: tsc --noEmit EXIT 0 for both api AND app. 0 TS6133 (no unused vars — use _ prefix for unused params). GetDiagnostics array = [].
- **NFR-2 (Zero spurious dialogs)**: Every axios catch → `if (signal.aborted || err.code==='ERR_CANCELED') return;` before setAlert/setError. navCounters always `.catch(() => setNavCounts({}))`; sidebar badge counts are decorative — never fail loud.
- **NFR-3 (Audit log mandatory for mutations)**: All 11 FR mutation actions write prisma.auditLog rows w/ userId, role, action (CREATE_USER, UPDATE_ROLE etc), entityType (USER|ROLE|SYSTEM_SETTINGS|PAYMENT_CONFIG), entityId (String cast), details JSON {changedKeys: []}, ip, userAgent (same pattern as academic.ts FacultyService.audit).
- **NFR-4 (Paginated shape consistency)**: ALL paginated list endpoints return `{ items: [], total, page, pageSize, pageCount }` (never `students`, never `rows`). Frontend reads only `data.items` for lists.
- **NFR-5 (Security)**: User list NEVER returns password/hashedPassword column. select exclude password always. PATCH /users never allows email write. Passwords for create/reset: bcrypt 12 rounds (use existing auth.ts hashing utility or import bcrypt directly).
- **NFR-6 (Role gate)**: All 10 new backend routes are mounted in admin.ts router which already `router.use(restrictTo('ADMIN'))` at L24. Frontend routes use PrivateRoute with roles={['ADMIN']} (matching existing pattern for /admin/audit-logs). requirePermission middleware also added per route (requiresPermission already exists in auth middleware — apply where matches PortalShell sidebar requiresPermission keys: MANAGE_USERS, MANAGE_ROLES, SYSTEM_SETTINGS, PAYSTACK_CONFIG, AUDIT_LOGS_VIEW_FULL).
- **NFR-7 (Jest baseline preserved)**: Jest 8 suites baseline ≥134 tests must still pass. No test modifications. No schema destructive changes.
- **NFR-8 (A11y)**: New modals reuse existing shared Modal component (post-Laws-of-Hooks fixed version in app/src/components/Modal.tsx). Confirmations use existing ConfirmAction component. Focus trap on close button in Modal already implemented via requestAnimationFrame in fixed version.

## Constraints
- **Technical**:
  1. Pagination response key = `items` ONLY (matches existing academicApi L77 ListResponse items: T[]). Never rename backend keys (too risky for Jest). Normalize on frontend if needed.
  2. Existing Modal.tsx must be used for every new dialog — never write a new custom modal component.
  3. ConfirmAction component must be used for destructive/destructive-toggle actions (deactivate, toggle status, save gateway switch, reset password).
  4. Zod schemas mandatory for all new route query/body/param inputs.
  5. Axios frontend api service file pattern — create `/app/src/services/adminApi.ts` grouping Users, Roles, Permissions, Settings, PaymentConfig methods.
  6. Frozen: secrets remain in env vars (DATABASE_URL, JWT, PAYSTACK_*, NEW 6 ALATPAY_*). PaymentConfig page only toggles the ACTIVE GATEWAY enum (never touches keys).
  7. Prisma schema additive-only. Never push --accept-data-loss again. No wallet tables re-added.
- **Business**:
  1. Refunds UI = banner only (policy). No refund processing UX ever in these pages.
  2. Single-active-gateway invariant (only one of Paystack / ALAT Pay is active at a time — enforced by Payment Configuration page radio toggle + backend validateActivePaymentGatewayValue).
  3. Admin users page never creates STUDENT records — only ADMIN/BURSARY. Student records belong to Students page with full academic profile (matric, level, college etc).
  4. Student Role (STUDENT) is locked/hidden in Roles editor page since it's assigned automatically during student creation and doesn't need admin-editable permissions (simple role).
  5. All price amounts in NGN (₦) with 2dp locale formatting using existing Intl.NumberFormat 'en-NG' style.
- **Dependencies**:
  1. Prisma models: User, Role, Permission, RolePermission, AuditLog, SystemSettings (confirmed existing via search.test.ts, permissionSeed.ts, audit-logs route).
  2. bcrypt (api/package.json existing), Zod (api existing), lucide-react app existing for icons.
  3. SystemSettingsService for get/patch + validateActivePaymentGatewayValue — reuse, no rewrite.
  4. PERMISSION_DEFS from permissionSeed.ts for frontend + backend validations — reuse single source of truth.

## Assumptions
- All 5 Academic Structure frontend pages use consistent `r.items` key (read academicApi.ts L77 confirms) — no normalization needed (already uniform across 5 pages). CanceledError/navCounters catch guards are simple one-line additions per page.
- Admin user admin@university.edu.ng has role=ADMIN and has permission keys assigned (permissionSeed's seedPermissions() for ADMIN role assigns all 16 keys). PortalShell sidebar will therefore display all 6 Administration links for this user.
- Vite API server is running on :3000, Vite frontend on [::1]:5173 (verified working state, reuses prior session servers).

## Acceptance Criteria

### AC-1: Academic Structure 5/5 pages click cleanly
- **Type**: `rubric`
- **Dimension**: Click-through completeness across 5 Academic pages (Faculties, Departments, Programmes, Levels, Sessions).
- **Scale**: 1–5
- **Anchors**: 1 = 0 pages load, multiple 404s; 3 = 3 pages load/navigate but some edit modals fail or console errors exist; 5 = ALL 5 pages: nav works, list renders w/ correct data shape, +Create opens modal, Edit Pencil opens, Deactivate Ban opens ConfirmAction with resourceLabel, empty states render clean if 0 rows, CanceledError catch guards present, console 0 errors, 0 spurious "Failed to load" dialogs, bidirectional no URL breakage.
- **Pass Threshold**: ≥ 4 (≥80% clean, all 5 pages at least navigable & list renders; ≤1 minor modal issue only)
- **Evidence**: Integrated Browser snapshots + console_messages for each of 5 pages; code grep of catch blocks for err.code==='ERR_CANCELED' + navCounters.catch guard.

### AC-2: Admin Backend Routes 5/6 new groups exist and return correct shapes
- **Type**: `rule`
- **Given**: API running on localhost:3000, admin JWT Bearer token obtained via /auth/login admin@university.edu.ng/admin123.
- **When**: curl -s each new endpoint URL (GET /admin/users?page=1&pageSize=25; GET /admin/roles; GET /admin/permissions; GET /admin/settings; GET /admin/payment-config).
- **Then**: Every curl returns HTTP 200 with JSON `{status:"success", data:{...}}`, users list returns `data.items` array shape, roles returns array, permissions returns PERMISSION_DEFS enriched w/ roles_assigned, settings returns all 13 keys from SEED_DATA, payment-config returns activeGateway=PAYSTACK|ALATPAY.
- **Pass Condition**: 5/5 curls return 200+correct keys (Audit Logs already works so 6/6 Administration backends are reachable total).
- **Evidence**: curl command outputs w/ HTTP codes + python json shape check.

### AC-3: Admin Frontend Routes 5/6 new pages load w/o 404
- **Type**: `rule`
- **Given**: Admin authenticated (role ADMIN, 6 sidebar Admin links visible).
- **When**: Click each of 5 new Administration sidebar links (Users, Roles, Permissions, System Settings, Payment Config) + direct navigate URLs /admin/users, /admin/roles, /admin/permissions, /admin/settings, /admin/payment-config.
- **Then**: Each page renders matching heading (e.g. /admin/users → h1 "Users"), sidebar current:page highlighting applies, no 404 redirect, console 0 React errors, 0 Failed dialog, list/table has at least column header row rendered even if 0 data.
- **Pass Condition**: 5/5 links resolve (Audit Logs already works → 6/6 Administration sidebar 100% non-dead).
- **Evidence**: Browser snapshot for each URL showing heading+table/skeleton.

### AC-4: Users CRUD works end-to-end
- **Type**: `rule`
- **Given**: Admin authenticated on /admin/users page.
- **When**: (a) Click +Add User → modal w/ Role dropdown (ADMIN/BURSARY only, no STUDENT option); (b) Fill name/email, submit; (c) new row appears with role chip, status=Active pill; (d) click Edit → modal opens with Email field DISABLED (immutable); (e) click Toggle Status → ConfirmAction opens, then Account Status pill flips Active↔Suspended; (f) click Reset Password → Confirmation dialog shows generated password once.
- **Then**: (a) Role dropdown excludes STUDENT; (b) submit succeeds, CREATE USER audit log row exists (verify via /admin/audit-logs action=CREATE_USER); (c) row renders correctly; (d) email is HTML readonly/disabled attribute; (e) status flips, ACCOUNT_STATUS_CHANGE audit log present; (f) PASSWORD_RESET audit log present.
- **Pass Condition**: All steps (a–f) succeed, list hashes or password NEVER appear in any API response (verify /admin/users JSON data has no password field).
- **Evidence**: Browser snapshots for each step + curl audit-logs filter action=CREATE_USER + curl GET /admin/users grep password => 0 matches.

### AC-5: System Settings + Payment Config saves write audit logs & toggle active gateway
- **Type**: `rule`
- **Given**: Admin on /admin/payment-config page, active gateway = PAYSTACK (baseline).
- **When**: Click ALAT Pay card radio → Save → confirm dialog OK → reload /admin/payment-config.
- **Then**: Active gateway badge now shows ALATPAY; /admin/audit-logs action=GATEWAY_TOGGLE present; /admin/settings updatedAt > before save timestamp; System Settings dirty-state discard warning works (change field + navigate back → confirm dialog "Unsaved changes" OK/cancel).
- **Pass Condition**: Gateway toggles both directions (ALATPAY↔PAYSTACK), audit log GATEWAY_TOGGLE exists, settings update audit row SETTINGS_UPDATE present.
- **Evidence**: Browser snapshots + curl audit-logs action filter checks.

### AC-6: Jest + TSC gates survive
- **Type**: `rule`
- **Given**: All code changes applied.
- **When**: Run `tsc api EXIT 0`, `tsc app EXIT 0`, `Jest 8 suites 134+ tests pass` (frozen commands).
- **Then**: tsc api EXIT 0; tsc app EXIT 0; Jest tests passed >= 134, 8 suites pass, 0 failures.
- **Pass Condition**: All 3 gates pass.
- **Evidence**: Frozen command tail outputs, exit codes.

### AC-7: Roles CRUD + Permissions list professional UX
- **Type**: `rubric`
- **Dimension**: Roles + Permissions page completeness + professional grouping.
- **Scale**: 1–5
- **Anchors**: 1 = Empty ungrouped list; 3 = Basic CRUD works but permissions are ungrouped flat 16-checkboxes list with no labels/categories; 5 = Permissions page: 4 grouped accordion sections (Students, Fees, Payments, Admin) with Name, Key, Description, Assigned Roles chips per card. Roles page: Each role card shows assigned permissions as tag chips grouped by category. Create Role modal: 4 permission category fieldset groups with sub-headings + checkbox label = human name (not key), checkbox value = PERMISSION_DEFS.key. Edit Role pre-checks correct existing perms. Role creation writes audit log.
- **Pass Threshold**: ≥ 4 (Roles CRUD works, permissions are at least grouped by section headings visually; permissive of minor styling gaps).
- **Evidence**: Browser snapshots of Roles page + Create Role modal open, Permissions page grouped sections.

### AC-8: Zero console errors across all 10 new/hardened pages
- **Type**: `rule`
- **Given**: All changes applied.
- **When**: Visit each of 10 pages (5 Academic + 5 Administration) and each of 10 modals (5 create + 5 edit) with browser_console_messages check.
- **Then**: Every console_messages result contains ONLY the React DevTools info line. 0 [error], 0 [warning] severity. No "Failed to load" dialogs mounted (no 2 modals overlap ever).
- **Pass Condition**: All 10 pages + 10 modals → 0 errors/warnings (only info line allowed).
- **Evidence**: per-page console_messages outputs (at least 10 entries concatenated with timestamps).

## Open Questions
- [ ] None (all scope bounded). User approved Spec Mode in prior session for similar Admin portal hardening; this spec extends the same professionalization rigor from Students → Academic Structure + Administration.
