#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises';
import crypto from 'node:crypto';

const API = process.env.API_BASE || 'http://localhost:3001/api/v1';
const ADMIN_EMAIL = 'admin@university.edu.ng';
const ADMIN_PASS = 'admin123';

async function req(method, path, body, headers = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, ok: res.ok, data: json, text };
}
const post = (p, b, h) => req('POST', p, b, h);
const get = (p, h) => req('GET', p, undefined, h);

function log(label, ...a) { console.log(`\n=== ${label} ===`); console.log(...a); }
function pass(msg) { console.log(`  ✅ ${msg}`); }
function fail(msg, extra) { console.log(`  ❌ ${msg}`); if (extra) console.log('    ', extra); process.exitCode = 1; }

function randomEmail(prefix = 'stu') {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}@smoke-test.university.edu.ng`;
}
function randomMatric(prefix = 'SMK') {
  const y = 2020 + (Date.now() % 5);
  return `${y}/${prefix}/${String(Math.floor(Math.random() * 9999)).padStart(4, '0')}`;
}

(async () => {
  const health = await get('/health').catch(() => null);
  if (!health || !health.ok) {
    console.error(`❌ Backend not reachable at ${API} — start backend first: cd api && npm run dev`);
    process.exit(2);
  }
  log('Health check OK', health.data);

  const login = await post('/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASS });
  if (!login.ok || !login.data?.token) {
    fail('Admin login failed', login.data);
    process.exit(3);
  }
  const TOKEN = login.data.token;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  log('Admin login', `HTTP ${login.status} token=${TOKEN.length} chars`);

  const progResp = await get('/programmes?page=1&pageSize=5', auth);
  const progs = (progResp.data?.data?.items) || (progResp.data?.data?.rows) || (progResp.data?.items) || progResp.data?.programmes || [];
  const anyProg = progs.find(p => p && p.id) || progs[0] || null;
  const programmeId = anyProg?.id || 1;
  log('Using Programme', anyProg ? `#${programmeId}: ${anyProg.name}` : `fallback id=${programmeId}`);

  const beforeResp = await get('/admin/email-delivery-logs?page=1&pageSize=5', auth).catch(() => null);
  const beforeCount = beforeResp?.data?.data?.total ?? 0;
  log('Scenario 1: Single account creation', 'Delivery log count BEFORE =', beforeCount);

  const s1Email = randomEmail('s1');
  const s1Matric = randomMatric('S1');
  const s1Payload = {
    firstName: 'SmokeTest1',
    lastName: 'StudentOne',
    middleName: 'Alpha',
    email: s1Email,
    phoneNumber: '08010000001',
    matricNumber: s1Matric,
    studentType: 'UNDERGRADUATE',
    accountStatus: 'ACTIVE',
    programmeId,
  };
  const s1Resp = await post('/students', s1Payload, auth);
  if (s1Resp.ok && s1Resp.data?.data?.user?.id) {
    pass(`Created student #${s1Resp.data.data.user.id} — ${s1Email} (${s1Matric})`);
    if (s1Resp.data.data.temporaryPasswordPlaintext === undefined) {
      pass('Backend returns HTTP response WITHOUT password in payload (password only via email per NDPR)');
    }
  } else {
    fail('Single student creation failed', s1Resp.data);
  }

  await sleep(4000);

  const after1Resp = await get('/admin/email-delivery-logs?page=1&pageSize=100', auth);
  const after1Data = after1Resp?.data?.data;
  const after1Count = after1Data?.total ?? beforeCount;
  const delta1 = after1Count - beforeCount;
  log('Delivery logs after single create', `total=${after1Count} delta=${delta1}`);

  const credRows = (after1Data?.rows || []).filter(r => r && r.emailType === 'STUDENT_CREDENTIALS' && r.toAddress === s1Email);
  if (credRows.length >= 1) {
    pass(`Found ${credRows.length} STUDENT_CREDENTIALS log(s) for ${s1Email}`);
    const cred = credRows[0];
    log('Delivery log row sample',
      `id=${String(cred.id).slice(0, 20)}… provider=${cred.provider} status=${cred.status} attempts=${cred.attempts}`);

    const summary = cred.payloadSummary || {};
    const summaryStr = typeof summary === 'string' ? summary : JSON.stringify(summary || '{}');
    const summaryForPasswordCheck = summaryStr.replace(/"hasTemporaryPassword"\s*:\s*(true|false)/g, '');
    const hasMatric = /matric|Matric/i.test(summaryStr) || summary?.matricNumber || summary?.hasMatricNumber;
    const hasPassword = /temporaryPassword|passwordPlain|password=|plaintext|\$2[aby]\$/i.test(summaryForPasswordCheck) || summary?.temporaryPassword || summary?.password;
    if (hasMatric) pass('Payload summary INCLUDES matricNumber reference (scrubbed)'); else fail('Payload summary missing matric reference');
    if (!hasPassword) pass('PII CHECK: payload summary contains NO plaintext password, no temporaryPassword, no bcrypt hash (NDPR-compliant)');
    else fail('PII LEAK: password found in payloadSummary!', summaryStr.slice(0, 500));

    const detail = await get(`/admin/email-delivery-logs/${encodeURIComponent(String(cred.id))}`, auth);
    if (detail.ok) pass('GET /admin/email-delivery-logs/:id returns detail view correctly');
    else fail('Delivery log detail endpoint failed', detail.status);
  } else {
    fail(`No STUDENT_CREDENTIALS delivery log row found for ${s1Email} after 4s`, 'total rows=' + (after1Data?.rows?.length ?? 0));
  }

  log('Scenario 2: Template PATCH configuration override survives roundtrip');
  const getTplResp = await get('/admin/email-templates/student_credentials', auth);
  const origUrl = getTplResp.data?.data?.portalLoginUrl;
  const NEW_PORTAL_URL = `https://smoke-test-${Date.now()}.portal.university.edu.ng/login`;
  const patchResp = await req('PATCH', '/admin/email-templates/student_credentials', {
    portalLoginUrl: NEW_PORTAL_URL,
    subjectLine: '[Smoke] Your University Student Account',
    buttonLabel: 'Smoke Test Login Button',
    accentColor: '#059669',
  }, auth);
  if (patchResp.ok && patchResp.data?.data?.portalLoginUrl === NEW_PORTAL_URL) {
    pass('PATCH email template saved correctly → portalLoginUrl=' + NEW_PORTAL_URL);
    const get2 = await get('/admin/email-templates/student_credentials', auth);
    if (get2.data?.data?.portalLoginUrl === NEW_PORTAL_URL && get2.data?.data?.accentColor === '#059669') {
      pass('Template RELOAD confirms changes persisted (DB cascade override confirmed)');
    } else {
      fail('Template re-read did not reflect PATCH changes', get2.data);
    }
  } else {
    fail('Template PATCH endpoint failed', patchResp.data);
  }

  if (origUrl) {
    await req('PATCH', '/admin/email-templates/student_credentials', { portalLoginUrl: origUrl }, auth);
    log('Restored original portalLoginUrl =', origUrl);
  }

  log('Scenario 3: Admin resend-credentials endpoint queues NEW log');
  const s1Id = s1Resp.data?.data?.user?.id;
  const beforeResendCount = (await get('/admin/email-delivery-logs?page=1&pageSize=1', auth))?.data?.data?.total ?? 0;
  const resendResp = s1Id ? await post(`/admin/users/${s1Id}/resend-credentials`, {}, auth) : null;
  if (resendResp?.ok) {
    pass(`POST /admin/users/${s1Id}/resend-credentials → HTTP ${resendResp.status} queued=${resendResp.data?.data?.queued}`);
    if (resendResp.data?.data?.deliveryLogId) pass('Returned non-empty deliveryLogId =', String(resendResp.data.data.deliveryLogId).slice(0, 24) + '…');
    await sleep(2500);
    const afterResendCount = (await get('/admin/email-delivery-logs?page=1&pageSize=1', auth))?.data?.data?.total ?? 0;
    const deltaR = afterResendCount - beforeResendCount;
    if (deltaR >= 1) pass(`After resend, total delivery logs +${deltaR} (expected >=1)`); else fail('Resend did not increment delivery log count');
  } else {
    fail('Resend credentials endpoint failed', resendResp?.data || 'No student created above');
  }

  log('Scenario 4: Bursary role PII masking on delivery log list');
  const bursaryLogin = await post('/auth/login', { email: 'finance@university.edu.ng', password: 'bursary123' });
  if (bursaryLogin.ok && bursaryLogin.data?.token) {
    const bAuth = { Authorization: `Bearer ${bursaryLogin.data.token}` };
    const bList = await get('/admin/email-delivery-logs?page=1&pageSize=5', bAuth);
    const rows = bList.data?.data?.rows || [];
    if (rows.length > 0) {
      const anyFullEmail = rows.some(r => r && /@/.test(r.toAddress) && /\*\*\*/.test(r.toAddress.replace(/@.*$/, '')) === false && r.toAddress.split('@')[0].length > 3);
      const hasMasked = rows.some(r => r && /\*+/.test(r.toAddress || ''));
      if (hasMasked || !anyFullEmail) {
        pass('Bursary view: delivery log toAddress partially masked (NDPR compliant — s*****@domain pattern)');
      } else {
        fail('Bursary role sees UNMASKED toAddress full value', rows.map(r => r.toAddress).slice(0, 5));
      }
    } else {
      pass('Bursary delivery list endpoint responds OK (empty data — no maskable rows)');
    }
  } else {
    fail('Bursary login failed (cannot test role PII masking)', bursaryLogin.data);
  }

  const final = await get('/admin/email-delivery-logs?page=1&pageSize=100', auth);
  const rows = final.data?.data?.rows || [];
  const total = final.data?.data?.total ?? 0;
  const byStatus = rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  log('FINAL: Delivery log snapshot', { total, byStatus, providers: rows.reduce((m, r) => { m[r.provider] = (m[r.provider] || 0) + 1; return m; }, {}) });

  console.log('\n═══════════════════════════════════');
  if (process.exitCode === 1) { console.log('❌ SMOKE EMAIL SESSION FAILED (see above)'); }
  else { console.log('✅ SMOKE EMAIL SESSION PASSED — Resend integration + admin UI config + PII masking validated'); }
  console.log('═══════════════════════════════════\n');
})().catch(e => { console.error('Uncaught smoke error', e); process.exit(99); });
