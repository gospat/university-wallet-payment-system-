# Portal Audit & Enhancement Roadmap

This document audits the current University Wallet Payment System portal, identifies improvement areas, and defines a target architecture and delivery roadmap (including security, UI/UX, testing, monitoring, deployment, and maintenance).

## 0) Enhancements Implemented (This Iteration)

**Backend**
- Strict environment validation at boot (required secrets, encryption key format)
- Zod request validation middleware applied across auth, wallet, admin, bursary routes
- Safer auth responses (never return password hashes)
- Deposit initiation idempotency (requires `Idempotency-Key` header) + race-safe verification
- Stronger audit logging for auth, deposits, transfers, withdrawals, and bursary actions
- Differential rate limiting for auth and payment endpoints + stricter CORS allowlist
- Health/readiness endpoints and Prometheus-style metrics endpoint (optional token protection)

**Frontend**
- Accessible modal improvements (ESC to close, click overlay to close, ARIA dialog semantics, focus management)
- Consistent portal navbar component used across Student/Admin/Bursary dashboards
- Student deposit calls include `Idempotency-Key` to match the hardened API
- Admin “Add Student” modal supports academic fields (college/department/program)

## 1) Current Architecture (As-Is)

**Repository layout**
- **Backend API**: `api/` (Node.js + Express + TypeScript, Prisma ORM, MySQL, Paystack integration, Puppeteer for PDFs)
- **Frontend**: `app/` (React + Vite + TypeScript, TailwindCSS, role-based portals)

**Backend modules**
- Bootstrap: `api/src/server.ts`, `api/src/app.ts`
- Routes: `api/src/routes/*`
  - `auth.ts` (signup/login)
  - `wallet.ts` (balance, transactions, deposits/verify, transfers, withdrawals, statement/receipt, Paystack webhook)
  - `admin.ts` (stats, student management)
  - `bursary.ts` (withdrawal approvals)
- Controllers: `api/src/controllers/*`
- Services: `api/src/services/*`
  - `auth.ts` (JWT issuance and password verification)
  - `wallet.ts` (wallet operations + Paystack initiate/verify)
  - `paystack.ts` (Paystack initialize/verify calls + fee breakdown)
  - `ledger.ts` (atomic wallet ledger + balance updates)
  - `receipt.ts` (PDF receipt + statement generation)
- Middleware: `api/src/middlewares/*` (auth + error handling)
- Data model: `api/prisma/schema.prisma` (User, Wallet, Transaction, WalletLedger, AuditLog)

**Frontend portals**
- Student: `app/src/pages/student/Dashboard.tsx`
- Admin: `app/src/pages/admin/Dashboard.tsx`
- Bursary: `app/src/pages/bursary/Dashboard.tsx`
- Auth: `app/src/pages/auth/*Login.tsx`
- Shared: `app/src/components/*`, `app/src/context/AuthContext.tsx`, `app/src/services/api.ts`

## 2) Key Gaps & Improvement Areas

### A) Architecture & Maintainability
- Backend is a “modular monolith” (good for early stages), but responsibilities are mixed across controllers/services without a consistent validation + response contract layer.
- No explicit domain boundaries (Auth vs Wallet vs Admin/Bursary workflows), making it harder to scale into separate services later.

### B) API Design & Robustness
- Request validation is inconsistent (some endpoints accept arbitrary body shapes).
- Error and response formats are not fully standardized for predictable frontend consumption.

### C) Payment Safety & Consistency
- Need explicit **idempotency keys** for payment initiation to prevent duplicate Paystack sessions/charges when users double-click or retry.
- Need stronger **transaction lifecycle** tracking (PENDING → SUCCESS/FAILED) with deterministic, race-safe updates and ledger uniqueness rules.
- Need audit logs for all sensitive actions (login, student creation, deposit initiation/verification, bursary approvals).

### D) Security Hardening
- Env/config should be validated at startup (no insecure fallbacks for secrets).
- Add tighter input validation, stricter auth protections, and differential rate limiting (auth vs payment vs general).
- Add security testing protocols and baseline automated checks.

### E) UI/UX & Accessibility
- Portals are improving but still inconsistent in navigation patterns, layout structure, and accessibility behaviors (keyboard focus, dialog semantics).
- Need a unified portal shell, responsive standards, and accessibility compliance (WCAG-inspired).

### F) Testing, Monitoring, and Operations
- No automated testing suite for regressions.
- No health/readiness checks and limited structured observability.
- Deployment and maintenance procedures are not formally documented.

## 3) Target Architecture (To-Be)

### A) Recommended Architecture Strategy
**Phase 1 (Now): Modular Monolith**
- Keep one backend service, but enforce strict boundaries:
  - `domain/` logic (wallet, transactions, ledger, users)
  - `controllers/` for HTTP only
  - `middlewares/` for cross-cutting concerns (auth, validation, rate limiting, request IDs)
  - `services/` for integrations (Paystack, PDF)

**Phase 2: Microservices (When Scale Demands It)**
- Split into services behind an API gateway:
  - **auth-service**: login/signup, tokens, password resets
  - **wallet-service**: balances, ledger, transfers, withdrawals
  - **payment-service**: Paystack init/verify/webhooks, idempotency, transaction state machine
  - **reporting-service**: receipts/statements generation (Puppeteer worker queue)
  - **audit-service**: immutable audit event ingestion + storage
- Use message/event bus (BullMQ/Redis or Kafka later) for asynchronous workflows (PDF rendering, anomaly detection).

### B) API Design Best Practices
- Versioning: `/api/v1/*`
- Consistent response envelope:
  - `{ status: 'success', data, message? }`
  - `{ status: 'error', message, code?, details? }`
- Strong request validation (Zod schema per endpoint)
- Idempotency:
  - Require `Idempotency-Key` header for payment initiation and critical financial mutations

## 4) Security Framework (Best Practices + Compliance Notes)

### A) Penetration Testing Protocols (Process)
- Run automated checks:
  - Dependency vulnerability scan
  - Static lint for unsafe patterns
  - API fuzzing on auth/payment routes
- Manual test checklist:
  - Auth bypass attempts (role escalation, missing tokens)
  - Replay requests with same idempotency key
  - Rate limiting and brute force behavior
  - Broken object-level authorization tests (IDOR)

### B) SQL Injection & Input Validation
- Prisma prevents SQL injection by default when avoiding raw queries.
- Enforce validation (Zod) on all external input:
  - amount must be numeric and within bounds
  - strings have length limits and formats (email, matric, references)

### C) Rate Limiting & Abuse Prevention
- Strict rate limiting for:
  - auth/login
  - deposit initiation
  - verify endpoints
- Separate limits per route class to avoid harming normal app usage.

### D) PCI DSS Compliance (Practical Notes)
- This project relies on Paystack hosted payment flow, so card data should not touch your servers.
- Still required:
  - secure transport (HTTPS)
  - strong auth and access controls
  - logging and monitoring
  - least privilege and secret management
- A formal PCI DSS audit is separate from code changes; this roadmap aligns engineering practices toward compliance.

## 5) Product Roadmap (Priorities, Timelines, Metrics)

### Phase 0 (Immediate Stabilization) — 1–2 weeks
- Standardize validation and API responses
- Payment idempotency + race-safe verification
- Add audit logs for all sensitive actions
- Accessibility: dialog semantics + keyboard support

**Success metrics**
- 0 duplicate credits/debits from retried requests
- Reduced support issues on payment retries and verification
- All portals keyboard-operable for core actions

### Phase 1 (UX + Reliability) — 2–4 weeks
- Unified portal layout (navigation, consistent cards/tables)
- Responsive design improvements and UI consistency across roles
- Baseline automated tests (smoke + critical flows)
- Health/readiness endpoints and structured logs

**Success metrics**
- Reduced bounce rate from confusing navigation
- Test suite catches regressions in critical flows
- Faster debugging from structured logs

### Phase 2 (Scalability & Operations) — 1–2 months
- Background job queue for PDF generation and long-running tasks
- Monitoring/alerting for payment anomalies and security threats
- CI pipelines (lint + test + build) and safer deployments

**Success metrics**
- Stable response times during high load
- Alerting catches anomalies within minutes
- Deployment is reproducible and auditable

### Phase 3 (Microservices Evolution) — as needed
- Extract payment/reporting/audit into services
- Event-driven architecture and stronger compliance controls

## 6) Deployment Procedures (Baseline)

**Environment**
- Use `.env` via secret manager in production (never commit secrets)
- Ensure:
  - `DATABASE_URL` (MySQL)
  - `JWT_SECRET`
  - `ENCRYPTION_KEY`
  - `PAYSTACK_SECRET_KEY`
  - `CORS_ORIGIN`

**Build**
- Backend: `api` TypeScript build to `api/dist`
- Frontend: `app` Vite build to static assets

**Runtime**
- Run behind a reverse proxy (Nginx) with HTTPS
- Enable `trust proxy` if needed for correct IP logging and secure cookies

## 7) Maintenance Protocols

- Monthly dependency updates and vulnerability review
- Rotation policy for secrets (JWT, encryption key, Paystack)
- Regular database backups + restore drills
- Quarterly security review (auth, payments, rate limiting)
- Log retention and access review (audit logs are sensitive)
