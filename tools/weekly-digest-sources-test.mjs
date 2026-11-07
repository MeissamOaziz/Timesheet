// "Where new accounts came from" in the internal weekly digest (send-weekly-digest/sources.ts).
// Runs the pure helpers under Node (type stripping, Node 23.6+); no network, no database.
import { sourceLabel, sourceDetail, summariseSources, summariseHeard, sourcesSectionHtml, TRACKING_START }
  from '../supabase/functions/send-weekly-digest/sources.ts';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };
const after = '2026-11-10T12:00:00Z', before = '2026-10-01T12:00:00Z';

console.log('\n── labels ──');
ok('a utm source wins over the referrer', sourceLabel({ created_at: after, signup_utm_source: 'facebook', signup_referrer_host: 'www.google.com' }) === 'facebook');
ok('google.ca is a Google search', sourceLabel({ created_at: after, signup_referrer_host: 'www.google.ca' }) === 'google (search)');
ok('google.com is a Google search', sourceLabel({ created_at: after, signup_referrer_host: 'google.com' }) === 'google (search)');
ok('an untagged Facebook visit is named', sourceLabel({ created_at: after, signup_referrer_host: 'm.facebook.com' }) === 'facebook (no tag)');
ok('an untagged Instagram visit is named', sourceLabel({ created_at: after, signup_referrer_host: 'l.instagram.com' }) === 'instagram (no tag)');
ok('lnkd.in is LinkedIn', sourceLabel({ created_at: after, signup_referrer_host: 'lnkd.in' }) === 'linkedin (no tag)');
ok('bing is another search engine', sourceLabel({ created_at: after, signup_referrer_host: 'www.bing.com' }) === 'other search');
ok('a look-alike domain is not Google', sourceLabel({ created_at: after, signup_referrer_host: 'google.evil-site.com' }) === 'site: google.evil-site.com');
ok('any other site is shown by name', sourceLabel({ created_at: after, signup_referrer_host: 'www.reddit.com' }) === 'site: www.reddit.com');
ok('nothing recorded is direct / unknown', sourceLabel({ created_at: after }) === 'direct / unknown');

console.log('\n── per-account line ──');
ok('accounts from before tracking show nothing', sourceDetail({ created_at: before, signup_utm_source: 'facebook' }) === '');
const d = sourceDetail({ created_at: after, signup_utm_source: 'facebook', signup_utm_campaign: 'launch', signup_utm_content: 'p03-demo', signup_heard: 'accountant' });
ok('a tracked account shows source, campaign, post and answer', d === 'facebook · launch · p03-demo · said: Their accountant', d);
ok('tracking start is Nov 7', TRACKING_START.startsWith('2026-11-07'));

console.log('\n── counts ──');
const week = '2026-11-09T00:00:00Z';
const rows = [
  { created_at: '2026-11-12T10:00:00Z', signup_utm_source: 'facebook', signup_heard: 'facebook', stripe_subscription_id: 'sub_x' },
  { created_at: '2026-11-11T10:00:00Z', signup_utm_source: 'facebook' },
  { created_at: '2026-11-08T10:00:00Z', signup_utm_source: 'facebook', signup_heard: 'friend' },
  { created_at: '2026-11-10T10:00:00Z', signup_referrer_host: 'www.google.ca', signup_heard: 'google' },
  { created_at: '2026-11-08T09:00:00Z' },
];
const s = summariseSources(rows, week);
const fb = s.find(x => x.label === 'facebook');
ok('facebook: 3 total, 2 this week, 1 paying', fb && fb.total === 3 && fb.week === 2 && fb.paying === 1, JSON.stringify(fb));
ok('the biggest source comes first', s[0].label === 'facebook');
ok('google and direct are counted', s.some(x => x.label === 'google (search)' && x.total === 1) && s.some(x => x.label === 'direct / unknown' && x.total === 1));
const h = summariseHeard(rows);
ok('answers are named and blanks counted', h.some(x => x.answer === 'Facebook' && x.paying === 1) && h.some(x => x.answer === '(left blank)' && x.total === 2), JSON.stringify(h));

console.log('\n── html ──');
const html = sourcesSectionHtml([{ created_at: after, signup_utm_source: '<img src=x onerror=alert(1)>', signup_heard: '"><script>' }], week, TRACKING_START);
ok('hostile values are escaped', !/<img|<script/i.test(html) && /&lt;img/.test(html));
ok('the empty state says so', /No new accounts since 2026-11-07/.test(sourcesSectionHtml([], week, TRACKING_START)));
const full = sourcesSectionHtml(rows, week, TRACKING_START);
ok('the table has the expected columns', /This week/.test(full) && /Since 2026-11-07/.test(full) && /Paying now/.test(full) && /How did you hear about us/.test(full));
ok('no customer data is needed (no email field used)', !/@/.test(full));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
