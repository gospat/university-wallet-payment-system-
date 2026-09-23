# Branding, University Logo/Favicon, and Bursar Receipt Signature - Product Requirements Document

## Overview
- **Summary**: Centralize all university identity (name, logo, favicon, contact) under an env-first + admin-editable settings model with a **single source of truth**. Add a printed Bursar signature block (name, title, signature image, signature line) to every receipt PDF. Use the branding consistently across: DB SystemSettings, admin PATCH UI, public branding JSON API, app frontend (landing, sidebar, login, browser tab), email templates, and PDF receipts.
- **Purpose**: Eliminate hardcoded "University Payment Platform" strings and favicon references. Allow admins to update the university name/logo/favicon/contact once in the Admin UI (or env file) and have the change appear everywhere. Provide a formal printed signing position on receipts (required for hard-copy bursary filing).
- **Target Users**: Admin (settings editor), Bursary (printed receipt signer), Students (branded frontend + receipts), public verifiers (branded verify-receipt page)

## Goals
- Single authoritative `buildBranding()` helper that merges DB SystemSettings (primary) → UNIVERSITY_* env vars (fallback) → compile-time defaults (last resort). No caller inlines hardcoded name/logo/fallback chains.
- All 9 branding surfaces (admin PATCH schema, DB fields, GET settings response, public branding API, receipt PDFs, email strings, landing page, portal sidebar/header, browser tab/favicon) updated to use the authoritative branding helper.
- New DB columns for Bursar signature: `receiptBursarName`, `receiptBursarTitle`, `receiptBursarSignatureUrl`. Admin-editable via settings panel; printed as a formal signatory block above the receipt footer with signature image (if set) and signature line.
- `universityFaviconUrl` DB + env column; frontend app bootstraps `<link rel="icon">` at runtime via JS on page load so a simple env / admin edit updates the browser tab icon without a redeploy.
- No schema-breaking changes: existing `SystemSettings` columns preserved (Jest 134 frozen tests pass untouched); new columns are optional with sane defaults.

## Non-Goals
- Implementing an actual upload/image asset server (logo and signature images accepted as URLs only — `https://...` pasted by admin; admins upload elsewhere and paste URL).
- Handwriting/signature capture widget (signature is a pre-rendered PNG/JPG/SVG URL).
- Per-receipt override of bursar name (global at settings level only; per-receipt would need a new FK relationship and is out of scope).
- Changing receipt format drastically (only add signature block; do not restructure existing columns/layout).

## Background & Context
- **Current gaps (from audit)**:
  1. Schema already has `universityName/LogoUrl/Address/Phone/Email/Website` in Prisma `SystemSettings`, plus `receiptPrefix/paymentRefPrefix/receiptFooterText/largePaymentThreshold/importErrorThreshold`. Schema is **missing** `universityFaviconUrl`, `receiptBursarName`, `receiptBursarTitle`, `receiptBursarSignatureUrl`.
  2. `envBranding()` in `receipt.ts` reads ONLY env vars — does NOT merge DB `SystemSettings` row.
  3. `bursary.ts:684` and `admin.ts:1020` each build the `brand` object INLINE from env only — duplicate code, no DB merge.
  4. `email.ts:20-21` reads `UNIVERSITY_NAME/ADDRESS` from env only — no DB merge.
  5. `App.tsx:120` hardcodes `"University Payment Platform"` on the landing picker.
  6. `app/index.html:5` hardcodes `href="/vite.svg"` favicon and `L7` hardcodes `<title>Vite + React + TS</title>`.
  7. `receiptFooterText` L399 of `generateReceipt` has a static T&C block saying "requires no signature" — contradicts the user's bursar-sign requirement; it must be conditional on signature being configured.
  8. i18n `en.ts:11,52` has duplicate university name strings.
- **Frozen constraints (never break)**: Prisma schema Test suite 8 suites / 134 tests pass untouched. Admin toggle single-active-gateway still enforced. Redis ECONNREFUSED graceful fallback holds. Prisma String VarChar(191) max on `String?` fields (Bursar name ≤ 190; URL fields use 500 VarChar).

## Functional Requirements
- **FR-1 — Schema additions**: Add 4 nullable columns to `SystemSettings`: `universityFaviconUrl String? @db.VarChar(500)`, `receiptBursarName String? @db.VarChar(190)`, `receiptBursarTitle String? @db.VarChar(190)`, `receiptBursarSignatureUrl String? @db.VarChar(500)`.
- **FR-2 — Authoritative branding helper**: Export one `buildBranding()` function (place in a shared utility `api/src/utils/branding.ts`) that: (a) loads SystemSettings id=1 row; (b) for each field `X`, resolves: `row.X ?? process.env.UNIVERSITY_X ?? default;` (c) supports fields: name, logoUrl, faviconUrl, address, phone, email, website, plus receipt signature fields (bursarName, bursarTitle, bursarSignatureUrl), receipt footer/prefix fields. Expose synchronous env-only variant `brandingEnvOnly()` for places where DB calls are premature or optional in sync fallbacks.
- **FR-3 — Admin PATCH schema**: Add 4 new fields to `SystemSettingsPatchSchema` (`admin.ts:655`) with appropriate Zod limits (URLs max 500; names/titles max 190). Update frontend `SystemSettingsPatch` TS type. Update settings UI SystemSettings.tsx to render a new "Receipt Signature" card below the "Receipts" card with 3 inputs + a "Favicon URL" input in the "University" card.
- **FR-4 — Public branding API**: Add unauthenticated `GET /api/v1/public/branding` endpoint returning 15-field object (all branding fields). Existing `/public/verify-receipt/:token` continue to work but reuse the shared branding builder. `GET /admin/settings` returns the 4 new columns so the Admin UI hydrates them.
- **FR-5 — PDF receipt signature block**: Insert a Bursar signature panel into BOTH `generateReceipt()` and `generateFormalReceipt()` PDF generators, positioned between the fee-breakdown table and the footer. If `bursarName OR bursarTitle OR bursarSignatureUrl` truthy render:
  - Signature image (if URL set, max-height ~72px floated left above the line)
  - Horizontal rule `___________________________` "Signature line" label centered below
  - "Name: Dr. A. B. Okafor" + "Title: Bursar / Deputy Bursar" below the line
  - Side-by-side with an "Approved By / Date" box to the right for manual signing on print.
  - Update "requires no signature" T&C text to be conditional: only show that sentence when the signature block is NOT configured; if signature block IS configured, omit that sentence instead.
- **FR-6 — Frontend branding bootstrap + persistent header**: Frontend app calls `/api/v1/public/branding` ONCE at boot inside `App.tsx` or a new `<BrandingProvider>` context; stores result in React state/context. Use it to: (a) dynamically inject/update `<title>` = `${name} — Payment Portal` (browser tab); (b) replace `<link rel="icon">` href with faviconUrl when set (fall back to default /vite.svg); (c) replace the "University Payment Platform" H1 at App.tsx landing picker line 120 with the real name; (d) optionally display logo or name in the top-left header of PortalShell sidebar if the branding context is set.
- **FR-7 — Email + PDF builder reuse shared branding**: Refactor `email.ts:20-21` strings to use the branding helper; refactor `bursary.ts:684` and `admin.ts:1020` inline brand builders to use the shared helper.
- **FR-8 — Env file documentation**: Update both `api/.env` (current) AND `api/.env.example` (template) with a documented `# UNIVERSITY IDENTITY / BRANDING` section listing: `UNIVERSITY_NAME`, `UNIVERSITY_LOGO_URL`, `UNIVERSITY_FAVICON_URL`, `UNIVERSITY_ADDRESS`, `UNIVERSITY_PHONE`, `UNIVERSITY_EMAIL`, `UNIVERSITY_WEBSITE`, `RECEIPT_BURSAR_NAME`, `RECEIPT_BURSAR_TITLE`, `RECEIPT_BURSAR_SIGNATURE_URL`. All lines commented as defaults-in-code fallbacks. Update `app/.env.example` to mention the backend branding API.

## Non-Functional Requirements
- **NFR-1 (Type safety)**: `tsc api` exit 0; `tsc app` exit 0 after all changes.
- **NFR-2 (Tests)**: Existing Jest 8 suites × 134 tests pass unchanged.
- **NFR-3 (Single source)**: Exactly ONE place (`buildBranding`) defines env → default cascade for name/logo/fields; all other callers import and use it; no inline `process.env.UNIVERSITY_NAME || 'hardcoded'` remain in production src files outside the branding builder (email.ts branding usage exception only via helper import).
- **NFR-4 (Backward compat)**: When admin has NOT edited any settings AND no env vars set, every surface falls back to the current baseline strings ("University Payment Platform" name, /vite.svg favicon, no signature block, old footer text minus the "no signature required" line only conditional).
- **NFR-5 (CORS + cache)**: Public `/api/v1/public/branding` is unauth/CORS-OK; short max-age 60s so admin edits show up quickly.

## Constraints
- **Technical**: No `File`/`Blob` upload endpoints; logo/signature URLs are https links pasted by admin. Prisma `db push` only to add columns; avoid `prisma migrate` for new projects (aligns with earlier schema convention). Frontend loads branding via lazy `useEffect`; never `useContext` before hooks order (frozen hardcoded-values constraint).
- **Business**: One active payment gateway only; branding changes must not affect payment flow or gateway selection logic. Receipt signature block MUST appear on PDFs (both quick receipt and formal receipt variants to keep parity).
- **Dependencies**: Relies on existing `SystemSettingsService` get/update idempotent pattern; no new DB tables.

## Assumptions
- Admin can upload PNG/JPG/SVG to any public host and paste the HTTPS URL into the Logo URL / Favicon URL / Bursar Signature URL fields. If they don't, graceful placeholder fallbacks apply.
- Receipt signature will be on every printed receipt (both voided and paid; the VOIDED rotated badge still appears and overrides validity visually on voided receipts even though signature line is present).
- i18n hardcoded strings (`en.ts:11`) will stay as a last-ditch compile-time fallback only; runtime surfaces should prefer context/branding API.

## Acceptance Criteria

### AC-1: Schema migration applied + prisma generate succeeds
- **Type**: `rule`
- **Given**: Working MySQL DB, updated `schema.prisma` with 4 new columns
- **When**: Run `npx prisma db push --accept-data-loss --schema=api/prisma/schema.prisma && npx prisma generate`
- **Then**: No errors; `Prisma.SystemSettings` TypeScript type shows 4 new optional fields
- **Pass Condition**: Both commands exit 0; `tsc api` exit 0
- **Evidence**: TBD (command output + grep of generated type)

### AC-2: buildBranding merges DB → env → defaults
- **Type**: `rule`
- **Given**: SystemSettings id=1 has `universityName='Bells University'` + env set `UNIVERSITY_PHONE='+234'` + no env set for `UNIVERSITY_NAME`
- **When**: Call `buildBranding()` result
- **Then**: `name === 'Bells University'`, `phone === '+234'`, `website === ''` (default empty), signature fields fall through env → defaults (empty strings)
- **Pass Condition**: All 3 assertions true; verified with standalone import/console probe
- **Evidence**: TBD

### AC-3: No inline env/hardcoded name fallbacks outside branding helper
- **Type**: `rule`
- **Given**: Full production src trees `api/src` and `app/src`
- **When**: `rg "UNIVERSITY_NAME.*\|\||University Payment Platform" api/src app/src --glob '!__tests__/**' --glob '!*.md'`
- **Then**: Zero matches outside `utils/branding.ts` (and branding.ts itself contains the cascade intentionally)
- **Pass Condition**: grep result returns 0 hits
- **Evidence**: TBD

### AC-4: Admin PATCH + GET round-trips all 4 new signature/favicon fields
- **Type**: `rule`
- **Given**: Admin JWT token for admin user
- **When**: `PATCH /admin/settings` body `{ universityFaviconUrl, receiptBursarName, receiptBursarTitle, receiptBursarSignatureUrl }` → then `GET /admin/settings`
- **Then**: HTTP 200 on both; GET body echoes all 4 values back; audit log contains `action=SETTINGS_UPDATE` for that admin id
- **Pass Condition**: Curl chain both endpoints succeed; values match
- **Evidence**: TBD

### AC-5: Bursar signature block renders correctly on PDF receipt
- **Type**: `rubric`
- **Dimension**: Bursar signature visual quality & placement correctness
- **Scale**: 1-5
- **Anchors**: 1 = signature not present; 3 = text-only signature block appears but bad placement overlaps QR/footer; 5 = signature image + signature line + name + title + approved-by/date box correctly positioned between fee-breakdown and footer; voided receipts keep VOID stamp and still show signature block
- **Pass Threshold**: >= 4
- **Evidence**: TBD (screenshot / PDF visual inspection of at least one paid + one voided receipt)

### AC-6: Frontend loads branding on boot and updates browser title + favicon
- **Type**: `rule`
- **Given**: Backend `/api/v1/public/branding` returns `{ name: 'Bells University', faviconUrl: 'https://.../fav.ico', logoUrl: '...' }`
- **When**: User navigates to `http://127.0.0.1:5174/` landing page, browser tab loaded
- **Then**: (a) `<title>` of tab contains `"Bells University"` and NOT `"Vite + React"` or `"University Payment Platform"`; (b) `<link rel="icon">` href equals faviconUrl returned; (c) landing page H1 says "Bells University"; (d) no fetch/network error for the branding call
- **Pass Condition**: All 4 (a) to (d) satisfied — observable via DevTools + snapshot
- **Evidence**: TBD

### AC-7: No test regressions (frozen Jest)
- **Type**: `rule`
- **Given**: NODE_ENV=test, empty DB test schema
- **When**: Re-run the frozen Jest 8 gate: `cd api && NODE_ENV=test npx jest health.test.ts regression.test.ts rbac-matrix.test.ts idempotency.test.ts email-secrets.test.ts academic-import.test.ts search-settings-notif.test.ts reconciliation.test.ts --runInBand --detectOpenHandles`
- **Then**: 8 suites, 134 tests pass; 0 failures; 8 skipped hold (no action on frozen schema)
- **Pass Condition**: Jest exit code 0 and summary line shows pass counts above
- **Evidence**: TBD

### AC-8: Conditional T&C signature language correct
- **Type**: `rule`
- **Given**: Signature fields `receiptBursarName` is set in DB/env
- **When**: Generate PDF receipt
- **Then**: The sentence "This receipt is computer generated and requires no signature." is NOT present in receipt HTML/PDF
- **Given**: All 3 signature fields are blank/null
- **When**: Generate PDF receipt
- **Then**: That sentence IS present (or equivalent "no signature required" language retained)
- **Pass Condition**: Both polar cases verified via grep of the generated HTML string output
- **Evidence**: TBD

## Open Questions
- None (all scope boundaries decided from context; signature = URL-only, no upload widget)
