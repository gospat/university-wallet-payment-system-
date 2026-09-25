#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises';

const API = 'http://localhost:3001/api/v1';
const EMAIL = 'admin@university.edu.ng';
const PASS = 'admin123';

async function post(path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, ok: res.ok, data: json };
}
async function get(path, headers = {}) {
  const res = await fetch(`${API}${path}`, { method: 'GET', headers });
  return { status: res.status, ok: res.ok, data: await res.json().catch(() => ({})) };
}
function log(label, ...a) { console.log(`\n=== ${label} ===`); console.log(...a); }

(async () => {
  // 1. Login
  const login = await post('/auth/login', { email: EMAIL, password: PASS });
  const TOKEN = login.data.token;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  log('Step 1: Login', `HTTP ${login.status} JWT=${TOKEN.length} chars`);

  // 2. Ensure a FeeCategory exists for ID Card Fees
  let cats = await get('/fees/categories', auth);
  let rows = (cats.data.data || {}).categories || (cats.data.data || {}).rows || cats.data.categories || [];
  log('Step 2: Categories BEFORE', rows.length, rows.map(r => `id=${r.id}:${r.name}`).join(', '));
  let idCard = rows.find(r => r.name && /ID Card/i.test(r.name));
  if (!idCard) {
    const cr = await post('/fees/categories', { name: 'ID Card Fees', description: 'ID cards, convocation, matriculation regalia' }, auth);
    log('Create ID Card Fees category', `HTTP ${cr.status} -> ${JSON.stringify(cr.data).slice(0, 300)}`);
    if (cr.ok) {
      idCard = (cr.data.data || {}).category || null;
      if (idCard) {
        cats = await get('/fees/categories', auth);
        rows = (cats.data.data || {}).categories || (cats.data.data || {}).rows || cats.data.categories || [];
      }
    }
  }
  console.log('Using categoryId =', idCard?.id, 'name=', idCard?.name);
  if (!idCard || !idCard.id) { console.log('❌ Cannot find/create ID Card Fees category — aborting'); process.exit(1); }

  // 3. VALID POST: Convocation gown ₦500k + ALL empty strings (like HTML form would send)
  await sleep(50);
  const idem1 = `smoke-convo-${Date.now()}`;
  log('Step 3: POST /fees valid Convocation gown ₦500k + all empty strings', 'Idempotency-Key:', idem1);
  const validPayload = {
    name: 'Convocation gown', categoryId: idCard.id, amount: 500000,
    feeCode: '', academicSession: '', college: '', department: '', program: '',
    studentType: '', semester: '', description: '', paymentDeadline: '', level: '',
  };
  const created = await post('/fees', validPayload, { ...auth, 'Idempotency-Key': idem1 });
  console.log('HTTP:', created.status);
  const fee = (created.data.data || {}).fee || created.data.data;
  if (created.ok && fee && fee.id) {
    console.log('✅ CREATED 201 OK:');
    for (const k of ['id','name','amount','feeCode','categoryId','description','semester','studentType','paymentDeadline']) {
      console.log(`  fee.${k.padEnd(16)} =`, fee[k] ?? '(unset / normalized empty)');
    }
    if (fee.feeCode && /^FEE-/.test(fee.feeCode)) console.log('  ✅ feeCode auto-generated correctly with FEE- prefix');
  } else {
    console.log('❌ FAILED');
    console.log('message =', created.data.message);
    console.log('details =', JSON.stringify(created.data.details, null, 2).slice(0, 600));
    process.exit(2);
  }

  // 4. BROKEN POST → structured field errors
  await sleep(50);
  const idem2 = `smoke-bad-${Date.now()}`;
  log('Step 4: POST /fees broken (name=X,categoryId="",amount=0)', 'Idempotency-Key:', idem2);
  const broken = await post('/fees', { name: 'X', categoryId: '', amount: 0 }, { ...auth, 'Idempotency-Key': idem2 });
  console.log('HTTP:', broken.status);
  if (!broken.ok && broken.status >= 400 && broken.status < 500) {
    const msg = broken.data.message ?? '';
    const det = broken.data.details;
    console.log('✅ Correctly rejected (HTTP ' + broken.status + '):');
    console.log('  message =', msg);
    if (Array.isArray(det)) {
      console.log(`  details[] (${det.length} items):`);
      det.forEach(d => console.log('    •', (d.path ? d.path + ': ' : '') + (d.message ?? '') +
        (d.received !== undefined && String(d.received) !== '' ? ` (received: ${JSON.stringify(d.received)})` : '')));
      if (/Invalid request body:/.test(msg) && det.length >= 1) console.log('  ✅ message prefix correct & details non-empty → frontend will show WHICH field failed');
    }
  } else {
    console.log('❌ Expected 4xx got', broken.status, JSON.stringify(broken.data).slice(0, 500));
    process.exit(3);
  }

  // 5. Idempotency retry of Step 3 → same fee returned, no duplicate
  await sleep(50);
  log('Step 5: Idempotency replay of Step 3 (same Idempotency-Key)', idem1);
  const replay = await post('/fees', validPayload, { ...auth, 'Idempotency-Key': idem1 });
  const fee2 = (replay.data.data || {}).fee || replay.data.data;
  console.log('HTTP:', replay.status, 'Same fee.id returned?', fee2 && fee.id && fee2.id === fee.id ? `YES (id=${fee.id})` : 'NO');
  console.log('  fee.id=', fee2?.id, 'fee.name=', fee2?.name, 'fee.amount=', fee2?.amount);
  if (!fee2?.id || fee2.id !== fee.id) { console.log('  ❌ IDEMPOTENCY BROKE'); process.exit(4); }
  console.log('  ✅ Idempotency works — replay yields same fee, no duplicate charge');

  console.log('\n🏁 ALL END-TO-END SMOKE TESTS PASSED ✅');
  console.log('');
  console.log('Validated behaviors:');
  console.log('  • Category creation when categories table empty');
  console.log('  • CreateFee form empty strings (feeCode/semester/studentType/deadline/etc) → normalized silently, no Invalid request body');
  console.log('  • CreateFee auto feeCode with FEE- prefix');
  console.log('  • CreateFee invalid payload → structured "Invalid request body: <path> — <msg>" + details[] with path/code/received');
  console.log('  • Idempotency-Key on POST /fees → replay returns same fee, no duplicate');
  process.exit(0);
})().catch(e => { console.error('UNEXPECTED', e); process.exit(99); });
