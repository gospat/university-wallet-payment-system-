# Tasks: Targeted Student Billing by Matric Number

Derived from spec.md version 1.0 · 2026-09-24

Dependencies map: Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 frontend, Task 7 frontend (Task 6 & 7 can run concurrently on different modules after Task 5 backend gates) → Task 8 Jest tests + E2E curl probes → Task 9 browser E2E → Review.

- P = priority (H = High, M = Medium, L = Low)
- ACs = Acceptance Criteria covered (spec.md AC-1..AC-11)
- TRs = Task-local Test Requirements (rule or rubric, pass condition, evidence source)

---

## Task 1: Backend — Matric resolver endpoint + Zod schemas (FR-1, AC-1)

**Status:** pending
**Priority:** H
**ACs covered:** AC-1
**Files touched:** `api/src/routes/students.ts` (read existing matric route), `api/src/services/student.ts` (if resolver needs enhancement), `api/src/controllers/student.ts` (read existing), `api/src/i18n/en.ts` (new error messages)

### Description

Audit the existing `GET /students/matric/:matric` handler. According to the routes file the endpoint is documented (L5). Verify:
1. It works for ADMIN|BURSARY calls → returns 200 correct payload;
2. STUDENT role calls → returns 403 (if not, add `restrictTo`);
3. Suspended/graduated/withdrawn students → return HTTP 400 with clear message not 200;
4. Unknown matric → HTTP 404 with clear structured error.

If any of the 4 behaviours are missing → patch the handler.

Expose the returned fields exactly as FR-1 requires: `{id, firstName, lastName, matricNumber, email, college, department, programme, level, accountStatus}`. Make sure `programme` field is populated even if the internal column name is `program` (handle mapping).

### TRs

| TR | Type | Pass Condition | Evidence Source |
|---|---|---|---|
| T1-R1 | rule | curl GET `/students/matric/EXISTING-ACTIVE-MATRIC` (JWT ADMIN) → HTTP 200, payload.id is a positive int, payload includes all 10 fields listed in FR-1 | curl trace |
| T1-R2 | rule | curl GET `/students/matric/NO-SUCH-MATRIC` → HTTP 404, error message references matric number | curl trace |
| T1-R3 | rule | curl GET `/students/matric/EXISTING-SUSPENDED-MATRIC` (prepare a SUSPENDED student via test data or PATCH accountStatus) → HTTP 400 + message "Student account is not active" (or similar) | curl trace |
| T1-R4 | rule | curl GET `/students/matric/ANY-MATRIC` with STUDENT JWT token → HTTP 403 Forbidden | curl trace |
| T1-R5 | rule | curl GET `/students/matric/ANY-MATRIC` no JWT → HTTP 401 Unauthorized | curl trace |
| T1-R6 | rule | `cd api && npx tsc --noEmit` exit 0 after the task changes | tsc log |

### Completion Evidence
Fill after task: TR statuses + recorded evidence.

---

## Task 2: Backend — POST /fee-assignments/student-bill one-click endpoint (FR-2, FR-3, NFR-4, AC-2)

**Status:** pending
**Priority:** H
**ACs covered:** AC-2
**Files touched:** `api/src/routes/feeAssignments.ts` (add route + Idempotency-Key middleware), `api/src/controllers/feeAssignments.ts` (new controller `createStudentBillOneClick`), `api/src/services/feeAssignment.ts` (call InvoiceEngine.manualInvoice; add helper for ad-hoc fee creation; idempotency guards), `api/src/services/fee.ts` (if needed — OTHER category ensure or upsert helper; use existing `FeeCategoryService.seed()` logic), `api/src/i18n/en.ts` (new error/audit i18n keys)

### Description

1. Add Zod schema `CreateStudentBillOneClickSchema` (strict, FR-2 body fields). Use `.refine()` to guarantee `feeId XOR (adhocFeeName AND overrideAmount)` invariant.

2. Controller `createStudentBillOneClick` inside a single Prisma `$transaction`:
   a. trim + lookup matric via same resolver logic as Task 1; if not active → 400.
   b. if feeId given → verify fee exists + isActive → 400 otherwise.
   c. else adhoc → ensure OTHER FeeCategory (upsert by code 'OTHER'), create Fee row with code = `ADH-${timestamp64}-${studentMatricSuffix}` to avoid collisions; amount = overrideAmount; categoryId = OTHER; createdBy = req.user.id; academicSession → use adhocAcademicSession if provided else fallback to most-recent active fee row session OR literal fallback '2026/2027' if DB empty.
   d. create FeeAssignment assignmentType=STUDENT, targetStudentId=student.id, assignedById=req.user.id, overrideAmount/overrideDeadline only if different from Fee defaults (compare numerically), isActive=true.
   e. call `InvoiceEngine.manualInvoice({feeId, studentId, overrideAmount?, overrideDeadline?}, req)` within same tx — returns `{invoice, created:boolean}`.
   f. write auditLogs entries for assignment creation + invoice generation.
   g. commit transaction.
   h. outside tx: fire-and-forget Task 7 email send (call `EmailService.sendStudentBillAssigned(student, fee, invoice, assignment, noteToStudent?) || Promise.resolve()`; wrap in try/catch logging WARN on failure). Set emailQueued=true/false in response based on whether call resolved without throw.
   i. Idempotency: optional `req.headers['idempotency-key']` check: if present and we already stored an idempotency record OR we check existing FeeAssignment of same (targetStudentId, feeId, active) and same actor, return existing rows + created:false (header or business idempotency both work; business idempotency is mandatory per NFR-4 even if header absent).

3. Mount the route on feeAssignments router with `router.post('/student-bill', protect, restrictTo('ADMIN', 'BURSARY'), ...)`.

### TRs

| TR | Type | Pass Condition | Evidence Source |
|---|---|---|---|
| T2-R1 | rule | POST `/fee-assignments/student-bill` body {matricNumber, feeId} ADMIN JWT → HTTP 201 + body contains {assignment, invoice, created:true, emailQueued:boolean, adhocFeeCreated:null}. DB FeeAssignment row exists assignmentType=STUDENT targetStudentId matches. DB Invoice row exists with correct studentId, feeId, amountDue. | curl + prisma raw SELECT |
| T2-R2 | rule | Double POST same body (same matric + same feeId, no idempotency key) → HTTP 200 + body.created=false + same assignment/invoice IDs as first call. No duplicate FeeAssignment, no duplicate Invoice rows created. | curl 2x + prisma SELECT count(*) = 1 |
| T2-R3 | rule | POST with Idempotency-Key header + same payload twice → second call returns created:false same invoice | curl with header |
| T2-R4 | rule | Ad-hoc mode: no feeId, body has adhocFeeName, overrideAmount. Response 201 with adhocFeeCreated non-null (fee.category.code='OTHER'). Invoice created with same overrideAmount. | curl + prisma SELECT fee JOIN category |
| T2-R5 | rule | Ad-hoc mode missing overrideAmount → HTTP 400. Missing adhocFeeName + no feeId → HTTP 400. Both feeId AND adhocFeeName → HTTP 400. | curl 3 tests |
| T2-R6 | rule | STUDENT JWT trying the POST → HTTP 403. No JWT → 401. | curl 2 tests |
| T2-R7 | rule | POST with invalid matric → HTTP 400 or 404 structured error, matches behaviour from Task 1. | curl |
| T2-R8 | rule | `cd api && npx tsc --noEmit` exit 0. | tsc log |

---

## Task 3: Backend — Student invoices/catalogue DIRECT_BILL projection (FR-4, AC-3, AC-4, NFR-5)

**Status:** pending
**Priority:** H
**ACs covered:** AC-3, AC-4
**Files touched:** `api/src/routes/students.ts` (L70 invoices list lambda; L112-215 GET fees/catalogue lambda, modify to append DIRECT_BILL rows as per FR-4.2)

### Description

1. **/students/invoices** (FR-4.1): For each returned invoice row, add `origin` field. Algorithm: collect invoiceIds on page, query `Invoice[] → each.feeId`. Batch fetch all FeeAssignments where `feeId IN (set) AND isActive=true AND assignmentType=STUDENT`. Build map keyed by `${feeId}` pointing to array of targetStudentId. For invoice ∈ current page: `if (map.get(invoice.feeId)?.includes(invoice.studentId)) origin='DIRECT_BILL' else if invoice.id exists origin='CATALOGUE' (student chose to pay a global fee via ensure-invoice auto-create)`. Default if unknown → 'UNKNOWN'. Attach as `origin` string literal on every invoice row returned by GET /students/invoices and GET /students/invoices/:id detail.

2. **/students/fees/catalogue** (FR-4.2): 
   a. Run existing query as-is (get global/scoped fees).
   b. Run **ONE extra prisma query**: `FeeAssignment findMany({ where: { assignmentType: 'STUDENT', targetStudentId: me.id, isActive: true, fee: { isActive: true } }, include: { fee: { include: { category: true } } } })`.
   c. For each direct assignment: build a CatalogueFee row using overrideAmount ?? fee.amount, overrideDeadline ?? fee.paymentDeadline. Set a new optional response field `badge` = 'DIRECT BILL' + `assignmentId` + `note` = (if available, metadata).
   d. **Dedup by feeId**: walk the result arrays; if a feeId exists both in global catalogue AND in direct-bill list, REMOVE it from catalogue list and keep the DIRECT BILL variant (so override amounts win).
   e. **Sort to top**: concatenate `[...directBillRowsUnique, ...remainingCatalogueFiltered]`.
   f. Return in existing shape (fees array + total = combined).

### TRs

| TR | Type | Pass Condition | Evidence Source |
|---|---|---|---|
| T3-R1 | rule | After running Task 2 T2-R1 (created 1 direct bill for Student id=3). curl GET /students/invoices STUDENT id=3 JWT → HTTP 200, rows array includes the new invoice AND its `origin === 'DIRECT_BILL'`. | curl + JSON check jq .data.invoices[].origin or grep |
| T3-R2 | rule | curl GET /students/invoices/:id for that same invoice → detail response includes `origin === 'DIRECT_BILL'` | curl |
| T3-R3 | rule | curl GET /students/fees/catalogue for same student → first element(s) in response.fees array are the DIRECT_BILL rows (pinned to top); they have amount = overrideAmount if set else fee.amount; they have badge = 'DIRECT BILL' property. | curl JSON inspection |
| T3-R4 | rule | Dedup: if a global Fee has college=NULL (visible to everyone) AND same feeId was also directly assigned to the student → catalogue returns EXACTLY ONE row for that feeId, the direct bill row, with correct overrideAmount. Global catalogue variant removed. (To test: create fee scope all, assign to same student manually with override; call catalogue → count occurrences of feeId == 1.) | curl + count feeId occurrences |
| T3-R5 | rule | Performance: response time < 500 ms on both endpoints (measure with curl -w "%{time_total}s"). | curl -w timings |
| T3-R6 | rule | `cd api && npx tsc --noEmit` exit 0 | tsc log |

---

## Task 4: Backend — Email template, audit keys (FR-7, AC-7)

**Status:** pending
**Priority:** H
**ACs covered:** AC-7
**Files touched:** `api/src/services/email.ts` (add `sendStudentBillAssigned` function), `api/src/i18n/en.ts` (add email subject/body i18n keys)

### Description

Implement function `EmailService.sendStudentBillAssigned(student: User, fee: Fee, invoice: Invoice, assignment?: FeeAssignment, noteToStudent?: string): Promise<boolean>` returning `true` if queued, `false` if failed (never throw). Use existing brandingEnvOnly for header/footer branding. Send HTML email + plaintext multipart. HTML template:

```
[branding header image/logo]
Hi {firstName},

A new bill has been assigned to your matric number: **{matricNumber}**

**Bill details**
{fee.name}
{fee.description if any}
Amount: **NGN {amountDue formatted en-NG}**
Due: {dueDate ?? "No due date specified"}
Invoice reference: {invoice.invoiceNumber}
[optional block if noteToStudent]
**Note from Bursary**
> {noteToStudent}
[/optional]

[BIG CTA BUTTON] Pay this bill → {studentPortalUrl}/student/fees?invoiceId={invoiceId}

If you have any questions please contact the Bursary Department directly at {bursaryEmail ?? universityEmail from branding}.

— {branding.name} Finance Office
[footer branding address]
```

Use existing `sgMail` or SMTP as configured. Do NOT throw on failure. Swallow and log WARN per FR-7 non-blocking rule. The function is called from Task 2 controller response after commit.

### TRs

| TR | Type | Pass Condition | Evidence Source |
|---|---|---|---|
| T4-R1 | rule | When Task 2 runs AND mail transport valid (use mock or real), stdout/logs shows INFO log line for email send attempt with to=student email, invoice number. If using real: student email receives the message (manual verify or API log); if mock: mock gets HTML with {matricNumber} + amountDue + CTA URL fragments present. | Log grep + optional email mock capture |
| T4-R2 | rule | Email body note from bursary block only rendered if noteToStudent.length>0. Else absent from HTML. | HTML email capture inspection |
| T4-R3 | rule | Transport throw simulated (stub sgMail to throw): function returns false, catches error internally, WARN log written. Endpoint still returns 201 HTTP with emailQueued=false; response not broken. | curl + log grep WARN |
| T4-R4 | rule | tsc api exit 0. | tsc log |

---

## Task 5: Backend — Receipts + Reconciliation charge source filter (FR-8, AC-8)

**Status:** pending
**Priority:** M
**ACs covered:** AC-8
**Files touched:** `api/src/services/receipt.ts` (add assignment metadata injection), `api/src/routes/reconciliation.ts` (if filters defined) or `api/src/services/reconciliation.ts` (L46-527), public verify receipt route (if exists add charge source in metadata block)

### Description

1. **Receipt generator functions** (3 generators parity, like branding): before rendering, for receipt.invoice → if invoice exists: run a query `FeeAssignment findFirst({ where: { feeId: invoice.feeId, assignmentType: 'STUDENT', targetStudentId: invoice.studentId, isActive: true } })`. If matched: add parameter `chargeSourceHtml` to templates. Define a pure helper `chargeSourceHtml(studentMatric, assignmentId)` returning a 1-line div `<div class="charge-source">Charge source: Direct Bill (Bursary assignment #N) — Matric: {matric}</div>`. Insert this line into fee-name section of template (right below Fee Name / Amount row — same insertion on all 3 generators). Add CSS class `.charge-source` of text-xs text-slate-500 italic.

2. **Public verify page metadata block** (if public verify exists, usually /receipts/verify/:token): ensure `chargeSource` appears in the same way.

3. **Reconciliation filter**: on Admin/Payments list (GET /admin/payments OR reconciliation endpoint L46-295), add a new query parameter `chargeSource?: 'ALL' | 'CATALOGUE' | 'DIRECT_BILL'`. Default ALL. If DIRECT_BILL: WHERE-clause extend `invoice: { fee: { assignments: { some: { assignmentType: STUDENT, targetStudentId: { equals: userId? NO — equals: the $transaction's userId (student owner of the invoice) } } } }`. In other words, join across `Transaction → invoice → fee → assignments.some(STUDENT type AND targetStudent=transaction.user.id)`. Implementation: use `Prisma.TransactionWhereInput` with deep `some` traversal, or compute an `invoiceId list` via subquery 1 step: `get invoiceIds from direct bill assignments where targetStudentId == userId` → then where.invoiceId IN list; since Admin Payments already has studentId optional filter, combine both.

### TRs

| TR | Type | Pass Condition | Evidence Source |
|---|---|---|---|
| T5-R1 | rule | Generate PDF for an invoice that has STUDENT direct-bill assignment. HTML capture (via receipt probe) shows: text "Charge source: Direct Bill (Bursary assignment)" present and includes matric number and assignment N. | HTML capture probe same method as branding signature verification (L grep 3 keywords pass) |
| T5-R2 | rule | Generate PDF for regular catalogue invoice (no DIRECT_BILL): charge-source line ABSENT. | HTML capture probe keyword count = 0 |
| T5-R3 | rule | Reconciliation GET endpoint with chargeSource=DIRECT_BILL → HTTP 200, returns ONLY transactions from direct-bill invoices; compare count vs chargeSource=ALL (should be subset). | curl + count rows |
| T5-R4 | rule | tsc api exit 0. | tsc log |

---

## Task 6: Frontend — Bursary Fees page (FR-5, AC-5) + shared DirectBillForm + MatricStudentInput (NFR-1 dedup)

**Status:** pending
**Priority:** H
**ACs covered:** AC-5 (primary), AC-10 indirectly (shared components)
**Files touched:**
- NEW `app/src/components/fees/MatricStudentInput.tsx`
- NEW `app/src/components/fees/DirectBillForm.tsx`
- NEW `app/src/pages/bursary/Fees.tsx`
- MODIFY `app/src/App.tsx` (add route /bursary/fees + Bursary role nav menu entry linking to it)
- MODIFY `app/src/services/adminFees.ts` (add api call for POST /fee-assignments/student-bill + GET /students/matric/:matric; add type CreateStudentBillInput, StudentBillSuccessResp)
- MODIFY `app/src/i18n/en.ts` (add bursary.fees.* i18n labels, buttons, error messages)

### Description

#### 6.1 MatricStudentInput shared component
`<MatricStudentInput value onChange onResolved onError loading>`.
- Text input + blur resolver.
- On blur or Enter pressed → GET /students/matric/:trimValue.
- On success: show green chip component ✔ Matched: `Adaeze N. (200L, B.Sc. CS, BUS/23/0421)` with small student headshot placeholder circle initials AN if no avatar. Fire `onResolved({id, firstName, lastName, matricNumber, level, programme, email})`.
- On 404 or 400 (account inactive): show red chip + message, `onError(error message)`.
- Spinner while fetching. No visual stuck state.
- Accept optional initial value (for edit forms — future-proof).

#### 6.2 DirectBillForm shared component
Props: `actorRole: 'ADMIN' | 'BURSARY'`, onSuccess?: (resp: StudentBillSuccessResp) => void, className?, initialFeeId?
- Form sections: (a) Matric Number (MatricStudentInput → stores selectedStudentId in local state), (b) Fee picker ("Use existing fee" toggle on) → select dropdown from listFees or "Ad-hoc charge" toggle → reveal (name, description, session, amount). (c) Override amount only if existing fee. (d) Deadline date optional. (e) Note to student (textarea max 500 chars w/ counter).
- Submit button label: **Assign Bill — Notify Student**
- When submit → call `feeApi.createStudentBillOneClick(payload)`.
- Show loading spinner during submission, disable form + button.
- On success → green success panel: "Invoice created · INV-XXXX" + amount formatted + due date + 2 buttons: "View Invoice PDF" (open new tab admin download receipt pdf for invoice — if unpaid show payment page for it → deep link /student/fees?invoiceId= for Admin preview or /bursary/payments invoice filter), "Done / Reset form".
- On error → red alert with message at top, keep form state.

#### 6.3 Bursary Fees page
2 tabs: (1) Assigned bills, (2) Bill a Student.
- Tab 2 embeds `<DirectBillForm actorRole='BURSARY'>`.
- Tab 1 table: columns as FR-5. Actions: Send reminder (call new endpoint Task 8? or fire-and-forget email POST /fee-assignments/:id/remind-email — add lightweight endpoint for resend), View Invoice PDF (opens generateFormalReceipt by id admin route? use Admin proxy that lets bursary read any student's invoice), Download Receipt (if paid), Revoke / Mark void (use existing endpoints).
- Register route in App.tsx: `<Route path="/bursary/fees" element={<RequireRole role="BURSARY"><BursaryFeesPage/></RequireRole>} />` AND add a nav entry in Bursary portal shell's sidebar menu (see Dashboard/Payments/Receipts for existing menu items; add Fees with icon between Payments and Receipts matching Admin UI).

#### 6.4 App routing + nav
Find existing RequireRole wrapper and mount the page correctly. Make sure portal shell sidebar menu shows item Fees with counter? no counter needed.

### TRs

| TR | Type | Pass Condition | Evidence Source |
|---|---|---|---|
| T6-R1 | rule | Route /bursary/fees loads for BURSARY JWT, 403 redirected if STUDENT. Renders 2 tabs. | Integrated browser snapshot |
| T6-R2 | rule | Tab 2 form: Matric input → paste valid matric of active student, blur → green resolver chip with name/level shown. Invalid → red chip error. | Browser snapshot + visual |
| T6-R3 | rule | Form submit valid payload → success panel shown containing text "Invoice created" and alphanumeric INV reference AND copyable amount/dueDate. DB rows exist (verify via backend API call for invoice id). | Browser E2E snapshot |
| T6-R4 | rule | DirectBillForm.tsx imported once in BursaryFeesPage, exported, compiled. (Verify by importing same component later in Task 7 without re-writing.) | Code grep: DirectBillForm in 2 files with single implementation. |
| T6-R5 | rule | Tab 1 Assigned bills table loads: columns list populated with data from listAssignments backend. | Browser network request for /fee-assignments → HTTP 200; rows rendered. |
| T6-R6 | rule | tsc app exit 0. | tsc log |

---

## Task 7: Frontend — Admin Fees page Direct-Bill shortcut + wizard matric upgrade + assignments column (FR-6, AC-6)

**Status:** pending
**Priority:** H
**ACs covered:** AC-6, AC-10 dedup
**Files touched:**
- MODIFY `app/src/pages/admin/Fees.tsx` (import DirectBillForm, MatricStudentInput; add shortcut button ⚡ Bill a Student (Direct); improve step 2 STUDENT target; add new Matric/Target column to Assignments list)
- MODIFY `app/src/services/adminFees.ts` (if any new types needed for column payload)
- MODIFY `app/src/i18n/en.ts` (adminFees.assignments new labels)

### Description

1. **⚡ Shortcut button:** On Admin Fees.tsx Assignments tab header row (right side, next to the existing "+ Create Assignment" generic wizard button), add a new primary styled button `⚡ Bill a Student (Direct)`. Click opens a Modal containing `<DirectBillForm actorRole="ADMIN" onSuccess={(resp) => { closeModal(); toast.success('Bill assigned. Invoice ' + resp.invoice.invoiceNumber); refreshAssignments() } }>`. This directly reuses Task 6 component (no copy, deduped — requirement NFR-1 met).

2. **Generic Assignment Wizard Step 2 upgrade:** Existing `step === 2 && type.field === 'targetStudentId'` (Fees.tsx L378-379) currently uses a plain number input. Replace that input with our `<MatricStudentInput>` component: on `onResolved(student)`, call `set({ targetStudentId: student.id })` silently. For backwards compatibility if the user types a numeric id (old behaviour that still works if they paste user.id), detect numeric only and skip matric resolver + set directly (but show a small helper text "Tip: you can paste a matric number for auto-resolution").

3. **Assignments list column "Matric / Target":** In assignments list table header, insert a new column. Row cell renderer: if assignmentType=STUDENT AND assignment.targetStudent → render `assignment.targetStudent.matricNumber` + small secondary text `assignment.targetStudent.firstName lastName`. If another type, render the relevant string column (targetProgramme / targetDepartment / etc as previously visible). Adjust table layout, text wrap as needed; keep responsive.

### TRs

| TR | Type | Pass Condition | Evidence Source |
|---|---|---|---|
| T7-R1 | rule | Admin Fees page Assignments tab: button `⚡ Bill a Student (Direct)` visible. Click → Modal opens with DirectBillForm rendered (no code duplication from Bursary page). | Browser snapshot |
| T7-R2 | rule | Generic 5-step wizard → Type=Student → step 2 input is MatricStudentInput. Type a valid matric → blur → auto-fills targetStudentId correctly (visible because next button enables after). Number-only pasted still works without hitting resolver. | Browser snapshot of matric + numeric behaviours |
| T7-R3 | rule | Assignments list table → STUDENT-type rows show matric number AND student name in new Matric/Target column. | Browser snapshot + DOM inspection |
| T7-R4 | rule | tsc app exit 0. | tsc log |

### Frontend — Student portal DIRECT_BILL UI badges (AC-3, AC-4)

Tackled as Task 7.5 within the same task window, no concurrent writes.

#### Description

On Student portal `/student/fees` page (app/src/pages/student/Fees.tsx) + `/student/fees/checkout` + `/student/dashboard` My Invoices card:

- In Fees catalogue list: if a row has badge='DIRECT BILL', prepend a rose-50 or indigo-100 badge pill "DIRECT BILL" / "BURSARY ASSIGNED" to the row. Override amounts match server.
- In My Invoices list: if origin='DIRECT_BILL' → show blue pill "Direct Bill"; origin='CATALOGUE' → show grey pill "Catalogue" or no pill. Default UNKNOWN no pill.

#### TRs

| TR | Type | Pass Condition | Evidence Source |
|---|---|---|---|
| T7.5-R1 | rule | After Task 2 T2-R1 → student logs in → Fees page: top rows contain direct bill rows with badge "DIRECT BILL" or "BURSARY ASSIGNED" pill visible. Override amount matches overrideAmount set if any. | Browser snapshot / portal |
| T7.5-R2 | rule | My Invoices row for direct bill → blue Direct Bill pill present. Catalogue rows → grey or no pill. | Browser snapshot |
| T7.5-R3 | rule | tsc app exit 0. | tsc log |

---

## Task 8: Jest tests + curl E2E probes + idempotency guard verify batch (NFR-9 AC gates)

**Status:** pending
**Priority:** H
**ACs covered:** All rule ACs (AC-1..AC-8 + rubric evidence)
**Files touched:**
- NEW `api/src/__tests__/targeted-billing.test.ts`
- Optional: `api/src/__tests__/support/studentFixtures.ts` or inline test setup
- NO actual Jest test edits to existing test suites (no regressions)

### Description

Write 4 Jest rule tests exactly as described in NFR-9:

1. **Test 1: Matric resolver AC-1.** Create a known ACTIVE student via prisma in beforeAll. GET /students/matric/:that → 200 profile; unknown matric → 404; change accountStatus to SUSPENDED → 400; STUDENT role token → 403.

2. **Test 2: One-click bill AC-2 happy path (feeId).** POST valid payload → 201. Assert DB: 1 FeeAssignment (student type + targetStudentId), 1 Invoice (UNPAID, amount=fee.amount or overrideAmount), AuditLog entries = 2 (search by action FEE_ASSIGNMENT_CREATED and INVOICE_GENERATED with entityIds correct).

3. **Test 3: Idempotency AC-2.** Call Test2 payload twice → second call returns created:false, assignmentId matches, Invoice.id matches. count(Invoice WHERE ...) = 1 count(Assignment WHERE ...) = 1. Also with Idempotency-Key header.

4. **Test 4: Student catalogue AC-4 DIRECT_BILL pinned rows.** After Test 2 assignment exists → call GET /students/fees/catalogue as student JWT. Assert fees[0] (first element) corresponds to the assigned fee. If overrideAmount used in Test 2 → amount in response equals overrideAmount (not default fee amount).

Run Jest targeted test file first. If passing → run the 8-suite full gate to ensure no regressions.

Additionally, perform and record 3 curl commands against running dev servers:
- a) POST student bill (Task 2) → HTTP 201 with all required fields.
- b) GET /students/invoices with origin=DIRECT_BILL visible.
- c) GET /students/fees/catalogue pinned direct bill.

### TRs

| TR | Type | Pass Condition | Evidence Source |
|---|---|---|---|
| T8-R1 | rule | Jest `api/src/__tests__/targeted-billing.test.ts` runs with NODE_ENV=test, all 4 describe blocks → pass (4 green). | Jest output terminal snippet |
| T8-R2 | rule | Existing 8-suite gate → 133+ pass, any failing ≤ pre-existing 1 idempotency drift, 0 new failures. | Jest output summary |
| T8-R3 | rule | curl 3 probes recorded HTTP 200/201 with fields as specified. | Terminal log / curl trace file |
| T8-R4 | rule | tsc api exit 0. tsc app exit 0. | tsc logs |

---

## Task 9: Browser E2E visual + interaction snapshots

**Status:** pending
**Priority:** M
**ACs covered:** AC-5, AC-6, NFR-7 UI quality rubric, NFR-8 accessibility
**Files touched:** none / IDE snapshots
Implementation: Use Integrated Browser tool →:
1. Login as Bursary → navigate /bursary/fees → confirm Tab 1 loads, Tab 2 opens DirectBillForm.
2. Fill the DirectBillForm with existing active student's matric → blur → green chip. Submit form. Confirm success panel shows invoice number.
3. Navigate to Admin Fees → click ⚡ Bill a Student (Direct). Same form loaded inside Modal. Close.
4. Navigate to Admin → Students → create or update a student as SUSPENDED. Then try Bursary bill form for that matric → blur shows red inactive error.
5. Login as that billed Student → navigate Student Fees → first row is DIRECT BILL badge. Go to My Invoices → Direct Bill pill visible.

### TRs

| TR | Type | Pass Condition | Evidence Source |
|---|---|---|---|
| T9-R1 | rule | 5 E2E scenarios above all perform to expected. No console ERRORS in browser console (only warnings ok). | Browser E2E snapshot for each scenario 1-5 captured |
| T9-R2 | rubric 0-2, threshold ≥1.5 | UI quality NFR-7: Bursary Fees visual consistent with Admin Fees; form shows loading/error/success states correctly; matric preview chip works. Score 0-2, record rationale + screenshots. | Review checklist |
| T9-R3 | rubric 0-2, threshold ≥1.0 | Accessibility: each input has associated visible label (audit DOM for `<label for>` or aria-labelledby); tab order logical; Enter submits form; colour never sole indicator (badges have text label). Score = count/2. | DOM inspection + accessibility manual check |

---

## Task 10: Write-up evidence collection → independent review

**Status:** pending
**Priority:** H
Description:
- All tasks completed, all TRs evidenced.
- Update tasks.md each task's Completion Evidence sections with TR pass statuses + evidence refs.
- Tsc api + tsc app exit 0 one final time.
- Jest 8 suites one final time.
- Summarize AC coverage.
- Proceed to Review gate (independent reviewer writes review.md per spec mode rules).

**ACs 9,10,11 rubric threshold results finalised.**
