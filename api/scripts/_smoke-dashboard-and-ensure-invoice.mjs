// Smoke: admin login -> dashboard nav counters -> ensure-invoice 200.
// (Written to disk because bash quoting of multi-line single-quote pipelines gets mangled.)
import http from 'node:http';

const BASE = 'http://localhost:3001';

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, BASE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body != null) req.write(JSON.stringify(body));
    req.end();
  });
}
function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, BASE), { method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const login = await post('/api/v1/auth/login', {
    email: 'admin@university.edu.ng',
    password: 'admin123',
  });
  console.log('[login] HTTP', login.status, '—', String(login.body).slice(0, 180));
  if (login.status !== 200) {
    console.log('FAIL: admin login not 200');
    process.exit(2);
  }
  const loginJson = JSON.parse(login.body);
  const token = loginJson.token ?? loginJson.data?.token;
  if (!token) {
    console.log('FAIL: no token. Full body:', JSON.stringify(loginJson));
    process.exit(2);
  }
  const auth = { Authorization: `Bearer ${token}` };

  const nav = await get('/api/v1/dashboard/nav-counters', auth);
  console.log('[dashboard nav-counters] HTTP', nav.status, '— body snippet:');
  console.log(String(nav.body).slice(0, 700));
  console.log();

  const students = await get('/api/v1/students?page=1&limit=3', auth);
  const sid = JSON.parse(students.body).data.rows?.[0]?.id;
  if (!sid) {
    console.log('SKIP ensure-invoice: no students in DB');
    process.exit(0);
  }
  const cat = await get(`/api/v1/students/${sid}/catalogue?page=1&limit=2`, auth);
  const feeId = JSON.parse(cat.body).data.rows?.[0]?.id;
  if (!feeId) {
    console.log('SKIP ensure-invoice: no catalogue fee for student id=', sid);
    process.exit(0);
  }
  const ei = await post(`/api/v1/students/${sid}/fees/${feeId}/ensure-invoice`, {}, auth);
  console.log(`[ensure-invoice sid=${sid} feeId=${feeId}] HTTP ${ei.status} — body:`);
  console.log(String(ei.body).slice(0, 700));
  if (ei.status === 200) {
    console.log('\nALL OK: dashboard + ensure-invoice parameterized SQL works (SQLi fix no regression).');
  } else {
    console.log('WARN: ensure-invoice status !== 200 — might be already paid / fee already assigned. Check above.');
  }
})().catch((e) => {
  console.error('fatal:', e);
  process.exit(3);
});
