# Branding, University Logo/Favicon, and Bursar Receipt Signature - Implementation Plan

## Task 1: Add 4 new SystemSettings DB columns and sync types
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - Edit `api/prisma/schema.prisma` SystemSettings model and add 4 columns:
    - `universityFaviconUrl String? @db.VarChar(500)`
    - `receiptBursarName String? @db.VarChar(190)`
    - `receiptBursarTitle String? @db.VarChar(190)`
    - `receiptBursarSignatureUrl String? @db.VarChar(500)`
  - Keep existing columns untouched (frozen Jest schema).
  - Run `cd api && npx prisma db push --accept-data-loss --schema=prisma/schema.prisma && npx prisma generate`.
  - Update `api/src/services/systemSettings.ts` SEED_DATA to include the 4 new nullable fields all seeded `null` (no default). Update `validateActivePaymentGatewayValue` untouched.
- **Acceptance Criteria Addressed**: AC-1, AC-7 (schema compatible with frozen tests)
- **Test Requirements**:
  - `rule` TR-1.1: `npx prisma db push` exit 0; `npx prisma generate` exit 0. Evidence: command output capture.
  - `rule` TR-1.2: `tsc api` exit 0. Evidence: exit code 0.
  - `rule` TR-1.3: Grep generated Prisma client type includes `universityFaviconUrl?: string | null` + 3 others. Evidence: grep hits > 0 in generated `index.d.ts` or client.

## Task 2: Authoritative branding utility (buildBranding + brandingEnvOnly)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - Create `api/src/utils/branding.ts`.
  - Define type `Branding` (name, logoUrl, faviconUrl, address, phone, email, website, bankName, bankAccount, bursarName, bursarTitle, bursarSignatureUrl, receiptFooterText, receiptPrefix, paymentRefPrefix).
  - Export `brandingEnvOnly(): Branding` (pure env + defaults, no DB, safe anywhere).
  - Export `async buildBranding(): Promise<Branding>` that calls `SystemSettingsService.get()` first, then per-field cascade: `row.field ?? process.env.UNIVERSITY_FIELD ?? envDefault` (faviconUrl maps to `process.env.UNIVERSITY_FAVICON_URL`; bursar fields map to `RECEIPT_BURSAR_NAME`, `RECEIPT_BURSAR_TITLE`, `RECEIPT_BURSAR_SIGNATURE_URL`).
  - Export helper `universityEmailSenderDomain()` to avoid duplication (use `brandingEnvOnly` for email.ts boot-time).
- **Acceptance Criteria Addressed**: AC-2, AC-3, AC-7
- **Test Requirements**:
  - `rule` TR-2.1: Standalone probe `await buildBranding()` with SEED + env overrides returns merged object matching cascade logic. Evidence: node -e console.log of specific known fields.
  - `rule` TR-2.2: `tsc api` exit 0.
  - `rule` TR-2.3: `rg "UNIVERSITY_NAME\s*\|\|" api/src --glob '!utils/branding.ts' --glob '!__tests__/**' --glob '!node_modules'` returns 0 matches. Evidence: grep exit code 1 (no hits).
- **Notes**: Keep existing `api/src/utils/alatpay.ts` untouched.

## Task 3: Update admin settings PATCH schema, GET response, public branding endpoint
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - `api/src/routes/admin.ts`: Add to `SystemSettingsPatchSchema` (L655): `universityFaviconUrl: z.string().max(500).nullable().optional()`, `receiptBursarName: z.string().max(190).nullable().optional()`, `receiptBursarTitle: z.string().max(190).nullable().optional()`, `receiptBursarSignatureUrl: z.string().max(500).nullable().optional()`. Confirm GET `/admin/settings` already returns all SystemSettings columns (it uses `select *` pattern); verify 4 new columns present.
  - Replace inline `brand = { ... }` builders at `bursary.ts:684` and `admin.ts:1020` with calls to `buildBranding()` (await).
  - Add unauth `GET /api/v1/public/branding` route in `api/src/routes/public.ts` (or create a small new file `routes/publicBranding.ts`): return result of `buildBranding()` wrapped in `{ status: 'success', data }`; CORS-OK, no auth.
  - `api/src/services/email.ts`: Import `brandingEnvOnly()` and use `branding.name / branding.address` instead of inline env reads.
- **Acceptance Criteria Addressed**: AC-2, AC-3, AC-4, AC-6 (backend portion), AC-7
- **Test Requirements**:
  - `rule` TR-3.1: `curl -s -X PATCH /admin/settings -H 'Authorization: Bearer <ADMIN>' -H 'Content-Type: application/json' -d '{ "receiptBursarName": "Dr. A. B. Okafor", "receiptBursarTitle": "Bursar" }'` → HTTP 200. Then GET and assert values match. Evidence: curl command chain output.
  - `rule` TR-3.2: Unauth curl `/api/v1/public/branding` HTTP 200; JSON body contains at least keys `name, logoUrl, faviconUrl, bursarName, bursarTitle, bursarSignatureUrl`. Evidence: JSON jq keys present.
  - `rule` TR-3.3: `tsc api` exit 0.

## Task 4: Receipt PDF signature block + conditional "no signature" T&C language + branding builder integration
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2, Task 3
- **Description**:
  - In `receipt.ts`:
    - Replace call to `envBranding()` → await `buildBranding()` (or sync brandingEnvOnly fallback via try/catch on DB await failure for graceful degrade). Change method signatures to async if not already.
    - **Add CSS classes to `<style>` block:**
      - `.signature-block { margin-top: 18px; margin-bottom: 24px; display: grid; grid-template-columns: 1.1fr 1fr; gap: 40px; align-items: end; border-top: 1px dashed #d4dbeb; padding-top: 26px; }`
      - `.signature-line { border-top: 1px solid #333; width: 260px; margin: 56px auto 6px; position: relative; }`
      - `.signature-line img { position: absolute; bottom: 100%; left: 0; max-height: 72px; max-width: 260px; }`
      - `.signature-label { font-size: 10px; color: #666; text-align: center; margin-bottom: 10px; }`
      - `.signature-meta { text-align: center; font-size: 12px; line-height: 1.5; }`
      - `.signature-meta .name { font-weight: 700; }`
      - `.approved-box { border: 1px solid #8d99b5; border-radius: 6px; padding: 10px 14px; }`
      - `.approved-box .row { display: flex; justify-content: space-between; font-size: 11px; color: #555; margin-bottom: 6px; }`
      - `.approved-box .line { border-bottom: 1px solid #222; margin-top: 28px; margin-bottom: 6px; }`
    - **Build a helper `signatureBlockHtml(branding)`** that returns empty string when `!bursarName && !bursarTitle && !bursarSignatureUrl`, else the full grid layout:
      ```
      <div class="signature-block">
        <div>
          <div class="signature-line">
            ${signatureUrl ? `<img src="${signatureUrl}" alt="Signature" />` : ''}
          </div>
          <div class="signature-label">Signature (Bursary Department)</div>
          <div class="signature-meta">
            <div class="name">${name}</div>
            <div class="title">${title}</div>
          </div>
        </div>
        <div class="approved-box">
          <div class="row"><span>Approved By:</span><span></span></div>
          <div class="line">&nbsp;</div>
          <div class="row"><span>Date:</span><span>____________________</span></div>
          <div class="row"><span>Stamp:</span><span></span></div>
        </div>
      </div>
      ```
    - Insert the signature block between `</div>` (fee-breakdown close) and `<div class="footer">` in **both** `generateReceipt()` and `generateFormalReceipt()` templates.
    - **Conditional T&C rule (AC-8):** In both `generateReceipt` terms `L289` and `generateFormalReceipt` `L399`, change `1. This receipt is computer generated and requires no signature...` → WHEN signature block is empty → show sentence unchanged. WHEN signature block is present → replace with "1. This receipt is official and validates the Bursary Department signatory above." (or drop #1 wording if preferred). The rest of #2,#3 T&C sentences unchanged.
  - `receiptController.ts` response mapper `qrUrl` line 104 already uses correct fallbacks. No extra edits needed for controller beyond method signatures.
- **Acceptance Criteria Addressed**: AC-5, AC-8
- **Test Requirements**:
  - `rule` TR-4.1: Standalone puppeteer receipt HTML render (no DB) — branding with bursarName + title set → HTML string contains `.signature-block`. Evidence: grep string match.
  - `rule` TR-4.2: Standalone render with empty bursar fields → HTML does NOT contain `.signature-block` AND still contains "requires no signature". Evidence: two grep assertions.
  - `rubric` TR-4.3: Placement correctness on rendered PDF. Scale 1-5. Anchors: 1=overlaps footer or QR; 3=between fee-breakdown and footer but no approved box alignment; 5=clean grid signature left, approved right, no overlap. Threshold >= 4. Evidence: Puppeteer screenshot.
  - `rule` TR-4.4: `tsc api` exit 0.

## Task 5: Environment templates updated with new branding env vars
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 2
- **Description**:
  - Update `api/.env` actual (insert below DATABASE section, above REDIS or where UNIVERSITY vars currently exist if any): a `# ----------------------------- UNIVERSITY IDENTITY / BRANDING -----------------------------` block with 10 env vars documented (all commented out, defaults-in-code per branding.ts): `UNIVERSITY_NAME`, `UNIVERSITY_LOGO_URL`, `UNIVERSITY_FAVICON_URL`, `UNIVERSITY_ADDRESS`, `UNIVERSITY_PHONE`, `UNIVERSITY_EMAIL`, `UNIVERSITY_WEBSITE`, `RECEIPT_BURSAR_NAME`, `RECEIPT_BURSAR_TITLE`, `RECEIPT_BURSAR_SIGNATURE_URL` (+ `UNIVERSITY_BANK_NAME` / `UNIVERSITY_BANK_ACCOUNT` as existing pair if they are commented).
  - Same block added to `api/.env.example`.
  - `app/.env.example`: Add comment at top mentioning branding values are set server-side and exposed via `/api/v1/public/branding` (browser env doesn't need duplicate VITE copies of all these fields).
- **Acceptance Criteria Addressed**: FR-8, NFR-4
- **Test Requirements**:
  - `rule` TR-5.1: `rg 'UNIVERSITY_FAVICON_URL|RECEIPT_BURSAR_NAME' api/.env api/.env.example` shows hits in BOTH files. Evidence: grep output.

## Task 6: Frontend BrandingProvider + runtime favicon + title + landing H1
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 3 (public endpoint exposed)
- **Description**:
  - Create `app/src/context/BrandingContext.tsx` with:
    ```
    export interface BrandingState { loading: boolean; error: any; brand: BrandingFields | null; }
    type BrandingFields = { name, logoUrl, faviconUrl, address, phone, email, website, bankName, bankAccount, bursarName, bursarTitle, bursarSignatureUrl, receiptFooterText, receiptPrefix, paymentRefPrefix };
    ```
    - Export `BrandingProvider` component and `useBranding()` hook.
    - On mount, fetch `/api/v1/public/branding`. On success, mutate DOM:
      - Set `document.title = \`${name} — Payment Portal\`` (if name falsy fall back to default).
      - Find existing `<link rel="icon">` in document.head; if faviconUrl truthy set href, else `/vite.svg` fallback.
  - Wrap app `<App>` or `<AuthProvider>` children with `<BrandingProvider>` in `main.tsx`.
  - `App.tsx:120`: Replace hardcoded `"University Payment Platform"` H1 with `brand?.name || 'University Payment Platform'` from `useBranding()`.
  - Optionally, add a small `<img>` or name in the top-left of PortalShell (header area) if `brand.logoUrl` exists — non-breaking.
  - Update TS interface `SystemSettingsOut` in `adminApi.ts` to add 4 new columns (faviconUrl, bursarName, bursarTitle, bursarSignatureUrl).
- **Acceptance Criteria Addressed**: AC-6, NFR-5
- **Test Requirements**:
  - `rule` TR-6.1: After hard page load to landing route, `document.title` starts with the name returned by branding endpoint and does NOT contain "Vite + React". Evidence: Integrated browser evaluate script.
  - `rule` TR-6.2: `document.querySelector('link[rel="icon"]').href` equals branding faviconUrl when present; equals `/vite.svg` when faviconUrl empty. Evidence: browser evaluate.
  - `rule` TR-6.3: Landing page first H1 equals branding name. Evidence: browser snapshot content match.
  - `rule` TR-6.4: `tsc app` exit 0.

## Task 7: Admin SystemSettings UI fields added
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 3, Task 6
- **Description**:
  - In `app/src/pages/admin/SystemSettings.tsx`:
    - "University" card — add Favicon URL input (col-span-2) below Logo URL row: type="url", placeholder `https://...favicon.ico` or `.png/.svg`, bound to `universityFaviconUrl`.
    - **Below** current Receipts card (which already has footer text, prefixes), add a brand-new `<div class="bg-white rounded-xl ...">` card titled "Receipt Bursar Signature" with subtext "Printed signing block on every receipt PDF". Fields: 3 inputs:
      1. `receiptBursarName` — "Signatory Name" e.g. "Dr. A. B. Okafor" — single line text max 190.
      2. `receiptBursarTitle` — "Signatory Title" e.g. "Bursar" or "Deputy Bursar" — single line text max 190.
      3. `receiptBursarSignatureUrl` — "Signature Image URL (PNG/SVG max height ~72px)" — type=url, placeholder `https://...`.
    - Ensure dirty-state tracker catches changes to the 4 new fields (should already since generic updateField).
    - Save button: PATCH body already serialized generically; no extra work.
  - In `app/src/services/adminApi.ts`: update `SystemSettingsOut` interface + `SystemSettingsPatch` type alias to include 4 new fields.
- **Acceptance Criteria Addressed**: AC-4, AC-5
- **Test Requirements**:
  - `rule` TR-7.1: `/admin/settings` render snapshot shows 3 bursar signature inputs + 1 favicon input. Evidence: browser snapshot.
  - `rule` TR-7.2: Save button press triggers PATCH body with all 4 new keys when changed. Evidence: Network request body via axios intercept or browser devtools network.
  - `rule` TR-7.3: `tsc app` exit 0.

## Task 8: Verify frozen Jest gate + full tsc
- **Status**: `pending`
- **Priority**: high
- **Depends On**: All tasks above
- **Description**:
  - Run `tsc api` exit 0.
  - Run `tsc app` exit 0.
  - Run the frozen Jest gate (8 suites).
  - Note: If tests fail due to schema assertions, add columns as optional to test mocks if and only if failure is "unknown key" shape not logic. If logic fails, bug must be fixed.
- **Acceptance Criteria Addressed**: AC-7, NFR-1, NFR-2
- **Test Requirements**:
  - `rule` TR-8.1: `tsc api` exit 0; `tsc app` exit 0.
  - `rule` TR-8.2: Jest 8 suites, 134 tests pass; 0 failures. Evidence: final summary log.
  - `rule` TR-8.3: Final end-to-end sanity: login admin → update settings bursar name → save → logout → visit landing → H1 uses branding.name → browser tab title updated → download a sample receipt PDF → signature block present visually.

## Task 9: Independent review pass
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 8
- **Description**:
  - Delegate a fresh review context that independently checks: schema columns present, PATCH roundtrips, public branding endpoint, AC-2 cascade correctness, AC-8 conditional T&C, frontend title/favicon. Result: pass / fail / blocked.
  - On fail: add issues. On pass: spec complete.
- **Acceptance Criteria Addressed**: All ACs via independent Review gate
- **Test Requirements**:
  - `rule` TR-9.1: Reviewer runs `review.md` checklist fully. Evidence: review.md file written with result.
