# Spec: Targeted Student Billing by Matric Number

Version 1.0 · 2026-09-24 · Natural language: English

## Problem

The current system only supports global (or scope-narrowed: college, department, programme, level, student-type) Fee records that are visible to all students in a catalogue dropdown. There is no UX-first, matric-number-driven flow that lets the Bursary department or Admin directly "bill a particular student" — e.g., for backlog fees, SIWES re-sit, transcript fee, lab replacement fee, departmental fine, carry-over exam fee, or other individual charges.

The result today is:
- Bursary/Admin can technically create a STUDENT-targeted FeeAssignment via the generic 5-step Assignment Wizard, but the wizard accepts `targetStudentId` as a raw numeric `User.id` (not the matric number anyone in Bursary actually knows/uses). No matric-number search → no real usability.
- No Bursary-role Fees page exists at all in `app/src/pages/bursary/` (only Dashboard, Payments, Receipts, Refunds). Bursary staff literally have no screen to create a bill from their portal.
- After the assignment is created, the user must click a separate **Generate Invoices** action for the bill to become payable. If they forget that second click, the bill never becomes "effective" even though the assignment record exists in DB.
- No automatic email notification flows to the billed student, so they may never see the bill.
- The student fee catalogue (`/students/fees/catalogue`) returns **only** `Fee` rows that match the global/scope-narrowed WHERE clause — it does **not** surface directly-assigned FeeAssignment records. So even after an assignment + invoice generation, the student may not see the charge in the "pick from list" dropdown they use every day; they would have to find it buried on their Invoices page.

## Users

| Actor | Scope of work in this feature |
|---|---|
| BURSARY role | PRIMARY USER: Drives 90% of "bill a particular student" actions. Must have full page + forms inside the Bursary role shell at `/bursary/fees/*`. |
| ADMIN role | Secondary/super-user: Same capabilities as Bursary, via existing `/admin/fees?tab=assignments` + new direct "Bill a Student" shortcut form on that same page. |
| STUDENT role | Consumer of the feature: sees the targeted bill on My Invoices AND in the fee-payment dropdown, receives email, and can Pay Now normally. |

## Goals

1. A Bursary staff member can land on a Bursary Fees page, click **+ Bill a Student**, paste or type a **matriculation number** (not a numeric database id), select a Fee (or create an ad-hoc "Other Charge" fee inline), optionally override amount or deadline, and click **Assign Bill** once. That single click:
   - resolves the matric → active student id;
   - creates a `FeeAssignment` row with `assignmentType=STUDENT`;
   - **immediately and automatically** generates the student's invoice row;
   - writes an audit log row linking actor → assignment → invoice;
   - sends an email to the student announcing the new bill;
   - displays a success panel showing the newly-created invoice reference, amount, and due date, with a deep-link to view the invoice in Admin.
2. The billed student can log in → see the charge **both**:
   - at the TOP of their Fees payment dropdown (catalogue), above global fee catalogue entries, with a prominent badge (e.g. **DIRECT BILL** or **BURSARY**);
   - and in the My Invoices list with a clear source column.
3. The full lifecycle of a targeted bill is well defined in audit, receipts, and reconciliation. Every downstream record (invoice, transaction, receipt) links back to the FeeAssignment, and the source of every charge is visible to Admin and Bursary on every record view.

## Non-Goals

- **NO file upload / CSV bulk matric billing in this spec.** That's a separate future batch feature. This spec focuses on single-student, matric-driven, one-click effective bills.
- **NO changes to existing Prisma schema models.** FeeAssignment model, AssignmentTargetType.STUDENT, Fee, Invoice, AuditLog all already exist with the correct fields. Adding columns or tables is out of scope and blocked unless a blocking issue forces schema evolution (see Constraints below).
- **NO scope-narrowed assignment UI for PROGRAMME/DEPARTMENT/FACULTY/LEVEL/SESSION/STUDENT_TYPE in the new Bursary page.** Those continue to live in the generic 5-step wizard on Admin Fees → Assignments tab. Bursary's new page is **exclusively STUDENT target** because that's what user asked for.
- **NO refund UI changes.** Existing non-refund constraint continues to apply: refunds are out of scope per project rules.
- **NO new payment methods.** Standard Paystack/ALATPAY checkout paths are reused. Bill a Student only creates the Invoice (and the Invoice enables the existing initiate-payment flow).
- **NO brand new receipt template logic.** Receipts already invoice-link correctly. We only ensure the receipt PDF shows the assignment source metadata if the invoice originated from a STUDENT-targeted assignment.

## Functional Requirements

### FR-1 — Matric lookup + resolution contract
Backend exposes an authenticated (ADMIN|BURSARY only) resolver: `GET /students/matric/:matricNumber`. Returns the student profile preview (id, firstName, lastName, matricNumber, email, college, department, programme, level, accountStatus), OR HTTP 404 with a clear error when the matric does not exist, OR HTTP 400 if the student has `accountStatus !== ACTIVE` with a specific message. Frontend uses this resolver to autocomplete on blur and show a preview chip before bill creation.

### FR-2 — One-click targeted bill
- Endpoint: `POST /fee-assignments/student-bill` (ADMIN|BURSARY, new; NOT the generic `/`).
- Body schema:
  ```ts
  {
    matricNumber: string (required, min 3, max 50, trim)
    feeId: number | null (required OR adhoc fields provided)
    adhocCategoryCode: string (optional, enum FeeCategory codes, default 'OTHER')
    adhocFeeName: string (optional, min 3, max 160)
    adhocDescription: string (optional, max 1000)
    adhocAcademicSession: string (optional, e.g. 2025/2026 — fallback to SystemSettings or most-recent active session if blank)
    overrideAmount: number (optional, >0, precision 2, if absent uses fee.amount)
    overrideDeadline: ISO date string (optional, if absent uses fee.paymentDeadline or null)
    noteToStudent: string (optional, max 500 — inserted into email body)
  }
  ```
  Semantics:
  - If `feeId` is provided → use existing Fee. Validate `fee.isActive === true`, else 400.
  - Else if `adhocFeeName` + `overrideAmount` are both provided → create Fee on the fly (upsert via feeCode = `ADH-${Date.now()}` or similar), categorize as OTHER category (idempotent: if category missing, create OTHER). Fee is created with the bill-actor as createdBy.
  - Else validation error 400: "Either feeId or adhocFeeName with overrideAmount is required."
  - All ad-hoc fees get `isMandatory: true`, `isActive: true` immediately.
  - Call flow **inside a single Prisma $transaction**: (A) look up matric → studentId, (B) create Fee if ad-hoc, (C) create FeeAssignment assignmentType=STUDENT targetStudentId, (D) call InvoiceEngine.manualInvoice(studentId, feeId, overrideAmount, overrideDeadline, req), (E) write auditLog entries FEE_ASSIGNMENT_CREATED and INVOICE_BATCH (single invoice).
  - On tx success: enqueue (non-blocking, catch-swallowed to WARN log) email notification to the billed student.
  - Response: 201 `{ assignment, invoice: { id, invoiceNumber, amountDue, dueDate, status }, created: true|false, emailQueued: true|false, adhocFeeCreated: Fee | null }`

### FR-3 — Immediate invoice generation
No second "Generate Invoices" click needed for the new STUDENT-targeted shortcut endpoint. After the FeeAssignment row commits, the endpoint runs `InvoiceEngine.manualInvoice` in the same request before returning, ensuring the charge is payable immediately. If manualInvoice returns `created: false` (idempotent hit — the exact (student, fee, session) invoice already existed), the response clearly communicates that with status code still 200, created:false, no duplicate email.

### FR-4 — Student portal visibility (double surface)
1. **My Invoices list:** The GET `/students/invoices` endpoint already returns invoices scoped to auth'd student. We **add a join to the invoice.fee.assignments array** and expose a new response field on each row: `origin: 'CATALOGUE' | 'DIRECT_BILL' | 'UNKNOWN'`. DIRECT_BILL when the invoice's fee has any FeeAssignment assignmentType=STUDENT AND targetStudentId === student.id. This is purely a response projection (no DB write).
2. **Fee catalogue dropdown / GET `/students/fees/catalogue`:** The response array is appended with DIRECT_BILL rows that match this student (FeeAssignment.targetStudentId === me.id, isActive=true, fee.isActive=true). Each DIRECT_BILL projected row exposes: badge='DIRECT BILL', note field populated from assignment-level metadata, amount = overrideAmount ?? fee.amount, deadline = overrideDeadline ?? fee.paymentDeadline. Duplicates are deduplicated by feeId (global catalogue fee already present → replace catalogue row with the DIRECT_BILL pinned row at top, so student sees the correct override amount not the generic catalogue amount). Pinned DIRECT_BILL rows are sorted to the top of the catalogue array, before any global fees.

### FR-5 — Bursary role Fees page
Create `app/src/pages/bursary/Fees.tsx` mounted at `/bursary/fees/:tab?`. Exactly two tabs:
  - Tab **My Bills (Assigned)** → paginated list of FeeAssignment rows WHERE assignedById = auth'd bursary id OR (broader: all assignmentType=STUDENT rows, permissioned). Columns: Created At, Matric Number, Student Name, Fee Name, Amount (with ⚠️ override pill if overrideAmount set), Deadline, Status, Invoice Ref, Invoice Status, Actions (Send reminder, View Invoice PDF, Download Receipt once paid, Mark void/Revoke — restricted per permissions).
  - Tab **+ Bill a Student** → direct form, single-step, no wizard. Form fields:
    - Matric Number (text, blur-triggered FR-1 resolver; shows preview chip with name/level on success; red inline error if invalid). Required.
    - Fee dropdown (select from active fees) OR "Create ad-hoc charge" toggle switch → reveals Ad-hoc fields: Charge name, Amount (NGN), optional Description, optional Academic Session.
    - Override amount field (number, NG₦ formatter; shown only if an existing Fee is selected AND user clicks "Change amount").
    - Override deadline (date input).
    - Note to student (textarea max 500 chars; shown in email).
    - Submit button: **Assign Bill — Notify Student**.
  - After successful submit, show a success panel with invoice number, amount, due date, and a link to View Invoice. On click of View Invoice, navigate to Student Invoice admin detail view in a new tab or modal preview.

### FR-6 — Admin Fees page + matric-targeted shortcut
Existing Admin Fees page (`app/src/pages/admin/Fees.tsx`) already has the 5-step wizard on the Assignments tab. We ADD:
  - A prominent button on the Assignments tab header: **⚡ Bill a Student (Direct)** that opens a side modal reusing the same single-step form as FR-5 (no wizard, matric-only mode). DRY: extract the DirectBillForm component to `app/src/components/fees/DirectBillForm.tsx` and import in BOTH Admin Fees.tsx AND bursary/Fees.tsx. No duplication.
  - The existing generic 5-step wizard's step 2 STUDENT target continues to accept numeric user ID. We **improve it** to also accept a matric number in that same input: if the user types a non-numeric value, on blur we run the FR-1 resolver and swap in resolved `targetStudentId`. This way the generic wizard catches up and nobody needs to look up numeric IDs anywhere.
  - Admin `Fees.tsx` assignments list shows a new column "Matric / Target" that resolves STUDENT type assignments to targetStudent.matricNumber + name, and PROGRAMME/DEPARTMENT/etc to their respective string columns.

### FR-7 — Email notification
Single email template "New Direct Bill Assigned" (i18n keyed). Uses existing branding cascade (`brandingEnvOnly()` as called by services/email.ts). Email body includes:
  - Student first name greeting
  - Branded header (university logo + name)
  - Bold label "A new bill has been assigned to your matric number: XXX-XXXX"
  - Fee name, description (if any)
  - Amount NG₦ formatted
  - Due date (or No due date specified)
  - Optional "Note from Bursary:" block if noteToStudent populated
  - Deep-link CTA button to student portal Fee Payment screen (hostname env var, port preserved)
  - Footer block with university branding info + contact info from env
  Email sending is **fire-and-forget** outside the transaction. If send fails, log WARN and endpoint still returns 201 with `emailQueued:false` + a soft warning surfaced in UI. Bursary can later click "Send reminder" (FR-5 actions column) to re-send.

### FR-8 — Audit + receipts reconciliation
- Existing `writeAudit()` helper is reused. For each one-click bill create, at minimum 2 AuditLog entries: action=`FEE_ASSIGNMENT_CREATED` entityType=FeeAssignment entityId=assignment.id, newValue includes {matricNumber, studentId, feeId, adhocCreated:true/false, overrideAmount, overrideDeadline, notePresent}. Second entry: action=`INVOICE_GENERATED` entityType=INVOICE_BATCH entityId=invoiceId, newValue includes {assignmentId, invoiceNumber, amountDue, dueDate, created}.
- Receipt PDF generateFormalReceipt, generateReceipt: if invoice.feeId matches a FeeAssignment assignmentType=STUDENT targetStudentId === invoice.studentId, inject a new line near the fee-name row reading:
  `Charge source: Direct Bill (Bursary assignment #${assignmentId}) — Matric: ${matric}`.
  Visible on the PDF and on the verify-receipt public page (`/verify/:token`) metadata block.
- Reconciliation page filters (Admin / Bursary Payments): add a new optional filter chip "Charge source" with options All, Catalogue, Direct Bill. When Direct Bill selected: where.invoice.fee.assignments.some({assignmentType:STUDENT, targetStudentId:studentId}).

## Non-Functional Requirements

### NFR-1 — No duplication rule (load-bearing)
Per project rules (duplication rejection). Every repeated UI piece is extracted to a shared component:
  - `DirectBillForm.tsx` single component shared by Admin Fees sidebar modal + Bursary Fees page Tab 2.
  - Matric input autocomplete/resolver component → `MatricStudentInput.tsx` reusable.
  - Fee + assignment projection helpers (for DIRECT_BILL origin marking) → placed in `services/studentFee.ts` if backend; `adminFees.ts` if frontend.

### NFR-2 — Type-safety strictness
- tsc `api` and tsc `app` exit 0 before any task can be marked complete.
- Every Zod schema for new endpoints uses `.strict()` so unknown payload keys fail 400 cleanly.
- Any frontend fetches return typed response interfaces.

### NFR-3 — RBAC strictness
New endpoints (`POST /fee-assignments/student-bill`, `GET /students/matric/:matric`) are protected by `restrictTo(ADMIN, BURSARY)`. Unauthenticated requests → 401. STUDENT role calling → 403. Public access blocked entirely.

### NFR-4 — Idempotency (no double-bill by accident)
- `POST /fee-assignments/student-bill` accepts optional `Idempotency-Key: <string>` header. If present: first insert wins, repeat calls return the exact same assignment+invoice combo with `created:false`.
- `POST /fee-assignments/student-bill` also enforces uniqueness at business level even without header: if assignmentType=STUDENT targetStudentId and same feeId already exist (isActive=true), return existing assignment+existing invoice (still 200, still email sent if `noteToStudent` provided or force-remind flag). This prevents accidental double-billing the same student for same fee by same bursary clicking twice.

### NFR-5 — Performance
- Fee catalogue response (FR-4.2) remains under 300ms even with the additional DIRECT_BILL append. Use 1 additional prisma query (find FeeAssignments for me.id) instead of N+1; combine arrays in JS.
- Student invoices list (FR-4.1) origin projection runs in 1 additional Prisma query per page (join by invoiceIds → assignments), no N+1.

### NFR-6 — Observability (logs)
Every step of the one-click assignment (resolve matric, create assignment, create invoice, send email) logs at info level with structured fields (actorId, matric, studentId, feeId, assignmentId, invoiceId, emailStatus). Errors: log ERROR at each step before throwing/wraping in AppError.

### NFR-7 — Professional UI quality (rubric: 0-2, threshold ≥1.5)
- Bursary Fees page uses same component palette (PortalShell, tabs, data-table, modals, alerts, pills, formatters) used by Admin Fees page for visual consistency. No new design tokens or colours introduced.
- Form errors show inline red text under each field AND a top summary alert; success state shows a green panel with a copyable invoice number and direct actions; loading states are shown with spinners, not disabled buttons with no feedback.
- Matric resolver preview chip shows name, level, programme, and a ✔️ green badge when valid; red badge + error message when invalid. Spinner during fetch, not a stuck state.

### NFR-8 — Accessibility (rubric: 0-2, threshold ≥1.0)
All form inputs have `<label>` elements (not just placeholder text). Tab order is logical. Keyboard Enter submits the form. Colour alone does NOT convey status (badges also have text labels, e.g., "INVALID MATRIC" + red).

### NFR-9 — Test gates required before merge
- `tsc --noEmit api` → exit 0.
- `tsc --noEmit app` → exit 0.
- Jest existing 8 suites pass (8 suites, 0 new failures introduced). Idempotency-test CANCELLED→FAILED drift remains documented as pre-existing and is NOT re-opened here.
- New Jest test file: `targeted-billing.test.ts` with 4 rule tests: (1) matric resolver 404s invalid matric, (2) one-click endpoint creates FeeAssignment+Invoice for valid matric, (3) double-click same payload idempotently returns same invoice, (4) student catalogue endpoint returns DIRECT_BILL pinned rows after assignment.
- Manual E2E curl probes for all 4 paths above; recorded with HTTP 200/201 responses.
- Browser E2E snapshots from /bursary/fees showing Tab 2 form and success panel.

## Constraints, Assumptions, Dependencies

### Constraints
1. **Schema frozen.** No new Prisma columns/tables/enums. If we find a blocker we cannot work around, re-open with user BEFORE touching schema.prisma.
2. **Single-gateway-at-a-time rule continues.** New invoices inherit gateway from current activePaymentGateway SystemSettings row; no changes to payment initiation.
3. **Bursary role permission boundaries per existing routes.** Bursary can read/write students, read/write assignments, read receipts, issue reset-password. Bursary cannot permanently delete users. All new endpoints respect these.
4. **Secret management rules (from prior git audit).** No API keys/real credentials ever committed. Only .env.example files are tracked; templates use placeholder format.

### Assumptions
1. Matric numbers are case-insensitive unique identifiers. Lookup uses `WHERE matricNumber ILIKE LOWER(trim(input))` or Prisma mode insensitive + contains/equals.
2. Email sending uses existing SMTP or Resend configuration already configured in `services/email.ts` and env vars. If SMTP is down, email silently fails but bill creation succeeds per FR-7 non-blocking rule.
3. User (per earlier session selection) prefers that notifications are sent via email per Option A on the first question.
4. User (per "be effective immediately" requirement) chose Flow A semantics: assignment + invoice + email in one click. If this assumption is incorrect, user will mark it during spec approval and we amend.

### Dependencies
- `api/src/services/feeAssignment.ts` FeeAssignmentService + InvoiceEngine classes (already written, reused).
- `api/src/services/email.ts` existing template rendering with brandingEnvOnly.
- `api/src/services/studentFee.ts` StudentFeesService already implements most of /students/invoices and /schedule helpers; we add DIRECT_BILL projection.
- `app/src/components/PortalShell`, `Modal`, `ConfirmAction`, `FeeFormModal` components already in codebase; shared.

## Open Questions

None. Immediacy ambiguity was resolved architecturally per Assumption 4 above (one-click assignment+invoice+email). If user disagrees, this is corrected during Approve phase gate.

## Acceptance Criteria

**(rule)** AC-1 — Matric resolver exists and behaves per FR-1: ADMIN/BURSARY → GET /students/matric/:matric returns 200 preview (including id) for valid ACTIVE students, returns HTTP 404 + specific message for unknown matric, returns HTTP 400 + message for SUSPENDED/GRADUATED/WITHDRAWN students. STUDENT role calling → 403. Public → 401.

**(rule)** AC-2 — One-click endpoint exists: POST /fee-assignments/student-bill. Valid payload with matricNumber + feeId → (1) FeeAssignment row created (type=STUDENT, targetStudentId), (2) Invoice row created (status UNPAID studentId correct), (3) 2 AuditLog entries written, (4) email template render uses brandingEnvOnly, (5) response is 201 with all fields described in FR-2. Double POST same payload (or +Idempotency-Key header twice) returns 200 created:false same invoice. Ad-hoc fee flow (no feeId + adhocFeeName+amount) creates Fee in OTHER category before assignment+invoice.

**(rule)** AC-3 — Student invoices GET /students/invoices response includes `origin` field on each row. For a DIRECT_BILL (STUDENT-targeted assignment), the row has origin='DIRECT_BILL' and appears with that metadata in frontend student Fees page and My Invoices page.

**(rule)** AC-4 — Student fee catalogue GET /students/fees/catalogue includes DIRECT_BILL appended rows pinned SORTED to TOP. Deduplicated by feeId (if same fee exists both as global catalogue and direct bill, direct bill row with correct override amount wins and single row is returned). Each pinned row has badge property = 'DIRECT BILL'.

**(rule)** AC-5 — New Bursary Fees page exists at routes path /bursary/fees and displays Tab 1 (assigned bills list) + Tab 2 (Direct Bill form). Direct Bill form uses MatricStudentInput component; on blur of matric field it fetches FR-1 resolver and shows preview chip. Submit creates assignment + invoice + notifies student. Success panel shows copyable invoice reference and due date.

**(rule)** AC-6 — Admin Fees Assignments tab exposes the ⚡ Bill a Student (Direct) shortcut button that opens the same DirectBillForm modal. Generic wizard step 2 STUDENT target input now also accepts matric text, auto-resolves via FR-1, fills in targetStudentId silently (no raw numeric input forced). Admin Assignments list has a new Matric / Target column that renders STUDENT-type target matric + name.

**(rule)** AC-7 — Email send fires after one-click bill: subject includes the university name (from branding) + "New bill assigned to your student account". Body includes at minimum: matric number, fee name, NGN-formatted amount, due date or "No due date" message, noteToStudent if non-empty. Email footer includes university contact. Send failure does NOT break endpoint response.

**(rule)** AC-8 — Receipt PDF and public verify page show charge source when applicable: if the receipt's invoice is from STUDENT-type FeeAssignment, the receipt displays "Charge source: Direct Bill (Bursary assignment) — Matric: XXXX". Admin/Reconciliation filter includes the Charge source chip (All / Catalogue / Direct Bill) as described in FR-8.

**(rubric, scale 0-2, threshold ≥1.5)** NFR-AC-9 — Professional UI quality: (a) visual consistency with Admin Fees (PortalShell + tables + pills + same Tailwind tokens), (b) clear loading + error + success states, (c) matric resolver preview chip UX. Score 2 if all 3; 1 if 2/3; 0 if ≤1. Score recorded by implementer, independently re-checked at Review gate.

**(rubric, scale 0-2, threshold ≥1.5)** NFR-AC-10 — Type safety + no duplication. Check: (a) tsc api/app exit 0, (b) DirectBillForm single component reused by both Admin and Bursary pages, (c) MatricStudentInput component reused, (d) new Zod schemas .strict(). Score 2 if all 4; 1 if 3; 0 if ≤2.

**(rubric, scale 0-2, threshold ≥1.5)** NFR-AC-11 — Audit + visibility. Check: (a) 2 audit entries per bill, (b) reconciliation filter works (HTTP 200 with only direct bills when filter applied), (c) receipts charge-source line injected, (d) Matric/Target column in Admin list. Score 2 if all 4; 1 if 3; 0 if ≤2.
