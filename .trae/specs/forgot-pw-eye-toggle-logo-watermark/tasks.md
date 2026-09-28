# Tasks Queue — Forgot Password + Eye Toggle + Logo + Receipt Watermark
Parent spec: `.trae/specs/forgot-pw-eye-toggle-logo-watermark/spec.md`

## Task 1: Asset Setup (Bells Crest → All Sizes + Branding Seed)
**Status**: pending
**Maps to AC**: AC5, AC6, AC7, AC11
**Scope**:
1. Copy user's Bells University crest PNG from uploaded message to `app/public/branding/` as source.
2. Generate 3 PNG variants in same folder:
   - `logo.png` (1024× max, max compressed)
   - `logo-sm.png` (256×, for navbar height ~48px)
   - `favicon-32.png` (32×32, sharp)
   - `apple-touch-icon-180.png` (180×180, rounded corners, iOS home screen safe)
3. Generate REAL multi-size ICO file at `app/public/favicon.ico` → sizes 16×16, 32×32, 48×48. Use installed npm package (`sharp` if available → or `png-to-ico`/pure JS fallback; verify file size ≥ 300 bytes as proof multi-size format NOT renamed PNG).
4. Copy same branding assets to `api/public/branding/` so the Puppeteer PDF renderer sandbox (which requests from the API server) can also resolve them at same `/branding/*` paths. Also read logo.png buffer at Node startup → calculate base64 data URI → export a module-level constant `BELLS_LOGO_DATA_URI` at `api/src/utils/branding.ts` for zero-network PDF headless renders (sandbox-safe).
5. Update `api/.env` → `UNIVERSITY_LOGO_URL="/branding/logo.png"` + `UNIVERSITY_FAVICON_URL="/branding/favicon.ico"`. Update seed in `services/systemSettings.ts SEED_DATA` → `universityLogoUrl: "/branding/logo.png"`, `universityFaviconUrl: "/branding/favicon.ico"`, `universityName: "Bells University of Technology"`, default accentColor `#0e74cc` (extracted from Bells crest primary blue dominant pixel 70% of color).
**Test Requirements**:
- **TR-1.1 (rule)**: `ls -la app/public/favicon.ico` size ≥ 300 bytes.
- **TR-1.2 (rule)**: Node `fs.readFile(api/src/utils/branding.ts)` contains export `BELLS_LOGO_DATA_URI = "data:image/png;base64,…"` (non-empty).
- **TR-1.3 (rule)**: Build branding on API → buildBranding().logoUrl equals "/branding/logo.png" (env seed fallback verified).

## Task 2: Browser Logo + Favicon Integration
**Status**: pending
**Maps to AC**: AC5, AC6, AC11
**Scope**:
1. Update `app/index.html` → `<title>Bells University of Technology — Bursary Payment Portal</title>`. Add `<link rel="icon" href="/favicon.ico" sizes="any">`, `<link rel="icon" type="image/png" sizes="32x32" href="/branding/favicon-32.png">`, `<link rel="apple-touch-icon" sizes="180x180" href="/branding/apple-touch-icon-180.png">`. Remove old `vite.svg` icon link.
2. Create reusable React component `components/ui/UniversityLogo.tsx`: renders `<img src="/branding/logo-sm.png" alt="Bells University Crest">` with `onError` handler → fallback render inline SVG: 56px circle fill `#0e74cc`, inner stroke white, bold white uppercase "BUoT" 20px letterspacing 1px. Exports size prop (sm/md/lg → 32/48/72 px).
3. Wire UniversityLogo component into: (a) Navbar top-left brand area (replacing any text or empty brand), (b) all 3 login screens (StudentLogin/AdminLogin/BursaryLogin) centered header above form card, (c) Footer bottom left.
4. Update university accent color globals (app index.css globals) → --brand-primary: #0e74cc, --brand-dark: #0a3d91 (matches receipt existing colors). Apply to focus-ring outlines (now blue matching Bells crest instead of old focus color).
5. Ensure browser reload → no broken image anywhere; Network panel shows all logo files served HTTP 200.
**Test Requirements**:
- **TR-2.1 (rule)**: StudentLogin, AdminLogin, BursaryLogin page renders img tag src="/branding/logo-sm.png" OR has UniversityLogo component present.
- **TR-2.2 (rule)**: index.html title matches exact string above; favicon.ico link present.
- **TR-2.3 (rule)**: components/ui/UniversityLogo.tsx contains inline SVG fallback with "BUoT" text (confirmed via grep).

## Task 3: PasswordInput Component with Eye Toggle
**Status**: pending
**Maps to AC**: AC4, AC11
**Scope**:
1. Create `components/ui/PasswordInput.tsx`. Props extend React.InputHTMLAttributes<HTMLInputElement> + `label?: string`, `strength?: 'weak'|'fair'|'good'|'strong'|null`, `showStrengthBar?: boolean`. Renders: label (optional), relative div, input pl-4 pr-12 py-3 with className like existing inputs, right absolute slot button with Lucide Eye (type=password default) → onClick swaps type=text + EyeOff icon. Accessibility attrs: `<button aria-pressed={show} aria-label={show ? "Hide password" : "Show password"} title=...>`, Space/Enter keyup toggles.
2. Supports `autoComplete` prop: allowed values are `current-password`, `new-password`, `one-time-code` (default: current-password); component passes through as-is.
3. Retrofit EIGHT password input screens to use PasswordInput:
   - StudentLogin.tsx: old password input
   - AdminLogin.tsx: old password input
   - BursaryLogin.tsx: old password input
   - Profile.tsx: Current Password (autoComplete=current-password), New Password (new-password), Confirm (new-password)
   - ForcePasswordChangeGate.tsx: input there
   - Admin/Users.tsx: reset modal password field
   - Admin/Students.tsx: reset modal password
   - New ResetPasswordPage (Task5) will also use it
4. Verify no static "Lock" icon with no action remains in any login screen.
**Test Requirements**:
- **TR-3.1 (rule)**: Grep for `<input type=\"password\"` in app/src without wrapping PasswordInput → result = 0 occurrences.
- **TR-3.2 (rule)**: PasswordInput exports Eye/EyeOff toggle; Playwright or manual click changes HTML `<input>` from type=password → type=text in the DOM.
- **TR-3.3 (rule)**: PasswordInput accepts autoComplete prop; browser autocomplete tag shows "Suggest strong password" on autoComplete=new-password inputs.

## Task 4: Forgot Password Backend Routes (2 New Auth Endpoints)
**Status**: pending
**Maps to AC**: AC1, AC2, AC3, AC10
**Scope**:
1. Add route mounts in `api/src/routes/auth.ts` ABOVE protect middleware (anonymous accessible):
   a. `POST /api/v1/auth/forgot-password`: body `{ email: string }` — Zod email regex valid, rate limit `3 req/15min by email address + 10/hour by IP`. Handlers: i) find user by email (case-insensitive); ii) if exists → generate JWT with `{ sub: userId, aud:'urn:auth:pwd-reset', jti: crypto.randomHex(16), exp: Math.floor(Date.now()/1000)+900 }` (15 min); iii) write Redis key `pwd-reset:consumed:{jti}` with TTL 16 minutes = NOT consumed yet (flip value to consumed on use); iv) dispatchEmail(PASSWORD_RESET) payload `{ studentName, resetUrl: FRONTEND_BASE_URL+/reset-password?token=<jwt>, expiresAt: now+15min }`; v) ALWAYS return HTTP 202 identical message regardless of email existence (prevents enumeration). vi) If no user found → never dispatch email, still return 202.
   b. `POST /api/v1/auth/reset-password`: body `{ token: string, newPassword: string, confirmPassword: string }` — Zod min8 max128, confirmPassword strict equality. Handlers: i) verify JWT signature, aud==urn:auth:pwd-reset, not expired; ii) Redis `GET pwd-reset:consumed:{jti}` → if value = "CONSUMED" or missing (TTL expired) → HTTP 409 Conflict; iii) SET consumed + call prisma user update bcrypt hash; iv) audit log PASSWORD_RESET_COMPLETED with userId/actor=SELF/ip; v) HTTP 200 OK. (If Redis unavailable fallback: in-memory Map<String, Number> key jti → expiry timestamp; gc stale on access.)
2. Dispatch PASSWORD_RESET uses existing `renderPasswordReset()` positional signature from email.ts — signature preserved exactly for frozen jest tests.
3. Audit log actions: `PASSWORD_RESET_REQUESTED`, `PASSWORD_RESET_CONSUMED`, `PASSWORD_RESET_FAILED_INVALID`.
**Test Requirements**:
- **TR-4.1 (rule)**: POST forgot with nonexistent email → HTTP 202 and NO EmailDeliveryLog row.
- **TR-4.2 (rule)**: POST reset twice with same token → 1st = 200, 2nd = 409 Conflict.
- **TR-4.3 (rule)**: Token TTL verified via decode jwt exp = iat+900 seconds max.
- **TR-4.4 (rule)**: Rate limit 4th identical email hit in 15 min window → HTTP 429.

## Task 5: Forgot Password Frontend UI + Two New Pages
**Status**: pending
**Maps to AC**: AC9, AC12
**Scope**:
1. Create `pages/auth/ForgotPasswordPage.tsx` — centered card, logo header, title "Forgot Your Password?", subtitle "Enter the email address on your account and we'll send you a link to reset it.", email input field, submit button. On submit → spinner → always show success toast: "If your email is registered, you will receive a reset link within 2 minutes. Check spam folder if not in inbox." (always toast regardless of actual server result) → "Back to login" link.
2. Create `pages/auth/ResetPasswordPage.tsx` → reads `?token=` from URL query, if missing/expired shows error "This link is invalid or has expired. Request a new link below." with button → navigate to /forgot-password. If token present: show New Password + Confirm Password (both use PasswordInput component from Task3 with showStrengthBar=true + strength prop). Strength meter: 4 levels (Weak red / Fair orange / Good lightgreen / Strong green) based on rules (length 8→12, upper, lower, digit, symbol, no repeats). Mismatch → inline red alert "Passwords do not match", submit button disabled until match. Submit → 200 success → redirect to /login with toast "Password updated. Login with new password."; 409 → show expired message; other err → show toast retry.
3. React Router routes (in App.tsx main router): add `<Route path="/forgot-password" element={<ForgotPasswordPage/>} />`, `<Route path="/reset-password" element={<ResetPasswordPage/>}/>`. Public routes (do NOT wrap with AuthContextProtectedRoute).
4. Add "Forgot Password?" link (`className="text-sm font-medium text-brand hover:underline"`) at bottom of each of the 3 login pages (Student, Admin, Bursary) → navigates to /forgot-password.
**Test Requirements**:
- **TR-5.1 (rule)**: 3 login pages have `<a>` or `<Link>` with text "Forgot Password?" pointing to /forgot-password.
- **TR-5.2 (rule)**: Reset page with newPassword != confirmPassword → submit button disabled prop truthy or onClick does not issue fetch.
- **TR-5.3 (rule)**: App Router contains path="/forgot-password" and path="/reset-password".

## Task 6: Receipt Logo Header (Base64 Inline for Sandbox Safety)
**Status**: pending
**Maps to AC**: AC7, AC8, AC11
**Scope**:
1. Create `logoImgHtmlProfessional(b: Branding, sizePx=58, base64DataUri=BELLS_LOGO_DATA_URI)` function in receipt.ts:
   - If base64DataUri is non-empty (default → always uses pre-exported constant from branding.ts):
     `<div class="logo-img"><img src="${base64}" style="height:${sizePx}px; width:auto; max-width:${sizePx*1.6}px; object-fit:contain;"/></div>`
   - If base64 missing (fallback): fallback to text BUoT in div inline svg blue circle 58px for receipt rendering.
2. Replace all 3 calls to old `logoImgHtml(branding, size)` in: L223 (statement), L340 (quick receipt), L477 (formal receipt) with new `logoImgHtmlProfessional(branding, size)`.
3. In header, next to logo → change static "Official Payment Receipt — Bursary Department" + include address/phone/website branding columns if available, formatted with small text.
**Test Requirements**:
- **TR-6.1 (rule)**: Grep api/src/services/receipt.ts → no network src URLs in img tags (no http://localhost, no /branding/logo.png paths) → all images use `data:image/png;base64,…` prefixes.
- **TR-6.2 (rule)**: 3 receipt renderers each invoke logoImgHtmlProfessional function once.

## Task 7: Receipt Layered Watermarks (Fix z-index Bug + Anti-forgery)
**Status**: pending
**Maps to AC**: AC8, AC11
**Scope**:
1. Fix the z-index bug: current `.container { position: relative; }` has `.watermark { z-index:-1 }` so watermark paints behind white container background → invisible. Refactor classes: i) `.container` → no z-index, `position: relative; overflow: hidden; isolation: isolate;` (new CSS layout). ii) `.watermark { position: absolute; z-index: 0; }`. iii) Wrap all body contents (header/badge/amount/grid/footer/signature) inside `<div class="page-content" style="position: relative; z-index: 2;">` so content is above watermarks. This works inside the browser.
2. Replace old single text watermark `.watermark` with TWO watermark layers in the same position:absolute block:
   - **Layer A (Anti-copy tile)**: Render 5 repeated crest images. Use CSS background-repeat: `background-image: url(${base64})`, `background-size: 240px 240px`, `background-repeat: repeat`, `opacity: 0.06` (6%), `transform: rotate(-38deg)`, cover entire container width × height (use negative inset -80px margins to bleed off edges). This tiles Bells crests diagonally across the whole page so that screenshots copied always show a watermark.
   - **Layer B (Giant Text)**: Single huge <div> centered text `OFFICIAL RECEIPT — BELLS UNIVERSITY OF TECHNOLOGY` font-size 84px, color rgba(10, 61, 145, 0.05) (opacity 5%), rotate -38deg, letter-spacing 8px. position absolute. Same z-index 0.
3. Apply changes to ALL THREE renderers (generateStatement, generateReceipt, generateFormalReceipt).
**Test Requirements**:
- **TR-7.1 (rule)**: CSS line `z-index: -1` no longer present in receipt stylesheets for any class.
- **TR-7.2 (rule)**: Rendered receipt has at least 2 watermark layers in source HTML (search receipt template for opacity 0.05 or 0.06 occurrences ≥ 2).
- **TR-7.3 (rule)**: Grep for `.page-content { position: relative; z-index: 2 }` present in receipt renderer style block.

## Task 8: Verification of All ACs
**Status**: pending
**Maps to AC**: AC10, plus final gates for all previous
**Scope**:
1. Run `cd api && npx tsc --noEmit` → exit 0.
2. Run `cd app && npx tsc --noEmit` → exit 0.
3. Run `NODE_ENV=test npx jest email-secrets.test.ts --runInBand --forceExit` → 21/21 PASS (no changes to renderPasswordReset signature allowed).
4. Run `GetDiagnostics` → empty.
5. Shell check favicon.ico format: `wc -c app/public/favicon.ico` output ≥ 300 bytes.
6. Smoke curl forgot flow: (a) login admin to get token; (b) POST forgot with existing student email → expect 202; (c) verify delivery log row appears with emailType=PASSWORD_RESET; (d) extract token in sentCaptures or queueCaptures; (e) POST reset with token twice → verify 1st=200,2nd=409.
7. Generate PDF receipt → run puppeteer for one real Receipt. Run pixel-based visual inspection (or manual log) to confirm watermark text visible at opacity 5%+ AND logo in top left.
**Test Requirements**:
- **TR-8.1 (rule)**: api tsc 0 + app tsc 0.
- **TR-8.2 (rule)**: Jest email-secrets 21/21 PASS.
- **TR-8.3 (rule)**: Favicon.ico size ≥ 300 bytes.
- **TR-8.4 (rule)**: Reset token replayed → HTTP 409.
- **TR-8.5 (rule)**: GetDiagnostics length 0.

## Task 9: Independent Review
**Status**: pending
**Maps to AC**: All ACs reviewed independently
Scope: Delegate to reviewer after implementation. Produce review.md with evidence. If failures → return to Implement as remediation tasks.

## Dependencies (Task DAG)
Task 1 (Assets) → Task 2 (Logo UI) & Task 6 (Receipt Logo) & Task 7 (Watermark)
Task 3 (PasswordInput) → Task 5 (Forgot UI, uses it)
Task 4 (Forgot Backend) → Task 5 (Forgot Frontend, calls endpoints)
Task 8 runs after 1-7 all done
Task 9 runs after Task 8.
