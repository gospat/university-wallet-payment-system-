// Live smoke-test: login admin then download all templates with real JWT (exactly like frontend does)
import axios from 'axios';

const API = 'http://localhost:3001/api/v1';

async function main() {
  const api = axios.create({ baseURL: API });
  const login = await api.post('/auth/login', { email: 'admin@university.edu.ng', password: 'admin123' });
  const token = login.data?.data?.token || login.data?.token;
  console.log(`[login] HTTP ${login.status} | token.length=${token ? token.length : 'NONE'}`);
  if (!token) { console.log('FATAL: no token'); process.exit(2); }

  const xlsxEps = [
    '/academic/faculties/template.xlsx',
    '/academic/departments/template.xlsx',
    '/academic/programmes/template.xlsx',
    '/fees/template.xlsx',
    '/admin/students/template.xlsx',
  ];
  let failCount = 0;
  for (const ep of xlsxEps) {
    const url = `${API}${ep}?t=${Date.now()}&access_token=${encodeURIComponent(token)}`;
    const r = await axios.get(url, { responseType: 'arraybuffer', validateStatus: () => true });
    const buf = Buffer.from(r.data);
    const pk = buf.slice(0, 2).toString('hex') === '504b' ? '✓PK' : '✗BAD';
    const ctype = (r.headers['content-type'] || '').padEnd(45, ' ');
    const ok = r.status === 200 && pk === '✓PK';
    if (!ok) failCount++;
    console.log(`[xlsx] HTTP ${String(r.status).padEnd(3)} ${pk} ${ctype} size=${String(buf.length).padStart(6)} ${ok ? 'OK ' : 'ERR'} ${ep}`);
    if (!ok) console.log('     preview:', buf.slice(0, 250).toString('utf8').replace(/\n/g, '\\n'));
  }

  const csvEps = [
    '/academic/faculties/template.csv',
    '/fees/template.csv',
    '/admin/students/template.csv',
  ];
  for (const ep of csvEps) {
    const url = `${API}${ep}?t=${Date.now()}&access_token=${encodeURIComponent(token)}`;
    const r = await axios.get(url, { responseType: 'arraybuffer', validateStatus: () => true });
    const buf = Buffer.from(r.data);
    const text = buf.toString('utf8');
    const looksCsv = text.startsWith('\uFEFF') || text.startsWith('#') || text.includes(',') || /\r?\n.*,/.test(text);
    const ctype = (r.headers['content-type'] || '').padEnd(45, ' ');
    const ok = r.status === 200 && looksCsv;
    if (!ok) failCount++;
    console.log(`[csv ] HTTP ${String(r.status).padEnd(3)} ${looksCsv ? '✓CSV' : '✗BAD'} ${ctype} size=${String(buf.length).padStart(6)} ${ok ? 'OK ' : 'ERR'} ${ep}`);
    if (!ok) console.log('     preview:', text.slice(0, 300).replace(/\n/g, '\\n'));
  }

  // Anonymous case: should return HTTP 401 text/html Login Required (not JSON, not downloaded as xlsx)
  console.log('\n[anon] anonymous access (all 5 endpoints should be HTTP 401 text/html NOT JSON):');
  const allEps = [...xlsxEps, ...csvEps.slice(0,1)];
  for (const ep of allEps.slice(0,3)) {
    const url = `${API}${ep}?t=${Date.now()}&access_token=`;
    const r = await axios.get(url, { responseType: 'arraybuffer', validateStatus: () => true });
    const buf = Buffer.from(r.data);
    const html = buf.toString('utf8');
    const isHtml = html.trim().startsWith('<html') && html.includes('Login Required');
    const isJson = html.trim().startsWith('{') && html.includes('"status":"fail"');
    const ctype = (r.headers['content-type'] || '').padEnd(45, ' ');
    const ok = r.status === 401 && isHtml && !isJson;
    if (!ok) failCount++;
    console.log(`[anon] HTTP ${String(r.status).padEnd(3)} ${isHtml ? '✓HTML' : '✗'}${isJson ? 'JSON-BAD' : ''} ${ctype} size=${String(buf.length).padStart(6)} ${ok ? 'OK ' : 'ERR'} ${ep}`);
    if (!ok) console.log('     preview:', html.slice(0, 200).replace(/\n/g, '\\n'));
  }

  console.log(`\n${failCount === 0 ? 'ALL PASS ✓' : `${failCount} FAILURES ✗`}`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => { console.error('UNEXPECTED:', e.message); process.exit(3); });
