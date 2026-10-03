# University Payment Gateway — Implementation Tasks

| Criterion | Source AC | Priority |
|---|---|---|
| T1–T7 scaffolding + Prisma | AC-1, AC-2 | high |
| T8–T12 Module 2 Student Auth | AC-3, AC-4, AC-5, AC-22 | high |
| T13–T19 Module 3 Delete Gate + UI | AC-6, AC-7, AC-8, AC-9, AC-19 | high |
| T20–T26 Module 4 Import + Queue + Email + Resend | AC-10, AC-11, AC-12, AC-13, AC-21 | high |
| T27–T31 Module 5 Hygiene | AC-14, AC-15, AC-16 | high |
| T32–T37 Module 1 Reconciliation Dashboard | AC-17, AC-18, AC-20 | high |
| T38 Validation & Pipeline | all AC | high |

---

## Task 1: Root monorepo files and shared types
**Status:** pending  
**Priority:** high  
**Depends on:** —

### Implementation
- Create `/package.json` (scripts `dev:api`, `dev:app`, `build`, `tsc:api`, `tsc:app`).
- Create shared types outline, permissions enum.
- `.env.example` with required keys: `DATABASE_URL`, `REDIS_URL`, `PORT_API=3001`, `PORT_APP=3000`, `JWT_SECRET`, `SMTP_*`, `NODE_ENV`.

### Test Requirements
- **TR-1.1 rule:** Root `package.json` exists with scripts for tsc:api and tsc:app. Evidence: `ls` + `cat` output.
- **TR-1.2 rule:** `Permissions` enum in shared/types contains at least `MANAGE_USERS`, `VIEW_RECONCILIATION`, and the 39-ADMIN / 26-BURSARY intent. Evidence: enum source listing.

---

## Task 2: Backend package, tsconfig, Express app bootstrap (port 3001)
**Status:** pending  
**Priority:** high  
**Depends on:** T1

### Implementation
- `api/package.json` — express, @prisma/client, prisma dev, bcrypt, jsonwebtoken, bullmq, ioredis, winston, winston-daily-rotate-file, multer, csv-parser, zod, cors, helmet, dotenv, node-cron, typescript, tsx, @types packages.
- `api/tsconfig.json` — strict:true, noEmit:true, paths optional.
- `api/src/main.ts` — create Express app, JSON body limit, CORS, helmet, health route `/health`, mount `/api/v1` router, listen PORT 3001.
- App bootstrap registers queues, logger, cron cleanup, DB connection via Prisma.

### Test Requirements
- **TR-2.1 rule:** `tsc --project api/tsconfig.json --noEmit` clean. Evidence: terminal output.
- **TR-2.2 rule:** `/health` returns 200 `{status:"ok"}`. Evidence: curl.

---

## Task 3: Prisma schema (MySQL) — all models required by modules
**Status:** pending  
**Priority:** high  
**Depends on:** T2

### Implementation
`api/prisma/schema.prisma` — datasource mysql, generator client.
Models: User, Role, Permission, RolePermission, RefreshToken, AuditLog, Session, Student, Invoice, Transaction, Receipt, Refund, Settlement, WebhookEvent, ImportRun, ImportRow.
Relations required by Module 3 gates:
- `Transaction.invoiceId → Invoice.id; Invoice.studentId → Student.id; Student.userId → User.id`
- `Receipt.studentId → Student.id`
- `Refund.studentId → Student.id`
- `Settlement.paymentRef links to transactions (or settled_payments mapping)`
- `AuditLog.userId User?` nullable so CASCADE nullify works.
- User columns: id Int @id, email, passwordHash, role (enum ADMIN|BURSARY|STUDENT), mustChangePassword Boolean @default(false), createdAt, matricNumber? unique for STUDENT, firstName, lastName (surname = lastName). surname field optional alias.
- DB seed: preserved ids 1/2/48 as ADMIN, id 3 as BURSARY sample.
- Permissions 39 ADMIN, 26 BURSARY (seed populates RolePermission junction; ensure MANAGE_USERS only Admin, VIEW_RECONCILIATION Admin + Bursary).

### Test Requirements
- **TR-3.1 rule:** `npx prisma validate` exits 0. Evidence: terminal.
- **TR-3.2 rule:** Prisma seed creates User IDs 1, 2, 48 with role ADMIN plus at least one BURSARY user, MANAGE_USERS only on Admin role. Evidence: Prisma query result counts.
- **TR-3.3 rule:** Relations exist such that queries described in FR-2 gates are expressible (transactions→invoice→student, receipts.studentId, refunds.studentId, settlements). Evidence: schema file section.

---

## Task 4: Backend core middleware — JWT auth, RBAC hasPermission, error handler
**Status:** pending  
**Priority:** high  
**Depends on:** T3

### Implementation
- `api/src/middleware/auth.ts` — decode bearer JWT → attach `req.user = { userId, role, permissions: string[] }`; 401 otherwise.
- `api/src/middleware/rbac.ts` — `requirePermission(key)` factory returns 403 if missing.
- Error middleware `api/src/middleware/error.ts` — maps Prisma / Zod / AppError to status codes.
- `api/src/utils/AppError.ts` class.

### Test Requirements
- **TR-4.1 rule:** A route with `requirePermission("MANAGE_USERS")` returns 401 without token, 403 with BURSARY token, 200 with ADMIN token. Evidence: curl triplet.
- **TR-4.2 rule:** RBAC enum uses existing keys only (matches shared `Permissions`). Evidence: source grep.

---

## Task 5: BullMQ queues (email-queue, student-import-worker) + Redis wiring
**Status:** pending  
**Priority:** high  
**Depends on:** T2

### Implementation
- `api/src/config/queue.ts` — single Redis connection (ioredis) via env.
- `emailQueue: Queue("email-queue")` with `defaultJobOptions: { attempts:3, backoff:{type:"exponential", delay:2000}, removeOnComplete:true, removeOnFail:{count:100} }`.
- `studentImportQueue: Queue("student-import")` with same default options.
- Workers wired before server listen. Rate limiter `{ max:120, duration:60000 }` on email worker.

### Test Requirements
- **TR-5.1 rule:** Queue defaults include `removeOnComplete:true` and `removeOnFail.count=100`. Evidence: queue creation code.
- **TR-5.2 rule:** Email worker declares rate limit ≤120/min. Evidence: worker constructor opts.

---

## Task 6: Winston logger (rotation 20MB, 7d) + Prisma log wiring
**Status:** pending  
**Priority:** high  
**Depends on:** T2

### Implementation
- `api/src/config/logger.ts` — Winston with Console + DailyRotateFile transports (`maxSize: "20m"`, `maxFiles: "7d"`), level=info, structured JSON.
- `api/src/config/prisma.ts` — construct `PrismaClient` with `log: process.env.NODE_ENV==="production" ? ["error"] : ["query","info","warn","error"]`, only register `prisma.$on("query")` when non-production.

### Test Requirements
- **TR-6.1 rule:** `maxSize="20m"` and `maxFiles="7d"` in transport config. Evidence: logger source.
- **TR-6.2 rule:** In production (NODE_ENV=production) Prisma client log array excludes "query" and `$on("query")` is not registered. Evidence: source conditional.

---

## Task 7: Frontend Vite + React app scaffold (port 3000), PortalShell, AuthContext + useAuth
**Status:** pending  
**Priority:** high  
**Depends on:** T1, T4

### Implementation
- `app/package.json` — react@18, react-router-dom@6, axios, vite@5, @vitejs/plugin-react, typescript strict, recharts (for bars), tailwind optional css modules.
- `app/vite.config.ts` — server port 3000, proxy `/api → http://localhost:3001`.
- `app/tsconfig.json` strict + noEmit.
- `app/src/main.tsx`, `app/src/App.tsx` (BrowserRouter routes).
- `app/src/contexts/AuthContext.tsx`:
  - Permissions merge priority: `me.permissions > token.permissions > fallback []` (spread order).
  - state: token, me, login(), logout(), changePassword().
  - export `AuthProvider`.
- `app/src/hooks/useAuth.ts` — returns context, plus helper `hasPermission(key:Permissions): boolean`.
- `app/src/layouts/PortalShell.tsx` — sidebar nav, header, outlet, permission-gated nav items; used for all protected pages.
- `app/src/types/permissions.ts` — enum clone of shared (keep single source import).
- `app/src/utils/api.ts` — axios instance with bearer interceptor; response 401 → logout.

### Test Requirements
- **TR-7.1 rule:** `tsc --project app/tsconfig.json --noEmit` exits 0. Evidence: terminal.
- **TR-7.2 rule:** AuthContext merge order: `{ ...fallback, ...tokenPerms, ...mePerms }` (or equivalent priority). Evidence: AuthContext source lines.
- **TR-7.3 rule:** `PortalShell` wraps admin and bursary protected routes; `useAuth().hasPermission` used to hide menu items. Evidence: Router + Shell source.

---

## Task 8 (Module 2): createStudent backend service + password = bcrypt(surname.toLowerCase()), mustChangePassword=true
**Status:** pending  
**Priority:** high  
**Depends on:** T3, T6

### Implementation
- `api/src/services/studentService.ts`
  - `createStudent(input: {firstName, lastName, email?, matricNumber, ...})` → generates password = `lastName.toLowerCase()`, bcrypt hash rounds 10, writes `users.mustChangePassword=true`, stores student profile row.
  - Returns generated plaintext password to caller only so notification worker can dispatch email (never logged).
- Bulk import worker (later task) reuses identical password logic.
- Preserved admin ids 1/2/48 never routed through createStudent; their passwords unchanged.

### Test Requirements
- **TR-8.1 rule:** New student record has `mustChangePassword=true` and `bcrypt.compareSync(lowercaseSurname, hash)` is true. Evidence: Prisma query after create + bcrypt verify assertion.

---

## Task 9 (Module 2): Notification service + Email job implementation
**Status:** pending  
**Priority:** high  
**Depends on:** T5, T8

### Implementation
- `api/src/services/notificationService.ts`
  - `sendStudentCredentials({to, matricNumber, password})` — renders plaintext + HTML email with credentials; Nodemailer transport uses SMTP env; if absent uses JSON transport log.
- `api/src/workers/emailWorker.ts` — `Worker("email-queue", handler, rate limit, connection)` calls notification service.
- After createStudent, call `queueStudentCredentialEmail(...)` enqueue, never inline send.

### Test Requirements
- **TR-9.1 rule:** Email job payload contains `matricNumber` and `password` (plaintext surname lower). Evidence: enqueue code + queue.getJob().data snapshot.
- **TR-9.2 rule:** Sending never performed inline outside worker. Evidence: grep for `sendMail(...)` calls confined to emailWorker.

---

## Task 10 (Module 2): Auth routes POST /auth/login + POST /auth/change-password + mustChangePassword enforcement
**Status:** pending  
**Priority:** high  
**Depends on:** T4, T8

### Implementation
- `api/src/routes/v1/auth.ts`
  - `POST /login` — body {email, password}. Verify bcrypt, find role/perms, issue access JWT (short) + refresh JWT (long). Return `{accessToken, refreshToken, user:{id, role, mustChangePassword, permissions}}`.
  - `POST /change-password` — authenticated, body {oldPassword?, newPassword}. For users with `mustChangePassword=true` allow even if oldPassword omitted? No — enforce passing old OR JWT identity + `mustChangePassword=true` flag. On success set `mustChangePassword=false`.
  - Preserved ids: normal flow; old password never mutated by Module 2 code.

### Test Requirements
- **TR-10.1 rule:** Login of newly created student returns `mustChangePassword:true`. Evidence: curl.
- **TR-10.2 rule:** After `POST /auth/change-password` with a valid new password, next login returns `mustChangePassword:false`. Evidence: curl login #2.
- **TR-10.3 rule:** Login of preserved admin id 2 returns `mustChangePassword:false` and 200. Evidence: curl.

---

## Task 11 (Module 2): Frontend Login + forced Change Password flow
**Status:** pending  
**Priority:** high  
**Depends on:** T7, T10

### Implementation
- `app/src/pages/Login.tsx` — form, on success: if `user.mustChangePassword === true` redirect `/change-password`, else go to role dashboard.
- `app/src/pages/ChangePassword.tsx` — two fields (new + confirm), submit to `/auth/change-password`, on success redirect `/`.
- Protected routes wrapper (`app/src/components/RequireAuth.tsx`) — when mustChangePassword true AND route not /change-password → redirect.

### Test Requirements
- **TR-11.1 rule:** Login success with mustChangePassword=true navigates to `/change-password`. Evidence: component code.
- **TR-11.2 rule:** Accessing any `/admin/*` or `/bursary/*` route while mustChangePassword=true triggers redirect. Evidence: RequireAuth source.

---

## Task 12 (Module 2): IAM verification — ADMIN/BURSARY passwords NOT rewritten
**Status:** pending  
**Priority:** high  
**Depends on:** T8, T10

### Implementation
- Explicit branch guard: `studentService.createStudent` writes a STUDENT row role only. Admin users created only by seed / manual admin-create endpoint with explicit password.
- Add a unit-level comment/test guard in code that ensures createStudent cannot produce ADMIN/BURSARY role.

### Test Requirements
- **TR-12.1 rule:** Create student call attempts with `role=ADMIN` are rejected (zod/enum validation or override). Evidence: schema zod guard.

---

## Task 13 (Module 3): DELETE /api/v1/admin/users/:id endpoint with all gates
**Status:** pending  
**Priority:** high  
**Depends on:** T3, T4

### Implementation
- `api/src/routes/v1/adminUsers.ts` (mounted under `/admin/users`).
- `DELETE /:id` handler sequence:
  1. `requirePermission(Permissions.MANAGE_USERS)`.
  2. If `[1,2,48].includes(parseInt(params.id))` → 403 `"Cannot delete protected account"`.
  3. Fetch user; if role == STUDENT query financial presence:
     ```
     hasTransactions = exists Transaction → Invoice.student.userId == id
     hasReceipts     = exists Receipt where student.userId == id
     hasRefunds      = exists Refund  where student.userId == id
     hasSettlements  = exists Settlement joined via settled_payments → student (if model allows; OR skipped if unmapped)
     ```
     If any true → 409 `"Cannot delete student with existing financial records"`.
  4. Else safe delete (transaction):
     - `UPDATE AuditLog SET userId = NULL WHERE userId = :id` (or no-op if nullable handled by Prisma cascade — here explicit).
     - `DELETE FROM RefreshToken WHERE userId = :id`.
     - `DELETE FROM User WHERE id = :id`.
     - Student profile cascaded by FK on delete.
  5. Return 204.

### Test Requirements
- **TR-13.1 rule:** curl DELETE id=1 → 403 body `"Cannot delete protected account"`. Evidence: curl output.
- **TR-13.2 rule:** STUDENT with receipt → 409. Evidence: curl output.
- **TR-13.3 rule:** Non-protected BURSARY without financials DELETE → 204; refresh_tokens rows gone; audit_logs userId NULLed. Evidence: post-delete Prisma query.
- **TR-13.4 rule:** BURSARY JWT + DELETE → 403 from MANAGE_USERS middleware. Evidence: curl.

---

## Task 14 (Module 3): GET /api/v1/admin/users list endpoint (Admin Users page feed)
**Status:** pending  
**Priority:** medium  
**Depends on:** T13

### Implementation
- GET `api/v1/admin/users` requires MANAGE_USERS, pagination 25 rows; shape: `{data:[{id,email,role,firstName,lastName,matricNumber,mustChangePassword,createdAt}], meta:{page,total}}`.

### Test Requirements
- **TR-14.1 rule:** GET with Admin token → 200 and list includes preserved ids 1/2/48 flagged role=ADMIN. Evidence: curl.

---

## Task 15 (Module 3): Frontend Admin → Users page list rendering
**Status:** pending  
**Priority:** high  
**Depends on:** T7, T14

### Implementation
- `app/src/pages/admin/UsersPage.tsx` inside `<PortalShell>`; route `/admin/users` gated by `hasPermission(MANAGE_USERS)`.
- Table columns: ID, Name (first+last), Email, Role, Matric #, Password Status, Actions → Delete button.

### Test Requirements
- **TR-15.1 rule:** Page renders table with Delete action in each row. Evidence: component source.

---

## Task 16 (Module 3): Frontend Delete confirmation modal + 409/403 alerting
**Status:** pending  
**Priority:** high  
**Depends on:** T15, T13

### Implementation
- `app/src/components/ConfirmDeleteModal.tsx` — role-aware warning.
- On DELETE success 204 → remove row from state; on 403 → red toast `Cannot delete protected account`; on 409 → orange/yellow alert with exact server message.

### Test Requirements
- **TR-16.1 rule:** Handler dispatches DELETE and on 409 sets `<Alert variant="warning">` with backend message. Evidence: source code.

---

## Task 17 (Module 3): Database Engineer — FK cascade for safe delete paths
**Status:** pending  
**Priority:** high  
**Depends on:** T3, T13

### Implementation
- Ensure schema FK `Student.userId → User.id` uses `onDelete: Cascade`; `RefreshToken.userId → User` `onDelete: Cascade`; `AuditLog.userId → User` `onDelete: SetNull` (column nullable). If not achievable via Prisma, ensure explicit UPDATE/DELETE in service achieves same effect.
- Migration SQL includes index on `Receipt.studentId`, `Refund.studentId`, `Invoice.studentId` so 409 gate queries are fast.

### Test Requirements
- **TR-17.1 rule:** Prisma schema includes `@onDelete(Cascade)` for RefreshToken and Student, `@onDelete(SetNull)` for AuditLog or equivalent explicit cleanup in service. Evidence: schema lines.
- **TR-17.2 rule:** Indices exist for 409-gate FK columns. Evidence: @@index directives.

---

## Task 18 (Module 3, quality): Admin can see but never self-delete id 1/2/48; UI guard
**Status:** pending  
**Priority:** medium  
**Depends on:** T16

### Implementation
- Frontend: hide/disable Delete button for ids 1/2/48 with tooltip "Protected account". Backend still 403s.

### Test Requirements
- **TR-18.1 rule:** Delete button disabled for ids in {1,2,48}. Evidence: component JSX.

---

## Task 19 (Module 3, QA): Endpoint QA via curl
**Status:** pending  
**Priority:** high  
**Depends on:** T13

### Implementation
- Run curl scripts for TR-13.1, TR-13.2, TR-13.3, TR-13.4 and capture outputs.

### Test Requirements
- **TR-19.1 rule:** All four curl scenarios captured and passing. Evidence: logs.

---

## Task 20 (Module 4): Backend CSV upload endpoint (POST /api/v1/admin/students/import) non-blocking
**Status:** pending  
**Priority:** high  
**Depends on:** T5, T8, T6

### Implementation
- `api/src/routes/v1/studentImport.ts` (mounted under `/admin/students/import`):
  - MANAGE_USERS required.
  - Multer disk storage → `api/tmp/uploads/<uuid>.csv`, single file field `csv`.
  - On upload success → create ImportRun row (PROCESSING, filename, uuid, totalRows: null), enqueue `studentImportQueue.add("process-csv", { importRunId, filePath })`, return 202 `{ jobId, importRunId, status:"queued" }` — no work done inline.

### Test Requirements
- **TR-20.1 rule:** Endpoint returns in < 1.5 s for 10k CSV. Evidence: `time curl` output.
- **TR-20.2 rule:** After response, a job exists in `studentImportQueue.getJobs()`. Evidence: inspect.

---

## Task 21 (Module 4): student-import-worker processes CSV in batches of 250 with Prisma transactions
**Status:** pending  
**Priority:** high  
**Depends on:** T20, T9

### Implementation
- `api/src/workers/studentImportWorker.ts`:
  - Stream CSV via csv-parser (streaming, low memory).
  - Buffer rows in chunks of 250.
  - For each chunk:
    - `prisma.$transaction(async tx => { /* insert Users + Student profiles, password logic reuse from studentService */ })`.
    - Commit success → build 250 `{to, matricNumber, password}` payloads.
    - Call `emailQueue.addBulk(payloads.map(d => { name:"credentials", data:d, opts }))` (or loop addBulk).
    - Update ImportRow rows with status SUCCESS/FAILED + error messages per row.
  - End: update ImportRun COMPLETED/FAILED.
- Password reuse: use `studentService.buildPasswordAndUser(input)` helper (same logic as single create).

### Test Requirements
- **TR-21.1 rule:** Worker commits every 250 rows via `$transaction`, then enqueues emails (never before commit). Evidence: worker source line order.
- **TR-21.2 rule:** 10,000 inserts without memory blowup (stream) and 40 batches of emails (250×40=10,000) queued. Evidence: code review of batch logic + DB count.

---

## Task 22 (Module 4): Email Queue job options (backoff, attempts, removeOnComplete)
**Status:** pending  
**Priority:** high  
**Depends on:** T5, T9

### Implementation
- Ensure every credential email job is created with: `{ attempts:3, backoff:{type:"exponential",delay:2000}, removeOnComplete:true }` (inherited from default plus overrides if needed). Queue defaults T5 already set `removeOnFail:{count:100}`.
- Global rate limiter on Worker: `{ limiter: { max:120, duration: 60_000 } }`.

### Test Requirements
- **TR-22.1 rule:** job.opts matches required values, removeOnComplete true. Evidence: source.
- **TR-22.2 rule:** Email worker constructor has limiter 120/60s. Evidence: source.

---

## Task 23 (Module 4): Import History backend endpoints (list + per-row resend)
**Status:** pending  
**Priority:** high  
**Depends on:** T21

### Implementation
- GET `/api/v1/admin/students/imports` → page of ImportRun (MANAGE_USERS).
- GET `/api/v1/admin/students/imports/:id/rows` → paginated rows of the run, include status, error, studentEmail/studentId.
- POST `/api/v1/admin/students/imports/rows/:rowId/resend-credentials` → MANAGE_USERS, validates row success, enqueues email with credentials, returns `{jobId}`. Never inline email.

### Test Requirements
- **TR-23.1 rule:** Resend endpoint does NOT call sendMail directly. Evidence: grep handler body.
- **TR-23.2 rule:** Resend without MANAGE_USERS → 403. Evidence: curl.

---

## Task 24 (Module 4): Frontend Import Upload page (Admin)
**Status:** pending  
**Priority:** medium  
**Depends on:** T20, T7

### Implementation
- `/admin/students/import` page, MANAGE_USERS gate. File input + Upload button → POST multipart. On success show "Import queued, jobId=…".

### Test Requirements
- **TR-24.1 rule:** UI uses multipart form data. Evidence: component.

---

## Task 25 (Module 4): Frontend Import History + "Resend Credentials" per row
**Status:** pending  
**Priority:** high  
**Depends on:** T23, T7

### Implementation
- `/admin/students/import-history` page, inside PortalShell.
- Tabs: Runs (table of runs) → click a run → Rows table (Student, Email, Status, Error). Add column Actions with button "Resend Credentials".
- Button onClick → POST resend endpoint; on success toast "Credentials queued" + job id.

### Test Requirements
- **TR-25.1 rule:** Each row includes a Resend CTA. Evidence: JSX.
- **TR-25.2 rule:** CTA calls backend queue endpoint (not inline). Evidence: axios request in handler.

---

## Task 26 (Module 4): Server responsiveness check during 10k CSV import
**Status:** pending  
**Priority:** high  
**Depends on:** T21

### Implementation
- Smoke test: start server, kick upload, then run 10 parallel `curl /health` during import. Response times <500 ms expected (async queue + batching protect event loop).
- Code audit: no synchronous full CSV parsing.

### Test Requirements
- **TR-26.1 rule:** `/health` latency during CSV worker remains low (no event-loop block). Evidence: curl loop times.
- **TR-26.2 rule:** No `fs.readFileSync` on entire CSV in worker. Evidence: grep.

---

## Task 27 (Module 5): Winston log rotation 20MB + 7-day retention
**Status:** pending  
**Priority:** high  
**Depends on:** T6

### Implementation
- In T6 already define `DailyRotateFile` with `maxSize: "20m"`, `maxFiles: "7d"`, dirname `api/logs`. Add a combined and an error file stream.
- Ensure dev/prod both use rotate config (console only if desired — both are fine).

### Test Requirements
- **TR-27.1 rule:** Logger transports include rotate with both thresholds. Evidence: source + logger.info call works after start.

---

## Task 28 (Module 5): Production Prisma query log OFF
**Status:** pending  
**Priority:** high  
**Depends on:** T6

### Implementation
- Already part of T6. Re-verify with code review.
- Additionally, ensure `prisma.$on("query", cb)` only called when `NODE_ENV !== "production"`.

### Test Requirements
- **TR-28.1 rule:** Conditional exists. Evidence: source lines.

---

## Task 29 (Module 5): BullMQ defaults — removeOnComplete:true + removeOnFail keep last 100
**Status:** pending  
**Priority:** high  
**Depends on:** T5

### Implementation
- All queues use shared `DEFAULT_JOB_OPTS = { removeOnComplete:true, removeOnFail:{count:100}, attempts:3 }`.
- Individual jobs may override attempts/backoff only, not removeOnComplete.

### Test Requirements
- **TR-29.1 rule:** All 3 queues (emailQueue, studentImportQueue, any future) share same default opts factory. Evidence: queue.ts source.

---

## Task 30 (Module 5): Temp CSV cleanup cron (api/tmp/uploads older than 24h) + stale .log cleanup
**Status:** pending  
**Priority:** high  
**Depends on:** T2, T6

### Implementation
- `api/src/services/cleanupService.ts`:
  - `cleanTempUploads()` — scan `api/tmp/uploads`, delete files older than `Date.now() - 24*3600*1000`.
  - `cleanOldTempLogs()` — scan project `api/tmp/` for `*.log`, delete files older than 7 days.
- `node-cron` schedule `0 3 * * *` (every day 3 AM). Also run once at startup.
- If cron env disabled, log an explicit note: "Temp CSV cleanup cron disabled; ensure api/tmp/uploads cleaned within 24h by platform cron."

### Test Requirements
- **TR-30.1 rule:** Scheduler registers cleanup at startup. Evidence: app bootstrap main.ts import.
- **TR-30.2 rule:** `cleanTempUploads` logic checks `mtimeMs` and only removes >24h old. Evidence: source.

---

## Task 31 (Module 5): QA — no temp files accumulate in basic run
**Status:** pending  
**Priority:** medium  
**Depends on:** T30

### Implementation
- Manual cleanup test: create a dummy 25h-old file in tmp/uploads, trigger cleanup, assert gone.

### Test Requirements
- **TR-31.1 rule:** Cleanup function removes old file. Evidence: test output / logs.

---

## Task 32 (Module 1): Backend GET /api/v1/bursary/reconciliation/summary aggregation
**Status:** pending  
**Priority:** high  
**Depends on:** T3, T4

### Implementation
- `api/src/routes/v1/reconciliation.ts` → require `VIEW_RECONCILIATION`.
- Query:
  - `totalCollected` = SUM transactions.amount where status="SUCCESS" scoped today/month/session — summary returns totals as overall + structured if needed; keep response exactly as FR-5.
  - `totalSettled` = SUM settlements.amount where status="SETTLED".
  - `pendingSettlement` = totalCollected - totalSettled (non-negative; clamp 0).
  - `unmatchedCount` = count transactions where status="PENDING" + count webhook_events that are unmatched.
  - `exceptionsCount` = count transactions/receipts where mismatch flag or exception.
  - `byDayLast7Days` = array of 7 entries, each date in YYYY-MM-DD and amount = SUM of SUCCESS transactions for that day; zero-fill missing days.
- Session scope: use currentSession (env or DB) for session filter.

### Test Requirements
- **TR-32.1 rule:** Response shape matches `{totalCollected,totalSettled,pendingSettlement,unmatchedCount,exceptionsCount,byDayLast7Days}` with byDay length=7 non-negative. Evidence: curl JSON.
- **TR-32.2 rule:** BURSARY token → 200; STUDENT token → 403. Evidence: curl.

---

## Task 33 (Module 1): Backend GET /api/v1/bursary/reconciliation/exceptions table feed
**Status:** pending  
**Priority:** high  
**Depends on:** T32

### Implementation
- GET `/api/v1/bursary/reconciliation/exceptions?page=1&size=25` VIEW_RECONCILIATION → list of unmatched transactions + webhook events with `{id,type,reference,amount,date,studentId?,receiptId?,resolveUrl}` where `resolveUrl` links to receipt page if receiptId exists.

### Test Requirements
- **TR-33.1 rule:** Exception rows include `resolveUrl` for receipt-backed rows. Evidence: curl.

---

## Task 34 (Module 1): Frontend Bursary → Reconciliation page with permission gate
**Status:** pending  
**Priority:** high  
**Depends on:** T7, T32

### Implementation
- `/bursary/reconciliation` page wrapped by `<PortalShell>`, entry gated by `hasPermission(VIEW_RECONCILIATION)`; redirect/warning if missing.
- Fetch summary and populate:
  - 4 stat cards (Total Collected, Total Settled, Pending Settlement, Exceptions).
  - Last-7-day bar chart using recharts `<BarChart>` (or fallback `<ul>` list if chart library not used).
  - Exceptions table with columns: Date, Reference, Type, Amount, Resolve.

### Test Requirements
- **TR-34.1 rule:** Page renders 4 cards + last-7-day series + exceptions table. Evidence: components.
- **TR-34.2 rule:** No VIEW_RECONCILIATION → page redirects or shows permission-denied. Evidence: gating code.

---

## Task 35 (Module 1): Resolve CTA in exceptions table
**Status:** pending  
**Priority:** high  
**Depends on:** T34, T33

### Implementation
- Resolve button → navigates to `/bursary/receipts/:id` (or general resolve link) using `resolveUrl` from exception row.
- If no receiptId, button is disabled with tooltip "No receipt linked".

### Test Requirements
- **TR-35.1 rule:** Resolve CTA uses `resolveUrl` from row data. Evidence: JSX.

---

## Task 36 (Module 1): Frontend pattern fidelity audit
**Status:** pending  
**Priority:** high  
**Depends on:** T34, T15, T25

### Implementation
- Confirm no new permission keys introduced; Permissions enum identical.
- Confirm all admin/bursary pages wrapped in PortalShell, use useAuth/hasPermission pattern.
- Confirm AuthContext merge order preserved.

### Test Requirements
- **TR-36.1 rule:** No new keys in Permissions enum. Evidence: diff enum.
- **TR-36.2 rule:** All protected pages use `<PortalShell>` + hasPermission. Evidence: routes list.

---

## Task 37 (Module 1, QA): curl /bursary/reconciliation/summary validates all numbers
**Status:** pending  
**Priority:** high  
**Depends on:** T32

### Implementation
- Seed database with 7 days of sample transactions/settlements + 3 exceptions.
- Run curl → compare expected.

### Test Requirements
- **TR-37.1 rule:** Summary numbers match seeded aggregates exactly. Evidence: curl output vs seeded SQL sum.

---

## Task 38: Full Pipeline Verification (python-style /tmp/verify_full_pipeline.py logic)
**Status:** pending  
**Priority:** high  
**Depends on:** ALL

### Implementation
- Execute sequentially:
  1. `tsc --strict --noEmit` both dirs.
  2. Prisma validate + seed check.
  3. Start backend (port 3001), start frontend (port 3000) if possible in dev.
  4. Curl login (preserved admin, fresh student with mustChangePassword) → AC-3/4/5.
  5. Curl DELETE gates → AC-6/7/8/9.
  6. Upload 10k-row synthetic CSV (or smaller with same logic) → verify non-blocking + counts.
  7. Verify Logger / Queue configuration code paths.
  8. Curl reconciliation summary → AC-17.
  9. Frontend routing / gating smoke.

- Record every AC evidence in review.md.

### Test Requirements
- **TR-38.1 rule:** Every `rule`-type AC has passing evidence; every `rubric` AC scored ≥ threshold. Evidence: task evidence entries + review.md result.
