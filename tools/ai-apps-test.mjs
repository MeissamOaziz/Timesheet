// The AI connector's two pages: connect.html (the consent page Claude and ChatGPT send people to) and the
// "AI apps" card in index.html. The network is stubbed: nothing real is contacted, nothing is written.
// What the server does with these requests is covered by tools/mcp-connector-test.mjs.
//   node tools/ai-apps-test.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.ico': 'image/x-icon' };
const served = [];   // every address asked of the static host (what GitHub Pages would see)
const server = await new Promise((r) => {
  const s = createServer(async (q, res) => {
    served.push(q.url);
    try {
      if (q.url.startsWith('/frame-host')) { res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>other site</title><iframe id="f" src="/connect.html#r=' + REQ + '" style="width:600px;height:700px"></iframe>'); return; }
      const rel = decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const f = normalize(join(ROOT, rel));
      if (!f.startsWith(normalize(ROOT)) || !(await stat(f)).isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      createReadStream(f).pipe(res);
    } catch { res.writeHead(404).end(); }
  });
  s.listen(0, '127.0.0.1', () => r(s));
});
const BASE = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && x !== '' ? '  -> ' + String(x).slice(0, 300) : ''}`); };
const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(data) });

// A request shaped like the real one (payload.signature). The page only passes it along.
const REQ = Buffer.from(JSON.stringify({ c: 'claude', r: 'https://claude.ai/api/mcp/auth_callback', ch: 'x'.repeat(43), s: 'st', exp: 9999999999 })).toString('base64url') + '.' + 'S'.repeat(43);
const REQ_GPT = Buffer.from(JSON.stringify({ c: 'chatgpt', r: 'https://chatgpt.com/connector_platform_oauth_redirect', ch: 'x'.repeat(43), s: null, exp: 9999999999 })).toString('base64url') + '.' + 'S'.repeat(43);
const CLAUDE_BACK = 'https://claude.ai/api/mcp/auth_callback?code=pcc_ac_TESTCODE&state=st&iss=x';
const HOSTILE_NAME = 'Mia <b>Manager</b><img src=x onerror="window.__xss=1">';
const G1 = '77777777-7777-4777-8777-777777777771', G2 = '77777777-7777-4777-8777-777777777772';

const browser = await chromium.launch();

// ── static checks ────────────────────────────────────────────────────────────────────────────
console.log('── static ──');
{
  const c = await readFile(join(ROOT, 'connect.html'), 'utf8');
  ok('connect.html loads nothing from another site (no external script, style, font or image)', !/<script[^>]+src=|<link[^>]+href="https?:|@import|url\(\s*["']?https?:/.test(c));
  ok('connect.html never writes text as HTML', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(c));
  ok('connect.html does not store the session it signs in with', !/setItem\(\s*['"]pc_sess/.test(c));
  ok('connect.html is not indexed and sends no referrer', /name="robots" content="noindex/.test(c) && /name="referrer" content="no-referrer"/.test(c));
  ok('connect.html has no leftover placeholder', !/__[A-Z_]+__/.test(c));
  const role = JSON.parse(Buffer.from(/SUPA_KEY='([^']+)'/.exec(c)[1].split('.')[1], 'base64url').toString()).role;
  ok('the only key in connect.html is the public one', role === 'anon' && !/service_role|sk_live|sk_test|re_[A-Za-z0-9]{10}/.test(c), role);
  const i = await readFile(join(ROOT, 'index.html'), 'utf8');
  // the two dictionaries (English first, French second) keep their ai.* strings on lines that start with 'ai.
  const en = i.split('\n').filter((l) => l.startsWith("'ai.")).flatMap((l) => [...l.matchAll(/'(ai\.[A-Za-z]+)':'/g)].map((m) => m[1]));
  const half = en.length / 2;
  ok('every ai.* string exists in English and in French', en.length > 60 && Number.isInteger(half) && en.slice(0, half).join() === en.slice(half).join(), en.length);
  const used = [...new Set([...i.matchAll(/t\('(ai\.[A-Za-z]+)'/g), ...i.matchAll(/data-i18n="(ai\.[A-Za-z]+)"/g)].map((m) => m[1]))];
  ok('every ai.* string the page uses is defined', used.every((k) => en.includes(k)) , used.filter((k) => !en.includes(k)).join());
}

// ── connect.html ─────────────────────────────────────────────────────────────────────────────
function wireConnect(page, state) {
  state.calls = []; state.rpcs = []; state.other = [];
  page.on('request', (rq) => { const u = rq.url(); if (!u.startsWith(BASE) && !/supabase\.co|claude\.ai|chatgpt\.com|evil\.example/.test(u)) state.other.push(u); });
  return Promise.all([
    page.route('**/functions/v1/secure-db', async (route) => {
      const b = JSON.parse(route.request().postData() || '{}'); state.calls.push(b);
      if (b.action === 'mcp_consent_info') {
        if (state.infoStatus) return json(route, state.infoBody || { error: 'x' }, state.infoStatus);
        if (!b.sessionToken) return json(route, { error: 'Unauthorized' }, 401);
        return json(route, state.info);
      }
      if (b.action === 'set_ai_apps') return json(route, { ok: true, enabled: true, cancelled: 0 });
      if (b.action === 'mcp_consent') return state.consentStatus ? json(route, state.consentBody || {}, state.consentStatus) : json(route, { ok: true, redirect: b.body.decision === 'deny' ? 'https://claude.ai/api/mcp/auth_callback?error=access_denied&state=st&iss=x' : state.redirect });
      return json(route, { error: 'Unknown action' }, 400);
    }),
    page.route('**/rest/v1/rpc/mint_admin_session', async (route) => {
      const b = JSON.parse(route.request().postData() || '{}'); state.rpcs.push(b);
      return json(route, b.p_pass === 'right-password' ? { ok: true, session_token: 'tok-from-login', admin_id: 'a1' } : { ok: false });
    }),
    page.route(/^https:\/\/(claude\.ai|claude\.com|chatgpt\.com|evil\.example)\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>arrived</title>arrived' })),
  ]);
}
const ownerInfo = { ok: true, app: 'claude', refused: null, person: 'Olivia Owner', role: 'owner', companies: ['Acme Decks', 'Acme <i>Fence</i>'], sites: null, plan_included: true };
async function openConnect(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 }, locale: opts.locale || 'en-CA' });
  const page = await ctx.newPage();
  const state = { info: opts.info || ownerInfo, redirect: opts.redirect || CLAUDE_BACK, errs: [] };
  Object.assign(state, opts.state || {});
  page.on('pageerror', (e) => state.errs.push(e.message));
  await wireConnect(page, state);
  if (opts.session !== false) await page.addInitScript((tok) => { try { if (location.pathname.includes('connect')) localStorage.setItem('pc_sess', JSON.stringify({ id: 'a1', token: tok })); } catch (_) { } }, opts.session || 'tok-stored');
  await page.goto(`${BASE}/connect.html${opts.hash === undefined ? '#r=' + (opts.req || REQ) : opts.hash}`, { waitUntil: 'networkidle' });
  return { page, state, ctx };
}
const cardText = (page) => page.evaluate(() => document.getElementById('card').innerText);

console.log('\n── consent page: a signed-in owner ──');
{
  const { page, state, ctx } = await openConnect();
  const txt = await cardText(page);
  ok('names the app and that it is read-only', /Connect Claude to PunchClock Crew/.test(txt) && /Claude \(claude\.ai\) is asking for read-only access/.test(txt), txt.slice(0, 200));
  ok('shows who is signed in and their role', /Signed in as Olivia Owner \(account owner\)/.test(txt));
  ok('lists the companies in scope', /Acme Decks/.test(txt) && /Acme <i>Fence<\/i>/.test(txt));
  ok('a company name with HTML in it is shown as text', await page.evaluate(() => document.querySelector('#card i') === null));
  ok('says what it can read and what it never sees', /Punches and hours/.test(txt) && /PINs/.test(txt) && /GPS locations/.test(txt) && /cannot add, change or delete/.test(txt));
  ok('says who handles the answers', /handled by Anthropic under your own Claude account/.test(txt));
  ok('warns to continue only if you started it yourself', /Only continue if you started this yourself from Claude/.test(txt));
  ok('the request was sent to the server exactly as received, with the session', state.calls[0].action === 'mcp_consent_info' && state.calls[0].body.request === REQ && state.calls[0].sessionToken === 'tok-stored');
  ok('the request is gone from the address bar', await page.evaluate(() => location.hash === '' && !location.href.includes('r=')));
  ok('the static host never saw the request', !served.some((u) => u.includes(REQ.slice(0, 30))));
  await page.click('#cAllow');
  await page.waitForURL(/claude\.ai\/api\/mcp\/auth_callback/, { timeout: 5000 }).catch(() => { });
  const c = state.calls.find((x) => x.action === 'mcp_consent');
  ok('Allow -> one consent call (allow, same request, session) and nothing else', c && c.body.decision === 'allow' && c.body.request === REQ && c.sessionToken === 'tok-stored' && Object.keys(c.body).sort().join() === 'decision,request' && !state.calls.some((x) => x.action === 'set_ai_apps'));
  ok('...then the browser goes to the address the server gave', page.url() === CLAUDE_BACK, page.url());
  ok('no request to any other site, no page error', state.other.length === 0 && state.errs.length === 0, state.other.concat(state.errs).join(' | '));
  await ctx.close();
}

console.log('\n── consent page: the server answer is not trusted blindly ──');
for (const [name, bad] of [
  ['another site', 'https://evil.example/cb?code=pcc_ac_X'],
  ['a look-alike host', 'https://claude.ai.evil.example/api/mcp/auth_callback?code=X'],
  ['user-info trick', 'https://claude.ai@evil.example/api/mcp/auth_callback?code=X'],
  ['plain http', 'http://claude.ai/api/mcp/auth_callback?code=X'],
  ['a javascript: address', 'javascript:window.__xss=1'],
  ['another path on claude.ai', 'https://claude.ai/redirect?to=https://evil.example'],
]) {
  const { page, state, ctx } = await openConnect({ redirect: bad });
  await page.click('#cAllow');
  await page.waitForTimeout(400);
  ok(`${name}: the page stays put and shows an error`, page.url().startsWith(BASE) && /Something went wrong/.test(await cardText(page)) && !(await page.evaluate(() => window.__xss)), page.url());
  await ctx.close();
}
{
  for (const good of ['https://claude.com/api/mcp/auth_callback?code=X&state=s', 'https://chatgpt.com/connector_platform_oauth_redirect?code=X', 'https://chatgpt.com/connector/oauth/abc_123?code=X']) {
    const { page, ctx } = await openConnect({ redirect: good });
    await page.click('#cAllow');
    await page.waitForURL((u) => !String(u).startsWith(BASE), { timeout: 5000 }).catch(() => { });
    ok(`allowed return address ${new URL(good).host}${new URL(good).pathname.slice(0, 28)} is followed`, page.url() === good, page.url());
    await ctx.close();
  }
}

console.log('\n── consent page: Cancel ──');
{
  const { page, state, ctx } = await openConnect();
  await page.click('button.secondary');
  await page.waitForURL(/claude\.ai/, { timeout: 5000 }).catch(() => { });
  const c = state.calls.find((x) => x.action === 'mcp_consent');
  ok('Cancel -> deny, sent without the session', c && c.body.decision === 'deny' && c.sessionToken === null);
  ok('...and back to the app with access_denied', /error=access_denied/.test(page.url()), page.url());
  await ctx.close();
}

console.log('\n── consent page: AI apps switched off ──');
{
  const { page, state, ctx } = await openConnect({ info: { ...ownerInfo, refused: 'ai_apps_off' } });
  const txt = await cardText(page);
  ok('owner: told it is off and that they decide', /switched off for your account/.test(txt) && /Allow AI apps for my account/.test(txt));
  ok('owner: Allow is disabled until the box is ticked', await page.isDisabled('#cAllow'));
  await page.click('#cAllow', { force: true }).catch(() => { });
  await page.waitForTimeout(200);
  ok('...clicking it anyway sends nothing', !state.calls.some((x) => x.action === 'mcp_consent' || x.action === 'set_ai_apps'));
  await page.check('#cTick');
  ok('ticking enables Allow', !(await page.isDisabled('#cAllow')));
  await page.click('#cAllow');
  await page.waitForURL(/claude\.ai/, { timeout: 5000 }).catch(() => { });
  const order = state.calls.map((x) => x.action).filter((a) => a !== 'mcp_consent_info');
  const sw = state.calls.find((x) => x.action === 'set_ai_apps');
  ok('the switch is set first (owner action, session, enabled:true), then the consent', order.join() === 'set_ai_apps,mcp_consent' && sw.body.enabled === true && sw.sessionToken === 'tok-stored' && Object.keys(sw.body).join() === 'enabled', order.join());
  await ctx.close();
}
{
  const { page, state, ctx } = await openConnect({ info: { ...ownerInfo, role: 'manager', person: HOSTILE_NAME, sites: ['Main yard'], companies: ['Acme Fence'], refused: 'ai_apps_off' } });
  const txt = await cardText(page);
  ok('manager: told to ask the owner, no Allow button, no tick box', /Ask the account owner/.test(txt) && (await page.$('#cAllow')) === null && (await page.$('#cTick')) === null);
  ok('a hostile name is shown as text and runs nothing', txt.includes('<b>Manager</b>') && !(await page.evaluate(() => window.__xss || document.querySelector('#card img, #card b'))));
  ok('manager: sees their sites, not "everything"', /It would read only your sites/i.test(txt) && /Main yard/.test(txt));
  await ctx.close();
}
{
  const { page, ctx } = await openConnect({ info: { ok: true, app: 'claude', refused: 'super_admin' } });
  const txt = await cardText(page);
  ok('super admin: refused, nothing listed, no Allow', /cannot be connected to an AI app/.test(txt) && (await page.$('#cAllow')) === null && !/It can read/i.test(txt));
  await ctx.close();
}

console.log('\n── consent page: plan note, ChatGPT wording, French ──');
{
  const { page, ctx } = await openConnect({ req: REQ_GPT, info: { ...ownerInfo, app: 'chatgpt', plan_included: false }, redirect: 'https://chatgpt.com/connector_platform_oauth_redirect?code=X' });
  let txt = await cardText(page);
  ok('ChatGPT is named, with OpenAI as the handler', /Connect ChatGPT to PunchClock Crew/.test(txt) && /ChatGPT \(chatgpt\.com\)/.test(txt) && /handled by OpenAI/.test(txt) && !/Claude|Anthropic/.test(txt));
  ok('plan note: included from Growth, with a link to the plans', /included from the Growth plan/.test(txt) && await page.evaluate(() => [...document.querySelectorAll('#card a')].some((a) => a.href === 'https://www.punchclock.ca/#pricing' && a.rel === 'noopener')));
  await page.click('#langBtn');
  txt = await cardText(page);
  ok('French: heading, lists and buttons', /Connecter ChatGPT à PunchClock Crew/.test(txt) && /lecture seule/.test(txt) && /Les NIP/.test(txt) && /forfait Croissance/.test(txt) && /Annuler/.test(txt) && await page.evaluate(() => document.documentElement.lang === 'fr'));
  ok('French: nothing left in English on the card', !/\b(Allow|Cancel|Signed in|It can read|never sees)\b/i.test(txt), txt.slice(0, 300));
  await ctx.close();
}
{
  const { page, ctx } = await openConnect({ locale: 'fr-CA' });
  ok('a French browser starts in French', /Connecter Claude/.test(await cardText(page)));
  await ctx.close();
}

console.log('\n── consent page: not signed in ──');
{
  const { page, state, ctx } = await openConnect({ session: false });
  let txt = await cardText(page);
  ok('shows the sign-in form, naming the app', /Sign in to your PunchClock Crew admin account to choose what Claude may read/.test(txt) && (await page.$('#cEmail')) !== null && (await page.$('#cAllow')) === null);
  ok('nothing was asked of the server yet', state.calls.length === 0);
  await page.fill('#cEmail', '  Owner@Example.Test '); await page.fill('#cPass', 'wrong-password');
  await page.click('button.primary');
  await page.waitForTimeout(400);
  txt = await cardText(page);
  ok('wrong password -> one vague error, still on the form', /Wrong email or password, or too many attempts/.test(txt) && (await page.$('#cEmail')) !== null);
  ok('the address is sent trimmed and lower-case to the usual sign-in function', state.rpcs[0].p_email === 'owner@example.test');
  await page.fill('#cEmail', 'owner@example.test'); await page.fill('#cPass', 'right-password');
  await page.click('button.primary');
  await page.waitForSelector('#cAllow', { timeout: 5000 });
  const info = state.calls.find((x) => x.action === 'mcp_consent_info');
  ok('right password -> the consent screen, using the new session', info && info.sessionToken === 'tok-from-login');
  ok('the session is kept in memory only (not written to the browser)', await page.evaluate(() => localStorage.getItem('pc_sess') === null && sessionStorage.getItem('pc_sess') === null && !document.cookie));
  ok('the password is not left in the page', await page.evaluate(() => !document.documentElement.innerHTML.includes('right-password')));
  await page.click('.who .switch');
  ok('"Use another account" goes back to the sign-in form', (await page.$('#cEmail')) !== null && (await page.$('#cAllow')) === null);
  await ctx.close();
}
{
  const { page, state, ctx } = await openConnect({ session: 'tok-expired', state: { infoStatus: 401 } });
  ok('an expired stored session -> sign-in form', (await page.$('#cEmail')) !== null);
  await ctx.close();
}

console.log('\n── consent page: bad or missing request, framing ──');
{
  let r = await openConnect({ hash: '' });
  ok('opened without a request -> "Nothing to connect", no call', /Nothing to connect/.test(await cardText(r.page)) && r.state.calls.length === 0);
  await r.ctx.close();
  r = await openConnect({ hash: '#r=<script>alert(1)</script>' });
  ok('a request that is not the right shape is ignored', /Nothing to connect/.test(await cardText(r.page)) && r.state.calls.length === 0);
  await r.ctx.close();
  r = await openConnect({ state: { infoStatus: 400, infoBody: { ok: false, code: 'request_invalid' } } });
  ok('the server says the request expired -> says so, no buttons', /This request has expired/.test(await cardText(r.page)) && (await r.page.$('button.primary')) === null);
  await r.ctx.close();
  r = await openConnect({ state: { consentStatus: 429, consentBody: { ok: false, code: 'rate_limited' } } });
  await r.page.click('#cAllow'); await r.page.waitForTimeout(300);
  ok('rate limited -> says to wait, stays on the page', /Too many attempts/.test(await cardText(r.page)) && r.page.url().startsWith(BASE));
  await r.ctx.close();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const state = { info: ownerInfo, redirect: CLAUDE_BACK };
  await wireConnect(page, state);
  await page.addInitScript(() => { try { localStorage.setItem('pc_sess', JSON.stringify({ id: 'a1', token: 'tok-stored' })); } catch (_) { } });
  await page.goto(`${BASE}/frame-host`, { waitUntil: 'networkidle' });
  const frame = page.frames().find((f) => f.url().includes('connect.html'));
  const inner = await frame.evaluate(() => ({ text: document.body.innerText, buttons: document.querySelectorAll('button').length }));
  ok('inside another page\'s frame: refuses to show, no buttons, no call', /cannot be shown inside another page/.test(inner.text) && inner.buttons === 0 && state.calls.length === 0, JSON.stringify(inner));
  await ctx.close();
}

// ── index.html: the AI apps card ─────────────────────────────────────────────────────────────
console.log('\n── app: the AI apps card ──');
async function openApp(sess, listBody, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => { });
  const page = await ctx.newPage();
  const st = { calls: [], errs: [], list: listBody };
  page.on('pageerror', (e) => st.errs.push(e.message));
  await page.route('**/functions/v1/**', async (route) => {
    if (!route.request().url().endsWith('/secure-db')) return json(route, {});
    const b = JSON.parse(route.request().postData() || '{}'); st.calls.push(b);
    if (b.action === 'mcp_list_grants') return st.listStatus ? json(route, { error: 'x' }, st.listStatus) : json(route, st.list);
    if (b.action === 'set_ai_apps') { st.list = { ...st.list, enabled: b.body.enabled, grants: b.body.enabled ? st.list.grants : [] }; return json(route, { ok: true, enabled: b.body.enabled }); }
    if (b.action === 'mcp_revoke_grant') { st.list = { ...st.list, grants: st.list.grants.filter((x) => x.id !== b.body.grant_id) }; return json(route, { ok: true }); }
    if (b.action) return json(route, { ok: true });
    return json(route, []);
  });
  await page.route('**/rest/v1/rpc/**', (route) => json(route, {}));
  await page.route('**/*.supabase.co/storage/**', (r) => r.fulfill({ status: 404, body: '' }));
  await page.goto(`${BASE}/index.html${opts.query || ''}`, { waitUntil: 'networkidle' });
  await page.evaluate((s) => { Sess.set(s, false); hideLanding(); updateNav(); }, sess);
  return { page, st, ctx };
}
const OWNER = { id: 'a1', name: 'Olivia Owner', email: 'o@x.ca', role: 'admin', plan: 'growth', token: 'tok-admin' };
const MGR = { id: 'a2', name: 'Mia', email: 'm@x.ca', role: 'manager', plan: 'free', parent_admin_id: 'a1', token: 'tok-mgr' };
const URL_MCP = 'https://uziwymrwaeojhqaagqcm.supabase.co/functions/v1/mcp';
const grants = [
  { id: G1, app: 'claude', person: 'Olivia Owner', mine: true, connected_at: '2026-11-10T15:00:00Z', last_used_at: '2026-11-11T15:00:00Z' },
  { id: G2, app: 'chatgpt', person: HOSTILE_NAME, mine: false, connected_at: '2026-11-11T15:00:00Z', last_used_at: null },
  { id: "x');alert(1);//", app: 'claude', person: 'Bad Id', mine: false, connected_at: null, last_used_at: null },
];
const menuShown = (page) => page.evaluate(() => document.getElementById('ddAiAppsBtn').style.display !== 'none');
const bodyText = (page) => page.evaluate(() => document.getElementById('aiAppsBody').innerText);
{
  let r = await openApp(OWNER, {});
  ok('without the preview switch the menu entry is hidden', !(await menuShown(r.page)));
  await r.ctx.close();
  r = await openApp({ ...OWNER, role: 'super_admin' }, {}, { query: '?aiapps=1' });
  ok('super admin never sees it, even with the preview on', !(await menuShown(r.page)));
  await r.page.evaluate(() => openAiApps()); await r.page.waitForTimeout(200);
  ok('...and cannot open the card by hand', !r.st.calls.some((c) => c.action === 'mcp_list_grants') && !(await r.page.evaluate(() => document.getElementById('aiAppsModal').classList.contains('open'))));
  await r.ctx.close();
}
{
  // owner on a Growth plan, switched on, three rows from the server (one with a hostile name, one with a hostile id)
  const { page, st, ctx } = await openApp(OWNER, { ok: true, enabled: true, is_owner: true, plan_included: true, url: URL_MCP, grants }, { query: '?aiapps=1' });
  ok('with ?aiapps=1 the menu entry shows for an owner', await menuShown(page));
  await page.evaluate(() => openAiApps());
  await page.waitForSelector('#aiAppsSwitch');
  let txt = await bodyText(page);
  const call = st.calls.find((c) => c.action === 'mcp_list_grants');
  ok('opening it asks the server with the session', call && call.sessionToken === 'tok-admin');
  ok('the owner switch is shown, ticked', await page.isChecked('#aiAppsSwitch'));
  ok('the address to paste is shown', await page.inputValue('#aiAppsUrl') === URL_MCP);
  ok('two connections listed with app, person, dates', /Claude · Olivia Owner \(you\)/.test(txt) && /ChatGPT · Mia <b>Manager<\/b>/.test(txt) && /last used never/.test(txt), txt.slice(0, 400));
  ok('a hostile name is text only', !(await page.evaluate(() => window.__xss || document.querySelector('#aiAppsBody img, #aiAppsBody b'))));
  ok('a row whose id is not a real id is not drawn at all', (await page.$$('#aiAppsBody .ai-apps-row')).length === 2 && !/Bad Id/.test(txt));
  ok('no plan note on Growth', !/Growth plan/.test(txt));
  await page.click('#aiAppsBody button.btn-secondary'); await page.waitForTimeout(150);
  ok('Copy puts the address on the clipboard', (await page.evaluate(() => navigator.clipboard.readText()).catch(() => URL_MCP)) === URL_MCP);

  // disconnect: cancel first, then confirm
  await page.click('#aiAppsBody .ai-apps-row:nth-of-type(2) button.btn-danger').catch(async () => { await page.click('#aiAppsBody .ai-apps-row >> nth=1 >> button'); });
  await page.waitForSelector('#uiDlgOk');
  await page.click('#uiDlgCancel'); await page.waitForTimeout(150);
  ok('Disconnect asks first; Cancel sends nothing', !st.calls.some((c) => c.action === 'mcp_revoke_grant'));
  await page.click('#aiAppsBody .ai-apps-row >> nth=1 >> button');
  await page.waitForSelector('#uiDlgOk'); await page.click('#uiDlgOk');
  await page.waitForFunction(() => document.querySelectorAll('#aiAppsBody .ai-apps-row').length === 1, null, { timeout: 4000 }).catch(() => { });
  const rv = st.calls.find((c) => c.action === 'mcp_revoke_grant');
  ok('confirming sends that connection id only, with the session', rv && rv.body.grant_id === G2 && Object.keys(rv.body).join() === 'grant_id' && rv.sessionToken === 'tok-admin');
  ok('the list is reloaded from the server afterwards', (await page.$$('#aiAppsBody .ai-apps-row')).length === 1);

  // switch off: cancel keeps it on, confirm turns it off
  await page.click('#aiAppsSwitch'); await page.waitForSelector('#uiDlgOk');
  ok('switching off warns that everyone is disconnected', /disconnects every AI app/.test(await page.evaluate(() => document.getElementById('uiDialog').innerText)));
  await page.click('#uiDlgCancel'); await page.waitForTimeout(150);
  ok('Cancel leaves the switch on and sends nothing', await page.isChecked('#aiAppsSwitch') && !st.calls.some((c) => c.action === 'set_ai_apps'));
  await page.click('#aiAppsSwitch'); await page.waitForSelector('#uiDlgOk'); await page.click('#uiDlgOk');
  await page.waitForFunction(() => { const s = document.getElementById('aiAppsSwitch'); return s && !s.checked && !document.getElementById('aiAppsUrl'); }, null, { timeout: 4000 }).catch(() => { });
  const off = st.calls.find((c) => c.action === 'set_ai_apps');
  txt = await bodyText(page);
  ok('confirming sends enabled:false only', off && off.body.enabled === false && Object.keys(off.body).join() === 'enabled');
  ok('afterwards: switch off, no address offered, no connections', !(await page.isChecked('#aiAppsSwitch')) && (await page.$('#aiAppsUrl')) === null && /No AI app is connected/.test(txt));
  // switch on again
  await page.click('#aiAppsSwitch'); await page.waitForSelector('#uiDlgOk');
  ok('switching on explains what will be shared', /handled by Anthropic or OpenAI/.test(await page.evaluate(() => document.getElementById('uiDialog').innerText)));
  await page.click('#uiDlgOk');
  await page.waitForSelector('#aiAppsUrl', { timeout: 4000 }).catch(() => { });
  ok('confirming sends enabled:true', st.calls.filter((c) => c.action === 'set_ai_apps').pop().body.enabled === true && (await page.$('#aiAppsUrl')) !== null);
  ok('no page error', st.errs.length === 0, st.errs.join(' | '));
  await ctx.close();
}
{
  // a plan WITHOUT the feature: Free owner
  const { page, st, ctx } = await openApp({ ...OWNER, plan: 'free' }, { ok: true, enabled: false, is_owner: true, plan_included: false, url: URL_MCP, grants: [] }, { query: '?aiapps=1' });
  await page.evaluate(() => openAiApps()); await page.waitForSelector('#aiAppsSwitch');
  const txt = await bodyText(page);
  ok('Free plan: the card opens, says it is included from Growth and offers the upgrade', /included from the Growth plan/.test(txt) && (await page.$('#aiAppsBody .msg.info button.btn-primary')) !== null);
  ok('Free plan: switch shown, off; no address until it is on', !(await page.isChecked('#aiAppsSwitch')) && (await page.$('#aiAppsUrl')) === null);
  ok('Free plan: the rest of the app still works (no page error, company save path untouched)', st.errs.length === 0 && await page.evaluate(() => typeof saveCompanyInfo === 'function' || typeof openCompanyInfoModal === 'function'), st.errs.join(' | '));
  await ctx.close();
}
{
  // manager: no switch, only their own
  const { page, st, ctx } = await openApp(MGR, { ok: true, enabled: true, is_owner: false, plan_included: true, url: URL_MCP, grants: [grants[0]] }, { query: '?aiapps=1' });
  ok('a manager sees the menu entry too', await menuShown(page));
  await page.evaluate(() => openAiApps()); await page.waitForSelector('#aiAppsUrl');
  let txt = await bodyText(page);
  ok('manager: no switch, told the owner allows it, own connection without the person column', (await page.$('#aiAppsSwitch')) === null && /account owner allows AI apps/.test(txt) && /Claude\n/.test(txt + '\n') && !/Olivia Owner/.test(txt), txt.slice(0, 300));
  st.list = { ok: true, enabled: false, is_owner: false, plan_included: true, url: URL_MCP, grants: [] };
  await page.evaluate(() => loadAiApps()); await page.waitForTimeout(250);
  txt = await bodyText(page);
  ok('manager while it is off: told only the owner can allow it, no address', /Only the account owner can allow them/.test(txt) && (await page.$('#aiAppsUrl')) === null);
  await ctx.close();
}
{
  // French and a failing server
  const { page, st, ctx } = await openApp(OWNER, { ok: true, enabled: true, is_owner: true, plan_included: false, url: URL_MCP, grants: [grants[0]] }, { query: '?aiapps=1&lang=fr' });
  await page.evaluate(() => { _appLang = 'fr'; applyAllTranslations(); openAiApps(); });
  await page.waitForSelector('#aiAppsSwitch');
  const txt = await bodyText(page);
  ok('French card: intro, switch, plan note, connection line', /lecture seule/.test(txt) && /Autoriser les applications IA pour ce compte/.test(txt) && /forfait Croissance/.test(txt) && /Connectée le/.test(txt) && /Déconnecter/.test(txt), txt.slice(0, 400));
  ok('French menu entry', await page.evaluate(() => document.querySelector('#ddAiAppsBtn [data-i18n="ai.menu"]').textContent === 'Applications IA'));
  ok('no missing translation key', await page.evaluate(() => __missingI18n().filter((k) => k.startsWith('ai.')).length === 0));
  st.listStatus = 500;
  await page.evaluate(() => loadAiApps()); await page.waitForTimeout(300);
  ok('server error: a plain message, no stale switch', /Chargement impossible/.test(await bodyText(page)) && (await page.$('#aiAppsSwitch')) === null);
  await page.goto(`${BASE}/index.html?aiapps=0`, { waitUntil: 'networkidle' });
  await page.evaluate((s) => { Sess.set(s, false); updateNav(); }, OWNER);
  ok('?aiapps=0 hides the entry again', !(await menuShown(page)));
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
