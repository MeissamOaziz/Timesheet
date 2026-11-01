// Offline check of the server-to-server gate on the mail functions that the browsers used to call directly:
// churn-survey, send-period-summary, notify-missed-punch, notify-time-off.
// Each must answer 401 to the public key, to no credential and to a wrong bearer (before reading the body),
// and 200 {ok:true} to an auth_probe carrying the service key or the cron secret. Nothing is sent: the
// database and the mail provider are stubbed, and any call to the mail provider fails the test.
// Usage: node tools/secure-db-regression/function-gate-test.mjs   (run from the repo root; Node 22+)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVICE = 'svc-key-0123456789', CRON = 'c'.repeat(64), ANON = 'anon-public-key';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-gate-'));
let mailCalls = 0, failures = 0;
const log = (ok, name, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };

globalThis.fetch = async (u) => {
  const url = String(u);
  if (/api\.resend\.com/.test(url)) { mailCalls++; return new Response('{}', { status: 200 }); }
  if (/internal_secrets/.test(url)) return new Response(JSON.stringify([{ value: CRON }]), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
};

async function load(name) {
  const src = fs.readFileSync(`supabase/functions/${name}/index.ts`, 'utf8');
  const out = path.join(scratch, `${name}.ts`);
  fs.writeFileSync(out,
    `globalThis.Deno={env:{get:(k)=>({SUPABASE_URL:'https://fake.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'${SERVICE}',RESEND_API_KEY:'re_test'}[k])},serve:(h)=>{globalThis.__H=h;}};\n` +
    `globalThis.createClient=()=>({from:()=>({select:()=>({}),update:()=>({})}),rpc:async()=>({data:true})});\n` +
    src.replace(/^import .*$/gm, ''));
  globalThis.__H = null;
  await import(pathToFileURL(out).href + '?v=' + Date.now());
  return globalThis.__H;
}
const call = (h, headers, body) => h(new Request('https://fn/x', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) }));

for (const name of ['churn-survey', 'send-period-summary', 'notify-missed-punch', 'notify-time-off']) {
  const h = await load(name);
  const before = mailCalls;
  let r = await call(h, { authorization: `Bearer ${ANON}`, apikey: ANON }, { action: 'auth_probe' });
  log(r.status === 401, `${name}: public key refused`, String(r.status));
  r = await call(h, {}, { action: 'auth_probe' });
  log(r.status === 401, `${name}: no credential refused`, String(r.status));
  r = await call(h, { authorization: 'Bearer ' + SERVICE.slice(0, -1) + 'x' }, { action: 'auth_probe' });
  log(r.status === 401, `${name}: wrong bearer refused`, String(r.status));
  r = await call(h, { authorization: 'Bearer ' + CRON.slice(0, -1) + 'x' }, { action: 'auth_probe' });
  log(r.status === 401, `${name}: wrong cron secret refused`, String(r.status));
  r = await call(h, { authorization: `Bearer ${SERVICE}` }, { action: 'auth_probe' });
  let j = await r.json().catch(() => null);
  log(r.status === 200 && j && j.ok === true, `${name}: service key accepted (auth_probe)`, String(r.status));
  r = await call(h, { authorization: `Bearer ${CRON}` }, { action: 'auth_probe' });
  j = await r.json().catch(() => null);
  log(r.status === 200 && j && j.ok === true, `${name}: cron secret accepted (auth_probe)`, String(r.status));
  if (name.startsWith('notify-')) {
    r = await call(h, { authorization: `Bearer ${SERVICE}` }, { requestId: "x' or '1'='1" });
    log(r.status === 400, `${name}: request id must be a uuid`, String(r.status));
  }
  log(mailCalls === before, `${name}: no mail provider call during the checks`);
}
console.log(failures ? `\n${failures} FAILED` : '\nall gate checks passed');
process.exit(failures ? 1 : 0);
