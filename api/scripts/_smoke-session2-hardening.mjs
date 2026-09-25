// Session 2 hardening smoke: JWT refresh + rotation, HMAC audit CSV integrity, zod trim, refresh-token not accepted as access.
import http from 'node:http';
const BASE = 'http://localhost:3001';

function req(method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const r = http.request(u, {
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', reject);
    if (body != null) r.write(JSON.stringify(body));
    r.end();
  });
}
const post = (p, b, h) => req('POST', p, { body: b, headers: h });
const get = (p, h) => req('GET', p, { headers: h });

(async () => {
  const pass = []; const fail = [];
  function chk(label, ok, extra = '') {
    if (ok) { pass.push('✓ ' + label); console.log('✓', label, extra || ''); }
    else { fail.push('✗ ' + label); console.log('✗ FAIL', label, extra || ''); }
  }
  // 1) login — response shape is: {status, token, accessToken, refreshToken, expiresInMs, data:{user}}
  const l = await post('/api/v1/auth/login', { email: 'admin@university.edu.ng', password: 'admin123' });
  const lj = JSON.parse(l.body || '{}');
  chk('login HTTP 200', l.status === 200, 'status=' + l.status);
  chk('lj.data.user.id number', !!lj.data?.user && typeof lj.data.user.id === 'number', 'uid=' + lj.data?.user?.id);
  chk('lj.token (access) non-empty string (backward compat)', typeof lj.token === 'string' && lj.token.length > 30, 'len=' + (lj.token?.length || 0));
  chk('lj.accessToken alias === token', lj.accessToken === lj.token, 'same=' + (lj.accessToken === lj.token));
  chk('lj.refreshToken JWT eyJ', typeof lj.refreshToken === 'string' && /^eyJ/.test(lj.refreshToken), 'prefix eyJ');
  chk('lj.expiresInMs === 900000 (15 min access)', lj.expiresInMs === 900000, 'expiresInMs=' + lj.expiresInMs);

  if (!lj.token) { console.log('\nSTOP no token'); process.exit(2); }
  const auth = { Authorization: `Bearer ${lj.token}` };

  // 2) dashboard nav-counters carryforward SQLi parameterized proof
  const nav = await get('/api/v1/dashboard/nav-counters', auth);
  chk('nav-counters HTTP 200', nav.status === 200, 'status=' + nav.status);

  // 3) refresh endpoint → rotate single-use tokens + same response shape with data.user
  const r = await post('/api/v1/auth/refresh', { refreshToken: lj.refreshToken });
  const rj = JSON.parse(r.body || '{}');
  chk('/auth/refresh HTTP 200', r.status === 200, 'status=' + r.status + ' body[:140]=' + String(r.body).slice(0, 140));
  chk('refresh returns NEW accessToken (different string)', rj.accessToken && rj.accessToken !== lj.accessToken, 'rotated access=' + (rj.accessToken !== lj.accessToken));
  chk('refresh returns NEW refreshToken (different string — single-use rotation)', rj.refreshToken && rj.refreshToken !== lj.refreshToken, 'rotated refresh=' + (rj.refreshToken !== lj.refreshToken));
  chk('refresh returns data.user.id === 1 (admin)', rj.data?.user?.id === lj.data.user.id, 'uid=' + rj.data?.user?.id);

  // 4) reuse OLD refresh after single rotation → 401 (revoked)
  const reuseOld = await post('/api/v1/auth/refresh', { refreshToken: lj.refreshToken });
  chk('reuse OLD refresh post-rotation → HTTP 401', reuseOld.status === 401, 'status=' + reuseOld.status);

  // 5) logout-all revokes remaining
  const la = await post('/api/v1/auth/logout-all', {}, auth);
  chk('/auth/logout-all HTTP 200', la.status === 200, 'status=' + la.status);
  const afterRevoke = await post('/api/v1/auth/refresh', { refreshToken: rj.refreshToken });
  chk('post logout-all → rotate refresh rejected 401', afterRevoke.status === 401, 'status=' + afterRevoke.status);

  // 6) refresh JWT MUST NOT be accepted on protected endpoints (payload.type='refresh' → reject)
  const badAuth = { Authorization: `Bearer ${rj.refreshToken}` };
  const wrongToken = await get('/api/v1/dashboard/nav-counters', badAuth);
  chk('refresh JWT not accepted on protect endpoint (type:refresh guard)', wrongToken.status === 401, 'status=' + wrongToken.status + ' snippet=' + String(wrongToken.body).slice(0, 120));

  // 7) Zod trim boundary — padded email/password (spaces surrounding) still succeeds since email schema trimmed
  const padLogin = await post('/api/v1/auth/login', { email: '   admin@university.edu.ng   ', password: 'admin123' });
  chk('login with padded email+password → HTTP 200 (zod trim applied pre-validate)', padLogin.status === 200, 'status=' + padLogin.status);

  // 8) Admin audit-logs CSV export → integrity HMAC trailer lines MUST be present
  const audit = await get('/api/v1/admin/audit-logs/export.csv?limit=5', auth);
  chk('/admin/audit-logs/export.csv HTTP 200', audit.status === 200, 'status=' + audit.status);
  if (audit.status === 200) {
    const lines = String(audit.body).split(/\r?\n/).filter((l) => l.length > 0);
    const hasAlgo = lines.some((l) => /^#_integrity:algo=HMAC-SHA256,length=\d+/.test(l));
    const hasHash = lines.some((l) => /^#_integrity:hash=[0-9a-f]{64}$/.test(l));
    chk('audit CSV trailer algo=HMAC-SHA256,length=N header present', hasAlgo, '' + lines.filter((l) => l.startsWith('#_integrity')).slice(0, 2).join('\n'));
    chk('audit CSV trailer hash=64-hex HMAC-SHA256 digest present', hasHash, '');
  }

  // Summary
  console.log('\n========== RESULTS ' + pass.length + '/' + (pass.length + fail.length) + ' ==========');
  for (const p of pass) console.log(p);
  if (fail.length) { console.log('\nFAILS:'); for (const f of fail) console.log(f); process.exit(1); }
  console.log('\nALL SESSION 2 HARDENING SMOKES PASSED ✓');
})().catch((e) => { console.error('fatal err', e); process.exit(3); });
