# University Payment Gateway — Specification

## Problem
The University Payment Gateway project requires end-to-end implementation of a backend API (Node/Express/TypeScript on port 3001), a Vite+React frontend (port 3000), a MySQL/Prisma persistence layer, BullMQ async queues, and five coordinated functional/operational modules. The workspace is currently empty; full scaffolding and all five modules must be built from scratch without breaking RBAC, preserved admin accounts, or the AuthContext permission priority order.

## Users / Roles
| Role | Permissions Count | Key Permissions | Preserved IDs |
|---|---|---|---|
| ADMIN | 39 | MANAGE_USERS, VIEW_RECONCILIATION, all perms | 1, 2, 48 (never deletable — super admins) |
| BURSARY | 26 | VIEW_RECONCILIATION, process payments/receipts; NO MANAGE_USERS | — |
| STUDENT | limited | view own invoices/transactions, change own password | — |

## Goals
1. Deliver a runnable backend (`api/`) and frontend (`app/`) scaffold matching the stated ports and stacks.
2. Implement Module 2 — Student Auth: default password = lowercase surname, `mustChangePassword=true`, first-login forced change, ADMIN/BURSARY passwords untouched.
3. Implement Module 3 — Delete Users with Financial Gate: `DELETE /api/v1/admin/users/:id` with 403 protected-account gate (ids 1/2/48), 409 financial-record gate for STUDENT role, cascade-safe delete (audit log nullify, refresh tokens delete, user delete). MANAGE_USERS permission required.
4. Implement Module 4 — Bulk Upload → Queue → Email: BullMQ `student-import-worker` (batches of 250, commit, queue 250 email jobs), `email-queue` (exponential backoff, 3 attempts, removeOnComplete true, SMTP ≤ 120/min). Upload HTTP returns immediately. Import History page has Resend Credentials CTA that re-queues emails. Server must not block.
5. Implement Module 5 — Hygiene: Winston log rotation (20 MB, 7 files, 7 days), Prisma query logs OFF in production, BullMQ autoRemoveOnComplete:true + autoRemoveOnFail keep last 100, api/tmp/uploads cleanup (cron or documented) and remove stale /tmp/*.log temp files.
6. Implement Module 1 — Reconciliation Dashboard (finish placeholders): `GET /api/v1/bursary/reconciliation/summary` aggregation, frontend /bursary/reconciliation stat cards + last-7-day bars + unmatched exceptions table with Resolve CTA. Requires VIEW_RECONCILIATION.

## Non-Goals
- Production deployment, Docker/K8s manifests, real SMS/push, real payment-provider integration beyond settlement models.
- Full UI polish beyond the existing PortalShell + hasPermission pattern; only pages/CTAs required by the modules.
- Mobile apps, i18n, accessibility beyond role-based gating.

## Functional Requirements
### FR-1 (Module 2) — Student Auth Default Password
- `createStudent` (single) and bulk-import worker must hash password = `bcrypt(surname.toLowerCase())` and set `users.mustChangePassword = true` (column already assumed on users model).
- Notification service sends an email containing `{ matricNumber, password: surname.toLowerCase() }` — plaintext password transmitted only by email; never stored.
- Login endpoint returns `{ mustChangePassword: true }` in the response for STUDENTs with the flag set.
- Frontend Login + AuthContext detect the flag and force a change-password screen before granting access to any protected route.
- ADMIN (ids 1/2/48 + others) and BURSARY login behaviour and stored passwords are not altered.

### FR-2 (Module 3) — Delete Users with Financial Gate
- New endpoint: `DELETE /api/v1/admin/users/:id`, permission `MANAGE_USERS` required.
- If id ∈ {1, 2, 48}: HTTP 403, `{ error: "Cannot delete protected account" }`.
- If role = STUDENT: check linked financial records:
  - `transactions.invoice → student` (join through invoices),
  - `receipts.studentId`,
  - `refunds.studentId`,
  - `settled_payments` (if relation exists to student).
  - If ANY exist → HTTP 409 `{ error: "Cannot delete student with existing financial records" }`.
- If STUDENT with NO financial records OR non-STUDENT (and not protected id):
  - Nullify foreign keys in audit logs (if `audit_logs.userId` exists),
  - DELETE all rows from `refresh_tokens` for user,
  - DELETE user row.
- Frontend Admin → Users page: Delete button per row, confirmation modal, 409 surfaced as alert, 403 surfaced as alert.

### FR-3 (Module 4) — Bulk Upload, Queue, Email
- Backend accepts CSV multipart upload at `POST /api/v1/admin/students/import`, requires MANAGE_USERS.
- Upload request persists CSV to `api/tmp/uploads/<uuid>.csv` and enqueues an import job into BullMQ, returns `{ jobId, status: "queued" }` immediately (non-blocking HTTP).
- `student-import-worker` processes CSV → inserts rows in batches of 250 inside a Prisma transaction.
- After each batch commit, the worker enqueues 250 credential email jobs into `email-queue` (1 per student).
- `email-queue` jobs: `attempts: 3`, `backoff: { type: "exponential", delay: 2000 }`, `removeOnComplete: true`.
- Global SMTP rate limiting: ≤ 120 emails/minute (BullMQ limiter OR per-minute token bucket).
- Import history: stored table (import_runs / import_rows), status field (PROCESSING/COMPLETED/FAILED), summary counts.
- Import History page: per-student "Resend Credentials" button enqueues a new email job (never sends inline).

### FR-4 (Module 5) — Log / Disk / CPU Hygiene
- Winston logger (default application logger), transport: file rotation with `maxsize: 20971520` (20 MB), `maxFiles: 7`, frequency based on 7-day retention.
- `prisma.$on("query", …)` only registered when `NODE_ENV !== "production"`. In production only errors/warns emitted.
- BullMQ queues: default job options `{ removeOnComplete: true, removeOnFail: { count: 100 } }`.
- Temp CSV cleanup: a daily cron (or documented startup + interval) deletes files older than 24 h in `api/tmp/uploads/` and stale `*.log` files under the project temp dirs.

### FR-5 (Module 1) — Reconciliation Dashboard
- `GET /api/v1/bursary/reconciliation/summary` with permission `VIEW_RECONCILIATION`.
- Response shape:
  ```ts
  {
    totalCollected: number;      // transactions.status=SUCCESS aggregates
    totalSettled: number;        // settlements.status=SETTLED aggregates
    pendingSettlement: number;   // totalCollected - totalSettled (or dedicated field)
    unmatchedCount: number;      // transactions.status=PENDING + webhook_events unmatched
    exceptionsCount: number;     // count of rows where mismatch / exception flag
    byDayLast7Days: Array<{ date: string; amount: number }>;
  }
  ```
- Frontend `/bursary/reconciliation` page behind `VIEW_RECONCILIATION` gate:
  - Stat cards: Total Collected, Settled, Pending Settlement, Exceptions.
  - Last 7 days: simple bar chart or date/amount list.
  - Unmatched Exceptions table with a "Resolve" CTA that links to the corresponding Receipt row.

## Non-Functional Requirements
- **RBAC integrity**: permission enumerations identical to current DB intent — ADMIN 39, BURSARY 26; no new permission keys introduced.
- **Preserved accounts**: ids 1, 2, 48 never deleted and their password rows not disturbed by student import.
- **AuthContext priority**: `me.permissions > token permissions > fallback` — merge order not reversed.
- **TypeScript strict**: `tsc --strict --noEmit` passes for both `api/` and `app/`.
- **Resilience**: 10,000-row CSV import must not block the server; backend remains responsive throughout.
- **Resource safety**: Redis/BullMQ memory bounded by removeOnComplete:true; logs bounded by rotation; temp disk bounded by cleanup.

## Constraints & Dependencies
- Node.js + TypeScript, Express backend, Vite + React frontend, MySQL + Prisma ORM, Redis for BullMQ, Winston logger, Bcrypt for passwords, Multer for CSV upload.
- Ports: backend 3001, frontend 3000 (Vite dev proxy to :3001).
- Frontend must use PortalShell layout pattern, `Permissions` enum, and `useAuth()` hook with `hasPermission()` helpers.

## Assumptions
- The `users` table already (or will) have a boolean `mustChangePassword` column; the spec treats it as present.
- RBAC permission model: permissions are granted through roles (one role per user typical); `MANAGE_USERS` is only held by ADMIN, `VIEW_RECONCILIATION` by ADMIN + BURSARY.
- Financial tables: `transactions`, `invoices`, `receipts`, `refunds`, `settlements` (or `settled_payments`), `webhook_events` exist as relational Prisma models.
- SMTP credentials via env (fallback to a mock SMTP transport that logs if creds absent) so email flow works in dev.

## Open Questions
- None blocking — reasonable defaults chosen (Prisma MySQL, BullMQ Redis, Winston).

## Acceptance Criteria

### AC-1 rule
`tsc --strict --noEmit` exits 0 in `api/` and `app/`. Evidence: terminal output of tsc run.

### AC-2 rule
Backend startable on 3001, frontend dev server startable on 3000. Evidence: server stdout showing listening ports.

### AC-3 rule
`POST /auth/login` for a STUDENT user returns `mustChangePassword: true` for freshly created users and allows `/auth/change-password` to flip it to false; subsequent login returns false. Evidence: curl requests.

### AC-4 rule
Creating a STUDENT via single create OR via import worker stores `bcrypt(surname.toLowerCase())` and no other password. Evidence: Prisma query result showing hash + change-password success.

### AC-5 rule
ADMIN ids 1/2/48 login still succeeds without must-change-password flow and their passwords are not equal to any hashed surname default. Evidence: curl login for id 2 returning `mustChangePassword: false` and 200.

### AC-6 rule
`DELETE /api/v1/admin/users/:id` with MANAGE_USERS returns 403 for id ∈ {1,2,48}. Evidence: curl 403 response.

### AC-7 rule
`DELETE /api/v1/admin/users/:id` for a STUDENT with linked receipts/transactions/refunds returns 409. Evidence: curl 409 JSON.

### AC-8 rule
`DELETE /api/v1/admin/users/:id` for a non-STUDENT non-protected user or student without financials succeeds 204; related refresh_tokens rows are gone; audit_logs.userId null (if FK present). Evidence: Prisma query after delete.

### AC-9 rule
`DELETE /api/v1/admin/users/:id` without MANAGE_USERS token returns 403. Evidence: curl 403.

### AC-10 rule
`POST /api/v1/admin/students/import` responds within 1.5 s for a 10k-row CSV (response 202/200 + jobId) and the HTTP thread is not blocked. Evidence: time(1) output or server responsiveness check during import.

### AC-11 rule
After an import of 10k rows, DB shows all students inserted, `email-queue` had exactly 10k jobs processed or queued (batches of 250 emails). Evidence: DB count + queue metrics.

### AC-12 rule
"Resend Credentials" button on Import History (or per student) POSTs to an endpoint that enqueues a new email job (not inline). Evidence: endpoint returns a job id and an email-queue job record appears.

### AC-13 rule
Email jobs have `attempts:3, exponential backoff, removeOnComplete:true, removeOnFail count 100` and global send rate ≤ 120/min. Evidence: queue creation source code + job options snapshot.

### AC-14 rule
Winston logger configured with 20 MB max file size and 7 file retention. Prisma query events only wired when NODE_ENV != production. Evidence: logger source + Prisma client construction.

### AC-15 rule
BullMQ queues default to `removeOnComplete:true, removeOnFail:{count:100}`. Evidence: queue defaultJobOptions code.

### AC-16 rule
Temp CSV cleanup mechanism (cron or interval) exists to delete uploads older than 24h and stale temp log files. Evidence: cleanup scheduler code OR documented note in code.

### AC-17 rule
`GET /api/v1/bursary/reconciliation/summary` returns the exact shape with non-negative numbers and 7 entries in byDayLast7Days; VIEW_RECONCILIATION gating enforced (403 otherwise). Evidence: curl response.

### AC-18 rule
Frontend `/bursary/reconciliation` renders 4 stat cards, a last-7-day series, and an exceptions table; page is blank or redirected when `hasPermission(VIEW_RECONCILIATION)` is false. Evidence: frontend rendered DOM snapshot or React testing assertion.

### AC-19 rule
Admin Users page has a Delete button per row; clicking it opens confirmation; confirmation triggers DELETE and shows 409/403 as alerts; 204 removes the row. Evidence: component source + action flow.

### AC-20 rubric
**Frontend pattern fidelity (0-3)** — 3 = every page uses PortalShell, useAuth/hasPermission gating, no new permission keys; 2 = minor deviation in 1 page; 1 = multiple deviations; 0 = new keys introduced or pattern abandoned. Pass threshold: ≥ 2. Evidence: frontend source audit.

### AC-21 rubric
**Backend stability under bulk load (0-3)** — 3 = CPU < 100% sustained, memory flat, HTTP response <100ms during 10k CSV worker; 2 = acceptable; 1 = briefly blocked; 0 = unresponsive. Pass threshold: ≥ 2. Evidence: comment with load profile (simulated by batch 250/transaction strategy in code).

### AC-22 rule
AuthContext permission merge priority is `me.permissions > token > fallback` (verified by reading code order of Object.assign / spread). Evidence: AuthContext source.
