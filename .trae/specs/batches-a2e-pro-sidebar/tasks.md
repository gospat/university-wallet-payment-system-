# University Payment Platform — Capstone Implementation Plan

**Spec Ref**: `spec.md` — Batches A–E + Professional Sidebar
**Goal**: Close remaining §45–§101 spec parity (batches A–E) + deliver the professional left sidebar nav (batch F). Zero regressions.
**Baseline health**: 98/98 Jest PASS; api tsc 0; app tsc 0; prisma validate 0; builds green.

---

## 1. Dependencies & Priority Order

Dependency DAG (enforce execution order below):

```
F (PortalShell + Sidebar) is UI-only — can be interleaved anytime after A2.
C (Master tables) must be before C4 (import validation) & C5 pages.
D (Reconciliation) requires A7 (idempotency) + no prereqs on B/C.
B (Emails) requires A1-A6 commit patterns but is independent of C/D.
E (Search/Permissions/Confirmations) permission model feeds F (sidebar filtering).
    └─ E4 permission matrix seeds → F3/F4 role-scoped nav.

Recommended sequence (this plan):
  ┌─ F0 Base shell ─┬─ A Payment UX polish ─┬─ C Academic Master Tables
  │                │                        ├─ B Email system
  │                │                        ├─ E Search + Permissions + Confirms
  └────────────────┴────────────────────────┴─ D Reconciliation
                                                       │
                                              F1 Final retrofit: all pages → Shell
```

Each batch has a strict `Rule`/`Rubric` TR list below that must close before moving on.

---

## 2. Tasks

Legend: `Priority` P0 (blocking) / P1 (high) / P2 (medium). Every AC from `spec.md` is mapped via the column "Covers ACs".

| # | Task | Summary | Depends on | Priority | Covers ACs | Test Requirements (TR) |
|---|------|---------|------------|----------|------------|------------------------|
| **Batch F.0 – PortalShell Skeleton** |||||||
| F0.1 | Create `app/src/components/PortalShell.tsx` + type definitions | Create shell: `<PortalShell role={'STUDENT' \| 'ADMIN' \| 'BURSARY'} activePath=... navConfig=... userText=... brand=... onLogout=...>` | — | P0 | AC-F1 (skeleton) | tsc --noEmit exit 0 for app |
| F0.2 | Sidebar visual + responsive implementation in PortalShell | 240–280px left sidebar; `<768px` hamburger drawer; 8px grid; no shadows; 16×16 icons; active left accent bar role-tinted; role-tinted bg; badges for counters; aria-current="page"; visible focus ring | F0.1 | P0 | AC-F1 (rubric score ≥4), AC-F3, AC-F4 | React render test (snapshot) + AC-F4 aria-current rule test + rubric score self-attest |
| **Batch A – Payment UX Polish** |||||||
| A1.1 | Refactor Fee cards to §58 layout (badge/session/amount/paid/outstanding/PAY NOW) | `pages/student/Fees.tsx` SchedulePage `FeeCard` component | F0.2 | P1 | AC-A1 (basis) | tsc app 0; snapshot test matches sections |
| A2.1 | Create `student/PaymentConfirmation.tsx` (§59) step between invoice → Paystack | Extract existing `proceed()` payload into a confirmation step. Backend helper endpoint: `GET /student/payments/confirm-payload?invoiceId=...` returns `serverComputedAmount + feeName + session + studentName + matric` | A1.1 | P0 | AC-A1 | Jest supertest confirms `serverComputedAmount = invoice.amountDue − invoice.amountPaid`; React render test asserts 5 fields displayed |
| A3.1 | Create `student/PaymentResult.tsx` state machine component (§60/§61/§62) | 4 states: idle/success/failure/pending. i18n strings added to `dashboard.student.paymentResult.*` with exact copy "No successful payment has been recorded." and "Do not make another payment immediately." | A2.1 | P0 | AC-A2, AC-A3, AC-A5 basis | React test: failure screen contains exact "No successful payment has been recorded." string; success screen has Download Receipt button wired; pending screen has Check Status button wired |
| A4.1 | §87 Transaction Details drawer component + wiring on invoices/payments lists | `TxnDetailsDrawer` displays: Receipt, Reference, PaystackRef, Date, Time, Channel, Status. Open via row click. | A3.1 | P1 | FR-A6 | Component test: fields rendered from props correctly |
| A5.1 | §73 idempotency safe "Try Again" in backend `initiatePayment` | Pre-check: if PENDING row on same invoice aged < 5 min → 425 "Payment already in progress."; else cancel old row with note `client-reinit` and issue new reference | A3.1 | P0 | FR-A7 | Jest regression unit test: two rapid POST /payments/init on same invoice returns 425 on the 2nd attempt |
| **Batch B – Email Notifications** |||||||
| B1.1 | Install `nodemailer` (api only); create `api/src/services/email.ts` with transport factory | Transport strategy: if SMTP env vars fully set → real SMTP; else memory capture mock (returns success). Add i18n `email.*` strings (subjects/template copy) | — | P1 | FR-B1 (basis) | package.json nodemailer present; tsc api 0; unit test renders template without throwing |
| B2.1 | Email renderer + 7 templates (§48) | Template renderer producing HTML/plaintext output: PaymentSuccessful, PaymentInitiated, PaymentFailed, PaymentReversed, RefundStatusChanged, PasswordReset, StudentAccountCreated, PaymentReminder (8 total; FR-B3 extended set). Buttons styled plain (no shadow/gradient per preferences). | B1.1 | P0 | AC-B1 basis | Jest renders each of 8 templates + string-matches subject/payload; unit test asserts NO secret leakage (AC-B2): full scan for `"sk_"`, `"JWT_SECRET"`, `bcrypt hashes` |
| B2.2 | Secret-leakage test suite (§70) | Explicit jest suite: "templates must not contain secrets" — regex against every rendered template output for `sk_`, `pk_`, `JWT_`, `bcrypt hashes`, `SMTP_PASS`. | B2.1 | P0 | AC-B2 | 8/8 template renders PASS regex audit |
| B3.1 | BullMQ `dispatchEmail` job + queue wiring | Queue name `emails`. Job idempotency key = `\${emailType}:\${reference}:\${recipientId}`. Dispatch uses existing ioredis LazyProxy; NODE_ENV=test short-circuit preserved. | B2.2 | P0 | NFR-6 | Jest test: same idempotency key × 2 dispatches produces 1 sent email mock capture |
| B4.1 | Wire Payment Successful dispatch post-verify commit | In `PaymentService.verifyPayment` after SUCCESS + $transaction commits (post-commit hook, NOT inside transaction), queue `PaymentSuccessful` email with fee name, amount, reference, receipt download URL | B3.1 | P0 | AC-B1 | Supertest: simulate verify → mock email queue captures 1 job with correct template |
| B5.1 | §47 Admin notifications data channel + UI rows | Create `AdminNotification` prisma model + endpoint list (BURSARY/ADMIN scope). Event types: LARGE_PAYMENT / FAILED_PAYMENT / ANOMALY_UNDERPAID / ANOMALY_OVERPAID / WEBHOOK_FAIL_3 / IMPORT_ERRORS_10 / REFUND_REQUESTED. Dispatch rows on trigger. | B3.1 | P1 | FR-B4 | Jest: create LARGE_PAYMENT threshold hit → row created |
| **Batch C – Academic Master Tables + Validation** |||||||
| C1.1 | Prisma schema: 5 new models + unique FK hierarchy | `Faculty` → `Department` (unique within facultyId) → `Programme` (unique within departmentId) → `Level` (unique within programmeId). `AcademicSession` standalone with name+isActive. Backwards-safe FK columns on User/Fee: `facultyId? / departmentId? / programmeId? / levelId? / academicSessionId?`. Existing free-text college/department etc kept. | — | P0 | AC-C1 | `prisma validate` exit 0; schema.prisma grep confirms 5 models + unique indices + FK chain |
| C1.2 | Prisma migrate dev + generate + snapshot seed | Run migration to create tables locally; seed a minimal sample set (Faculty=Science → Dept=Computer Science → Programme=BSc CS → Level=100,200,300,400; Session=2026/2027 active). | C1.1 | P0 | AC-C1 | Migration apply green; prisma generate OK |
| C2.1 | Admin CRUD endpoints + service for 5 tables | Service layer `services/academic.ts` with CRUD + soft-deactivate (isActive flag). Routes `/admin/faculties`, `/admin/departments`, `/admin/programmes`, `/admin/levels`, `/admin/sessions`. BURSARY GET-only. | C1.2 | P1 | FR-C5 | Jest supertest CRUD + 403 on Bursary POST |
| C2.2 | Admin portal Academic Structure sidebar section pages (5) | 5 simple pages: list table + edit modal + create modal (use existing Modal primitive + ConfirmAction per Batch E). Wire to PortalShell §56 nav "Academic Structure" group. | C2.1 + E3.1, F | P1 | FR-C5 | tsc app 0; renders; create button POST succeeds |
| C3.1 | §92 CSV cross-structure validation on STUDENT bulk import | Modify `studentImport.ts`: when a master row exists for a named Faculty/Dept/Programme/Level/Session, validate inclusion; mismatch → `ERROR` row with structured code/message. If no master row exists (legacy), allow free-text through (no false breaks). | C1.2 | P0 | AC-C2 | Jest: fixture CSV row "Science + Mass Comm" → row has ERROR with "does not belong" wording; fixture "Science + Computer Science" → row OK |
| C3.2 | §92 CSV cross-structure validation on FEE bulk upload | Parallel: fee bulk upload validates structure when master rows present. | C1.2 | P1 | FR-C6 | Jest: same logic, fee fixture |
| **Batch D – Reconciliation** |||||||
| D1.1 | Create `services/reconciliation.ts` compare engine + classifications | Full-outer-join internal Transaction vs Paystack list endpoint (with date-range pagination, CSV upload fallback). Classification buckets as spec. | A5.1, B4.1 (indep, but done after them) | P0 | AC-D1 | 10-payment fixture Jest test asserts every bucket count |
| D2.1 | Reconciliation endpoint: `GET /bursary/reconciliation/summary` + `GET /bursary/reconciliation/items?page=&classification=&dateFrom=&dateTo=` (CSV/JSON reports via `?format=csv`) | KPI summary payload matches §64: systemRecords/paystackRecords/matched/amountMismatch/missingInternal/missingPaystack counts. Items filterable by classification + dates. | D1.1 | P0 | AC-D1 (endpoint) | Jest supertest returns correct KPI counts |
| D2.2 | Reconciliation dashboard UI: 6 KPI cards grid + filterable issues table + actions | `/bursary/reconciliation` page renders KPI grid (§64 exact labels + colored delta pills); issues table with classification pills + row actions: Mark Reconciled / Create Internal / Retry / View diff drawer | D2.1 + F | P1 | AC-D2 | Rubric self-score on labels+pills >= 4; screenshot + DOM snapshot |
| D3.1 | Manual action endpoints audited: mark-reconciled / create-internal | POST `/bursary/reconciliation/items/:id/mark-reconciled` + POST `/bursary/reconciliation/items/:id/create-internal` both write `audit_logs` (entityType RECONCILIATION, oldValue/newValue JSON). | D2.1 | P0 | FR-D5 | Jest: POST mark-reconciled → SELECT audit_logs WHERE entityType='RECONCILIATION' row count = 1 |
| **Batch E – Search / Permissions / Confirmations** |||||||
| E1.1 | `GET /admin/search?q=` composite endpoint | q min 2 chars; search matric/name/email/phone/paymentReference/receiptNumber. For student matches include: id/name/matric/email/totalFees/totalPaid/outstanding + 5 deep link route strings. | — | P0 | AC-E1 | Jest supertest: "2024/CSC/001" search → response contains student + deep links + correct outstanding |
| E1.2 | Global search UI in PortalShell top bar (prominent search input) | Debounced 300ms; results dropdown with type icons; 5 action links per student row; keyboard navigation (Esc closes, ↑/↓ navigate). Wire into PortalShell via optional prop `showGlobalSearch=true` (Admin/Bursary only). | E1.1 + F0.2 | P1 | AC-E1 (UI) | React component test: input "2024/CSC/001" → dropdown contains John Doe row with link buttons |
| E2.1 | `permissions` + `role_permissions` prisma models + seed defaults §65 matrix | Role-permission many-to-many. PERMISSION_DEFS declaration: `VIEW_STUDENTS / CREATE_STUDENT / BULK_UPLOAD_STUDENTS / CREATE_FEE / EDIT_FEE / VIEW_PAYMENTS / VERIFY_PAYMENT / GENERATE_RECEIPT / PROCESS_REFUND / MANAGE_USERS / MANAGE_ROLES / SYSTEM_SETTINGS / PAYSTACK_CONFIG / AUDIT_LOGS_VIEW_FULL / AUDIT_LOGS_VIEW_LIMITED` (15 rows). Seed role grants: ADMIN = ALL 15, BURSARY = everything except MANAGE_USERS, MANAGE_ROLES, PAYSTACK_CONFIG, SYSTEM_SETTINGS, AUDIT_LOGS_VIEW_FULL (replaces with AUDIT_LOGS_VIEW_LIMITED), STUDENT = none (empty). | — | P0 | FR-E4 (basis) | prisma validate 0; seed run role_permissions row counts match expected matrix |
| E2.2 | Auth login flow resolves permission claims into JWT claims + cache | At login, resolve `role_permissions` per role; add `permissions: string[]` claim into JWT. Add middleware `requirePermission('X')` (composable, fail closed returns 403) that checks claim. Existing `requireRole(X)` is preserved. | E2.1 | P0 | FR-E4, AC-E3 | Jest rbac-matrix test extended: Bursary JWT on MANAGE_USERS protected route returns 403 |
| E2.3 | Audit Logs scope enforcement via permission claim | `/admin/audit-logs` export endpoint: if `AUDIT_LOGS_VIEW_LIMITED` only → strip `userId`, `oldValue`/`newValue` PII keys, `ipAddress`, any hashes. If `AUDIT_LOGS_VIEW_FULL` → full export. | E2.2 | P1 | §65 Bursary limited Audit Logs | Jest: Bursary export has PII stripped |
| E3.1 | `ConfirmAction` wrapper component around existing Modal | Props: `title / description / resourceLabel / amount? / reference? / reasonRequired? / onConfirm`. If `reasonRequired=true` → free-text input; disable confirm until non-empty. Use everywhere destructive: student archive/fee delete/process refund/void receipt. | — | P0 | AC-E2, FR-E3 | Jest: refund confirm with empty reason → submit not called; with reason → called once |
| E3.2 | Retrofit destructive UI actions with ConfirmAction | Refunds (Process → yes), Student (Archive → yes), Fees (delete/clear in-use category → yes), Receipts (Void → yes). | E3.1 | P1 | FR-E3 | Code audit: every destructive button has onClick → open ConfirmAction |
| E4.1 | System Settings page (Admin, permission SYSTEM_SETTINGS) | Sections per §90: University Info, Payment Settings (keys masked), Receipt Settings, Academic Sessions. Persisted in `SystemSettings` singleton Prisma table (1 row). New `api/prisma/schema.prisma` model `SystemSettings`. | E2.2 | P2 | FR-E5 | Save + re-read returns same values |
| **Batch F.1 – Final PortalShell Retrofit (closes ACs F1/F2)** |||||||
| F1.1 | Retrofit Admin pages to PortalShell: Dashboard, Students, Fees, Refunds, AuditLogs, Reconciliation, Reports (placeholder), Academic Structure, System Settings | Remove inline `PortalNavbar`; wrap with `<PortalShell role="ADMIN">`. Build §56 nav groups exactly. Use permission claims to render-or-remove (never `display:none`). | F0.2, E2.2, all batch A-E pages exist | P0 | AC-F1, AC-F2 (Admin) | React render test: role=ADMIN renders full §56 nav structure; Bursary test: Administration group node never created |
| F1.2 | Retrofit Bursary pages: Dashboard, Students, Fees, Refunds, Receipts placeholder, Reports placeholder, Academic read-only, Reconciliation. | Bursary variant: hide Administration group entirely; hide buttons that require higher permissions even on read-only pages. | F0.2, E2.2 | P0 | AC-F1, AC-F2 (Bursary) | Same render tests, confirm Administration node absent via querySelector returns null |
| F1.3 | Retrofit Student pages: Dashboard, My Fees, Make Payment, Payment History (invoices), Receipts, Profile, Transfer, Withdraw, Checkout, Callback, Support placeholder | §55 8 items exactly. | F0.2 | P0 | AC-F1 (Student), AC-F4 | React render test: 8 items present; aria-current="page" on Dashboard when activePath="/student/dashboard" |
| F1.4 | Sidebar badge counter wiring | Outstanding fees count on "Make Payment" (Student); Pending refunds count on Refunds (Admin/Bursary); Failed webhooks count on Reconciliation. Lightweight aggregate endpoint `/api/v1/dashboard/nav-counters` role-scoped. | F1.1–F1.3 | P1 | FR-F5 (badge requirement) | Supertest: counters endpoint returns correct numbers per role |
| **Batch G – Global Test Execution & Evidence Capture** |||||||
| G1.1 | Existing 98 tests PASS + new tests count total | Run full Jest suite with health + regression + rbac-matrix + all new batches suites. | All tasks above done | P0 | AC-OV1 | All commands from AC-OV1 list exit 0; tests count >= 98 PASS |
| G1.2 | IDE diagnostics programmatic check | `GetDiagnostics` across all edited directories; plus manual terminal tsc both projects | G1.1 | P0 | NFR-1 | GetDiagnostics [] + tsc 0 both |
| G1.3 | Production builds both projects | `api` npm run build + `app` npm run build (1832+ modules as baseline — expect more) | G1.2 | P0 | AC-OV1 | Exit 0 both |
| G1.4 | Screenshot + snapshots for rubric ACs | Capture screenshots: 3 dashboards Student/Admin/Bursary at desktop + 360px + 4K. DOM snapshots for rubric items. | G1.3 | P0 | AC-F1, AC-D2, AC-F3 | PNG files in evidence folder |

---

## 3. Risks & Mitigations

| Risk | Probability | Severity | Mitigation |
|------|-------------|----------|------------|
| TSServer IDE stale diagnostics after massive Prisma model additions (Batch C/E models) | High | Low | Documented per session: user should run "TypeScript: Restart TS Server" if IDE shows false errors. Authoritative diagnostics = terminal `tsc --noEmit`. Follow §6 frozen procedure. |
| `nodemailer` SMTP timeouts break verifyPayment request path on live SMTP misconfig | Medium | High | VerifyPayment must NEVER await the email dispatch — ALWAYS push to BullMQ `dispatchEmail` queue (B3.1). Post-commit, fire-and-forget queue enqueue only. If queue dead, fallback in-memory capture with warning log. |
| Paystack rate limit on reconciliation live list endpoint (§63 compare) | Medium | Medium | Exponential backoff + CSV upload fallback for large ranges. Date range UI default = last 7 days, max 90 days without export-async. |
| BullMQ hang on Jest (existing workaround NODE_ENV=test short-circuit) | Medium | High | New `dispatchEmail` queue respects the same `NODE_ENV === 'test'` early return. |
| CSS bloat from sidebar additions violates NFR-7 (minimal CSS / no visual fluff) | Low | Medium | Sidebar visual spec FR-F5 explicitly forbids shadows/gradients/transitions; enforce via code review. All styling via Tailwind utility; zero `@apply` rules; zero custom keyframes. |
| Free-text Faculty/Department/etc columns break on FK migration | Low | Medium | Backwards-safe: FK nullable, existing values preserved, validation only activates when master rows match — no breaking changes to legacy datasets. |

---

## 4. Dependencies Required

- **Runtime additions (api only)**:
  - `nodemailer@^6` + dev `@types/nodemailer@^6`
- **Runtime additions (none for app)**:
  - All sidebar uses existing `lucide-react` icons, no new packages. All styling with Tailwind utilities already installed.
- **Models new in Prisma**:
  1. Academic 5: `Faculty`, `Department`, `Programme`, `Level`, `AcademicSession`
  2. Permissions 2: `Permission`, `RolePermission` (or `role_permissions`)
  3. AdminNotif 1: `AdminNotification`
  4. Settings 1: `SystemSettings`
  Total: 9 new tables (additive only; existing 14 untouched).

---

## 5. Definition of Done (DoD Checklist)

- [ ] Batch A (7 TRs): AC-A1 rule PASS; AC-A2 rule PASS; AC-A3 exact copy PASS; component tests green; A5.1 425 idempotency regression test PASS.
- [ ] Batch B (7 TRs): 8 templates rendered; secret-leak audit suite all green (AC-B2); BullMQ dispatchEmail idempotency 1-email job test PASS; payment-success post-commit queue capture test (AC-B1) PASS.
- [ ] Batch C (6 TRs): prisma validate + migrate green (AC-C1); 5 admin CRUD pages render; Dept∉Faculty CSV import unit test (AC-C2) PASS; fee upload same logic PASS; free-text legacy path still works fallback test PASS.
- [ ] Batch D (5 TRs): 10-payment classification counts (AC-D1) PASS; KPI labels exact §64 + delta pills rubric ≥4 (AC-D2); CSV report downloadable; mark-reconciled audit row written test PASS (FR-D5).
- [ ] Batch E (8 TRs): Global search supertest (AC-E1) PASS; Bursary 403 on MANAGE_USERS (AC-E3) PASS; refund confirm no-reason blocks submit (AC-E2) PASS; role_permissions seeds counts match §65 matrix; Audit Logs limited scope export PII stripped test PASS; System Settings save/restore PASS.
- [ ] Batch F (8 TRs): §55 Student 8-item structure rubric ≥4 (AC-F1); §56 Admin groups exact rubric ≥4 (AC-F1); Bursary Administration node NEVER CREATED (AC-F2); 360px drawer usable + 4K no horizontal scroll rubric ≥4 (AC-F3); aria-current="page" present (AC-F4); badges wired on counters; PortalShell 0 tsc errors.
- [ ] Overall (AC-OV1): `prisma validate` 0; `api tsc --noEmit` 0; `app tsc --noEmit` 0; 98+ Jest PASS; builds green; GetDiagnostics [].

---

## 6. Test Matrix (summary TR rules)

Command run for the "authoritative source of truth" final gate per AC-OV1 — MUST be the last command sequence executed before REVIEW phase:

```bash
# 1. Schema
cd "/Users/gloriousanjorin-adeboye/University payment gate-way /api" && npx prisma validate

# 2. TS strict (authoritative)
cd "/Users/gloriousanjorin-adeboye/University payment gate-way /api" && npx tsc --noEmit
cd "/Users/gloriousanjorin-adeboye/University payment gate-way /app" && npx tsc --noEmit

# 3. Jest (must be >= 98 PASS)
cd "/Users/gloriousanjorin-adeboye/University payment gate-way /api" && NODE_ENV=test npx jest health.test.ts regression.test.ts rbac-matrix.test.ts --runInBand --detectOpenHandles

# 4. Builds
cd "/Users/gloriousanjorin-adeboye/University payment gate-way /api" && npm run build
cd "/Users/gloriousanjorin-adeboye/University payment gate-way /app" && npm run build
```

All 6 steps → exit 0 → IMPLEMENT phase cleared, enter REVIEW phase.
