# Spec: Forgot Password Flow + Eye Toggle Password Reveal + Bells University Logo/Favicon/Branding + Receipt Professional Watermark Upgrade
Session: 2026-09-28 (Spec-Mode) | 4 Feature Bundles

## 1. Problem & Users
- **User Personas**:
  - *Students (100% primary)*: forget passwords on login screen (especially first login after credentials email); need clickable eye to review password before submit to prevent typos.
  - *Admin / Bursary users*: branded Bells University of Technology visual identity across all browser screens (navbar, login, favicon) and all PDF receipts for official Nigerian university records.
  - *Auditors / Regulators / Parents paying fees*: official-looking receipts cannot be copy-paste-forged (anti-tamper watermark); university logo is clearly visible as a trust signal on all payment proofs.
- **Problems Solved**:
  1. No self-service password reset: student emails admin/bursary to have password manually reset (high ops load, phone/WhatsApp support volume).
  2. Password inputs have only a static Lock icon that does nothing — users cannot review what they typed, creating failed-login account lockouts (lockout after 5 failed attempts per hardening spec).
  3. Browser shows React/Vite placeholder favicon (vite.svg) + placeholder title "Vite + React + TS" — no Bells branding on tabs, bookmarks, or Add-to-Home-Screen iOS/Android tiles. Navbar/login/logo areas all blank because branding.logoUrl is null.
  4. PDF receipt watermark renders INVISIBLE due to `z-index: -1` bug that pushes watermark behind `.container { border:1px solid #e3e7ef; background: white }`. Logo header slot wired correctly but never populates since branding.logoUrl=null.

## 2. Goals & Non-Goals
### Goals (this spec only)
1. Deliver OWASP-compliant forgot/reset password flow via email deep links.
2. All password inputs have a functional, accessible eye icon reveal toggle.
3. Every browser surface shows Bells University branding: favicon, tab title, nav bar, login, footer.
4. All 3 PDF receipt renderers show Bells crest logo header, layered anti-forgery watermarks, no z-index bugs.

### Non-Goals (explicitly NOT in scope — if desired file separate spec)
- NO SMS/WhatsApp OTP reset channels
- NO 2FA / TOTP / WebAuthn
- NO magic link / passwordless login (explicitly deferred in prior session: user verbatim "okat dont owrry, let leave sucre a it is")
- NO UI redesign of existing pages (just add logo slots + eye toggle + 2 new pages)
- NO server-side session invalidation of existing refresh tokens on password reset
- NO change to admin manual reset password dashboard flows (they continue to work exactly as-is)

## 3. Constraints & Assumptions
- **C1 Frozen test suites**: email-secrets.test.ts 21 cases MUST PASS untouched. No change to `renderPasswordReset` existing positional signature (it was frozen by last review).
- **C2 NDPR / OWASP top 10**: forgot endpoint must NOT enumerate registered vs unregistered emails. Always return same response.
- **C3 Existing branding cascade**: `buildBranding()` DB → env → defaults must be preserved; new assets follow same pattern.
- **C4 Puppeteer headless sandbox**: pdf receipts cannot depend on external network fetches for logo inside HTML → use inline data URI base64 (100% offline-sandbox-safe).
- **C5 Vite public folder**: static assets go under `app/public/branding/*` → build output served at `/branding/*`.
- **C6 Existing React Router**: router already configured in App.tsx; add two new routes (`/forgot-password`, `/reset-password`) without breaking others.
- **Assumption A1**: User's attached Bells University of Technology crest PNG is high enough resolution (≥512px) to be source for all variants downscaled.
- **Assumption A2**: Resend SMTP/Mock provider cascade from prior integration re-used here (PASSWORD_RESET email already present in email.ts).

## 4. Acceptance Criteria (AC)
All ACs EXCLUSIVELY typed `rule` or `rubric`.

| ID | Title | Type | Condition (Verifiable) |
|---|---|---|---|
| **AC1** | Forgot/Reset API flow returns uniform success response (no email enumeration) | rule | `POST /api/v1/auth/forgot-password { email: existing@… } & { email: nonexistent@… } → both return HTTP 202 { status: success, message: "If your email is registered you will receive a password reset link shortly." }` identical body/status; response times differ by <500ms to block timing attacks. |
| **AC2** | Reset token single-use + TTL 15 min + consumed on use | rule | Token JWT contains `aud="urn:auth:pwd-reset"`, `exp <= now + 15 min`, `sub=userId`, `jti=randomHex(16)`. First `POST /reset-password { token, newPassword, confirmPassword }` → 200. Second attempt with same token → 409 Conflict { message: "Reset token already used or expired" }. jti stored in Redis (or in-memory set if Redis disabled) for 16 minutes. |
| **AC3** | Reset password email dispatched with deep-link URL | rule | Forgot-password hit on registered email → dispatchEmail emailType=PASSWORD_RESET with payload `{ resetUrl: FRONTEND_BASE_URL/reset-password?token=<jti..>&email=<obscured>, recipientName, expiresAt }`. Email body button URL matches pattern `https?://…/reset-password?token=`. Uses existing renderPasswordReset renderer (signature UNCHANGED — frozen by jest). |
| **AC4** | Eye toggle component works correctly on all password inputs | rule | PasswordInput component renders `<Eye>` by default (dots), click swaps to `<EyeOff>` and input type=text shows characters. Second click returns. `aria-pressed` attribute toggles `true/false`. 8 retrofitted screens work: StudentLogin, AdminLogin, BursaryLogin (3), Profile current/new/confirm (3), ForcePasswordChangeGate (1), Forgot/Reset page (1), Create Student password + Admin reset modal. No inputs left showing "Lock" icon only. |
| **AC5** | Favicon + browser tab show Bells branding | rule | Browser dev tools Network shows `GET /favicon.ico` returns multi-size ICO (file size ≥ 300 bytes means it's real ICO format, not renamed PNG). `<title>` element = `Bells University of Technology — Bursary Payment Portal`. iOS 180×180 apple-touch-icon served at `/branding/apple-touch-icon-180.png`. |
| **AC6** | Logo renders on all browser surfaces with inline-svg fallback initials | rule | Navbar brand, Login cards header, Footer → `<img src="/branding/logo.png" onerror=fallback>`. If logo src 404s → inline SVG fallback renders "BUoT" in a blue circle (#0e74cc) 56px diameter with bold white text — never shows browser default broken image icon. |
| **AC7** | Receipt logo header renders (ALL 3 PDF renderers) | rule | `generateReceipt()`, `generateFormalReceipt()`, `generateStatement()` → each rendered PDF contains Bells crest logo image in header top-left, 54-58px height. Use base64 inline `<img src="data:image/png;base64,…">` — NO network fetch inside Puppeteer sandbox (verified by checking receipt HTML does not reference localhost URLs for logo). |
| **AC8** | Receipt watermark visible AND non-obscuring + z-index layout bug fixed | rule | PDF output has 2 layered watermarks behind content: (A) repeating diagonal tiled 5× Bells crest images opacity 6-8% full page area; (B) single 96px text "OFFICIAL RECEIPT — BELLS UNIVERSITY OF TECHNOLOGY" rotated -38deg centered, rgba opacity 5%. All text content (amount/student/receipt number) has contrast ratio still ≥ 7:1 (no illegibility). Old `z-index:-1` line removed entirely. Apply all 3 renderers. |
| **AC9** | Frontend Reset Password page validates strength + matching before submit | rule | Reset page: NewPW + ConfirmPW. Strength meter bar shows 4 levels: Weak (<8), Fair (<12), Good (3 classes), Strong (4 classes). Mismatch → inline red text, submit disabled. If mismatch on submit → client validation catches, no request sent. Passwords 8-128 chars enforced server-side Zod. |
| **AC10** | Api & App tsc exit 0 + frozen tests pass | rule | `cd api && npx tsc --noEmit` → exit 0; `cd app && npx tsc --noEmit` → exit 0; `NODE_ENV=test npx jest email-secrets.test.ts --runInBand --forceExit` → 21/21 PASS. |
| **AC11** | Professional UI polish rubric | rubric | **Dimension: Visual cohesion (0-5 scale)**. 0 = blank / broken images visible; 2 = logo rendered but no accent match; 3 = logo + eye toggle all work no accent; 4 = logo everywhere, accent color from crest blue (#0e74cc) applied to button/focus rings, favicon ico multi-size; 5 = all of 4 + no UX flicker, focus rings visible on keyboard tab. **Pass threshold ≥ 4.5**. Evidence source: browser screenshots login + navbar + settings page + PDF receipt. |
| **AC12** | Forgot Flow UX rubric | rubric | **Dimension: Forgot UX clarity (0-5 scale)**. 0 = no forgot link exists; 2 = link exists no success state toast; 3 = link → form → silent success toast → email dispatched; 4 = all 3 login pages have forgot link, reset page validates strength + match, expired token page shows actionable guidance ("Request another link"); 5 = all of 4 + resend-link button on expired token screen, rate limit countdown notice if user exceeds 3/15 min. **Pass threshold ≥ 4.0**. Evidence: browser smoke screenshots of all flow screens. |

## 5. Open Questions (None — scope already clarified with user verbatim)
All requirements already stated explicitly by user verbatim:
- "work on forget password"
- "eye toogkle thet reveiw password"
- "add the logo and also water mark it to the receipt of payment"
- "also add it sothat it show on the broswer [favicon/tab]"
- "professionally done and implemented"

No open questions → proceed to Plan immediately upon approval.
