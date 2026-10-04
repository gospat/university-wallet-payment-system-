import http from 'node:http';
const BASE='http://localhost:3001';
function pst(p,b,h){return new Promise((res,rej)=>{const u=new URL(p,BASE);const r=http.request(u,{method:'POST',headers:{'Content-Type':'application/json',...(h||{})}},(x)=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>res({s:x.statusCode,b:d}));});r.on('error',rej);if(b!=null)r.write(JSON.stringify(b));r.end();});}
function gt(p,h){return new Promise((res,rej)=>{const u=new URL(p,BASE);const r=http.request(u,{method:'GET',headers:{...(h||{})}},(x)=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>res({s:x.statusCode,b:d}));});r.on('error',rej);r.end();});}
(async()=>{
  const l=await pst('/api/v1/auth/login',{email:'admin@university.edu.ng',password:'admin123'});
  console.log('login HTTP',l.s);
  const lj=JSON.parse(l.b||'{}');
  console.log('TOP KEYS:',Object.keys(lj).sort());
  if(lj.data)console.log('DATA KEYS:',Object.keys(lj.data).sort());
  if(lj.data?.user)console.log('USER.id:', lj.data.user.id, 'role:', lj.data.user.role);
  console.log('TOKEN LEN:', String(lj.data?.token||lj.token||'').length);
  const tok=lj.data?.token||lj.token;
  const auth={Authorization:'Bearer '+tok};
  // find audit-logs export URL
  const paths=['/admin/audit-logs/export','/admin/audit/export','/admin/audit-logs.csv','/bursary/audit-logs/export','/admin/audit/download','/admin/activity/export'];
  for(const p of paths){
    const r=await gt('/api/v1'+p+'?limit=3&format=csv',auth);
    console.log('TRY',p,'HTTP',r.s,'body[:160]=',String(r.b).slice(0,160));
  }
  // refresh flow check keys
  const rj=JSON.parse((await pst('/api/v1/auth/refresh',{refreshToken:lj.data?.refreshToken||lj.refreshToken})).b);
  console.log('REFRESH TOP KEYS:',Object.keys(rj).sort());
  if(rj.data)console.log('REFRESH DATA KEYS:',Object.keys(rj.data).sort());
})().catch(e=>{console.error(e);process.exit(3)});
