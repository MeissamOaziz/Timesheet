// PunchClock Pro — Period Summary Email
// Supabase Edge Function: send-period-summary
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
function toDateStr(d) {
  return d.toLocaleDateString('en-CA');
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function getPeriodInfo(today, weekStart, frequency) {
  const startDow = weekStart === 'sunday' ? 0 : 1;
  const todayDow = today.getDay();
  if (frequency === 'monthly') {
    if (today.getDate() !== 1) return null;
    const periodEnd = addDays(today, -1);
    const periodStart = new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1);
    return {
      isFirstDay: true,
      periodStart,
      periodEnd
    };
  }
  if (todayDow !== startDow) return null;
  const periodEnd = addDays(today, -1);
  const days = frequency === 'weekly' ? 7 : 14;
  const periodStart = addDays(periodEnd, -(days - 1));
  return {
    isFirstDay: true,
    periodStart,
    periodEnd
  };
}
function formatTime(t) {
  const [hStr, mStr] = t.split(':');
  const h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${mStr} ${ampm}`;
}
function formatHours(h) {
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  return `${hrs}h ${mins}m`;
}
function buildEmailHtml(params) {
  const { empName, companyName, siteName, periodStart, periodEnd, frequency, punches, punchRounding } = params;
  const _rMs = (iso) => { const ms = new Date(iso).getTime(); if (!punchRounding) return ms; const step = punchRounding * 60000; return Math.round(ms / step) * step; };
  const sorted = [
    ...punches
  ].sort((a, b)=>new Date(a.punched_at).getTime() - new Date(b.punched_at).getTime());
  const byDate = {};
  sorted.forEach((p)=>{
    if (!byDate[p.punch_date]) byDate[p.punch_date] = [];
    byDate[p.punch_date].push(p);
  });
  const freqLabel = {
    weekly: 'Weekly',
    biweekly: 'Bi-Weekly',
    monthly: 'Monthly'
  };
  let dayRowsHtml = '';
  let grandTotalHours = 0;
  let grandTotalSessions = 0;
  const dates = Object.keys(byDate).sort();
  for (const date of dates){
    const dayPunches = byDate[date];
    const d = new Date(date + 'T12:00:00');
    const dayLabel = d.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric'
    });
    const sessions = [];
    let i = 0;
    while(i < dayPunches.length){
      const p = dayPunches[i];
      if (p.type === 'IN') {
        const next = dayPunches[i + 1]?.type === 'OUT' ? dayPunches[i + 1] : null;
        const hours = next ? (_rMs(next.punched_at) - _rMs(p.punched_at)) / 3600000 : null;
        sessions.push({
          inTime: p.punch_time,
          outTime: next?.punch_time || null,
          hours
        });
        if (next) i += 2;
        else i++;
      } else i++;
    }
    const dayTotal = sessions.reduce((s, r)=>s + (r.hours ?? 0), 0);
    grandTotalHours += dayTotal;
    grandTotalSessions += sessions.length;
    const sessionRows = sessions.map((s)=>`
      <tr>
        <td style="padding:6px 12px;font-size:13px;color:#64748b;padding-left:28px">↳</td>
        <td style="padding:6px 12px;font-size:13px;color:#22c55e;font-family:monospace">${formatTime(s.inTime)}</td>
        <td style="padding:6px 12px;font-size:13px;color:#ef4444;font-family:monospace">${s.outTime ? formatTime(s.outTime) : '<span style="color:#94a3b8">Still in</span>'}</td>
        <td style="padding:6px 12px;font-size:13px;font-family:monospace;color:#334155">${s.hours !== null ? formatHours(s.hours) : '—'}</td>
      </tr>`).join('');
    dayRowsHtml += `
      <tr style="background:#f8fafc">
        <td colspan="4" style="padding:10px 12px;font-weight:600;font-size:13px;color:#1e293b;border-top:1px solid #e2e8f0">
          ${dayLabel}
          <span style="float:right;font-weight:700;color:#4f8ef7">${formatHours(dayTotal)}</span>
        </td>
      </tr>
      ${sessionRows}`;
  }
  if (!dayRowsHtml) {
    dayRowsHtml = `<tr>
      <td colspan="4" style="padding:32px 20px;text-align:center">
        <div style="font-size:28px;margin-bottom:10px">📋</div>
        <div style="font-size:14px;font-weight:600;color:#334155;margin-bottom:6px">No hours recorded</div>
        <div style="font-size:13px;color:#94a3b8;line-height:1.6">No punch records were found for this period.<br>If this seems incorrect, please contact your manager.</div>
      </td>
    </tr>`;
  }
  const contextLine = siteName ? `${companyName} — ${siteName}` : companyName;
  const periodFmt = (d)=>{
    const dt = new Date(d + 'T12:00:00');
    return dt.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
  <tr>
    <td style="background:#ffffff;border-bottom:1px solid #e2e8f0;padding:24px 32px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td>
            <div style="font-size:20px;font-weight:700;color:#4f8ef7;letter-spacing:-0.5px">⏱ PunchClock Pro</div>
            <div style="font-size:13px;color:#64748b;margin-top:2px">${contextLine}</div>
          </td>
          <td align="right">
            <div style="background:rgba(79,142,247,0.12);border:1px solid rgba(79,142,247,0.3);border-radius:20px;padding:4px 14px;font-size:12px;font-weight:600;color:#2563eb;white-space:nowrap">
              ${freqLabel[frequency] || 'Period'} Summary
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:28px 32px 12px">
      <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#1e293b">Hi ${empName},</h1>
      <p style="margin:0;font-size:14px;color:#64748b;line-height:1.6">
        Here's your complete punch log for the ${freqLabel[frequency]?.toLowerCase() || ''} period ending
        <strong style="color:#334155">${periodFmt(periodEnd)}</strong>.
      </p>
    </td>
  </tr>
  <tr>
    <td style="padding:12px 32px">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
        <tr>
          <td style="padding:16px 20px;text-align:center;border-right:1px solid #e2e8f0">
            <div style="font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Period</div>
            <div style="font-size:13px;font-weight:700;color:#334155;margin-top:4px">${periodFmt(periodStart)}</div>
            <div style="font-size:11px;color:#94a3b8">to</div>
            <div style="font-size:13px;font-weight:700;color:#334155">${periodFmt(periodEnd)}</div>
          </td>
          <td style="padding:16px 20px;text-align:center;border-right:1px solid #e2e8f0">
            <div style="font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Total Hours</div>
            <div style="font-size:28px;font-weight:700;color:${grandTotalHours > 0 ? '#22c55e' : '#94a3b8'};margin-top:4px;font-family:monospace">${grandTotalHours > 0 ? formatHours(grandTotalHours) : '0h 0m'}</div>
          </td>
          <td style="padding:16px 20px;text-align:center">
            <div style="font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Sessions</div>
            <div style="font-size:28px;font-weight:700;color:${grandTotalSessions > 0 ? '#4f8ef7' : '#94a3b8'};margin-top:4px;font-family:monospace">${grandTotalSessions}</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:16px 32px 8px">
      <div style="font-size:12px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Detailed Punch Log</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
        <thead>
          <tr style="background:#f1f5f9">
            <th style="padding:9px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.4px">Day</th>
            <th style="padding:9px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.4px">Clock In</th>
            <th style="padding:9px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.4px">Clock Out</th>
            <th style="padding:9px 12px;text-align:left;font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.4px">Duration</th>
          </tr>
        </thead>
        <tbody>
          ${dayRowsHtml}
        </tbody>
        <tfoot>
          <tr style="background:#f1f5f9">
            <td colspan="3" style="padding:12px 16px;font-weight:700;font-size:14px;color:#1e293b">Grand Total</td>
            <td style="padding:12px 16px;font-weight:700;font-size:16px;color:${grandTotalHours > 0 ? '#22c55e' : '#94a3b8'};font-family:monospace">${grandTotalHours > 0 ? formatHours(grandTotalHours) : '—'}</td>
          </tr>
        </tfoot>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:24px 32px 32px">
      <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;text-align:center">
        This is an automated summary from <a href="https://www.punchclock.ca" style="color:#4f8ef7;text-decoration:none">PunchClock Pro</a>.<br>
        If you notice any errors, please contact your manager.
      </p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
async function sendEmail(to, subject, html, attachments) {
  const payload = {
    from: 'PunchClock Pro <noreply@punchclock.ca>',
    to: [
      to
    ],
    subject,
    html
  };
  if (attachments && attachments.length) payload.attachments = attachments;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error for ${to}: ${err}`);
  }
}
// ── Consolidated payroll summary ─────────────────────────────────────────────
// The per-employee email above tells one person their own hours. Whoever actually runs payroll
// needs the opposite shape: every employee's totals for the closed period, on one page, in an
// order they can type straight into a payroll system. Overtime is split out because it's paid
// at a different rate, and a CSV rides along so the numbers don't have to be retyped at all.

// Pair IN/OUT punches into worked hours. Mirrors the pairing the per-employee email and the
// in-app report use, so an accountant and an employee never see different numbers for the same
// week. An unclosed IN is skipped and surfaced separately as a warning rather than guessed at.
function totalsForPunches(punches, roundMin) {
  const round = (iso) => {
    const ms = new Date(iso).getTime();
    if (!roundMin) return ms;
    const step = roundMin * 60000;
    return Math.round(ms / step) * step;
  };
  const byDay = {};
  for (const p of punches) (byDay[p.punch_date] = byDay[p.punch_date] || []).push(p);

  let regular = 0, overtime = 0, openPunches = 0, days = 0;
  for (const date of Object.keys(byDay)) {
    const list = byDay[date].slice().sort((a, b) => new Date(a.punched_at) - new Date(b.punched_at));
    let dayHours = 0, openIn = null;
    for (const p of list) {
      if (p.type === 'IN') openIn = p;
      else if (p.type === 'OUT' && openIn) {
        dayHours += Math.max(0, (round(p.punched_at) - round(openIn.punched_at)) / 3600000);
        openIn = null;
      }
    }
    if (openIn) openPunches++;
    if (dayHours > 0) days++;
    // Daily overtime past 8h, matching the threshold used elsewhere in the app.
    const ot = Math.max(0, dayHours - 8);
    overtime += ot;
    regular += dayHours - ot;
  }
  return { regular, overtime, total: regular + overtime, openPunches, days };
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildPayrollCsv(rows, periodStart, periodEnd) {
  const head = ['Employee', 'Employee code', 'Site', 'Days worked', 'Regular hours', 'Overtime hours', 'Total hours', 'Period start', 'Period end'];
  const body = rows.map((r) => [
    r.name, r.code || '', r.site || '', r.days,
    r.regular.toFixed(2), r.overtime.toFixed(2), r.total.toFixed(2),
    periodStart, periodEnd
  ].map(csvEscape).join(','));
  return [head.join(','), ...body].join('\r\n');
}

function buildPayrollSummaryHtml(params) {
  const { companyName, scopeLabel, periodStart, periodEnd, freqLabel, rows, trackOvertime } = params;
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const warn = rows.filter((r) => r.openPunches > 0);
  const fmt = (h) => formatHours(h);

  const otHead = trackOvertime ? '<th style="padding:9px 12px;text-align:right;font-size:12px;color:#64748b;font-weight:600">Overtime</th>' : '';
  const rowsHtml = rows.map((r, i) => `
    <tr style="background:${i % 2 ? '#f8fafc' : '#ffffff'}">
      <td style="padding:9px 12px;font-size:13px;color:#0f172a">${r.name}${r.code ? ` <span style="color:#94a3b8">${r.code}</span>` : ''}</td>
      <td style="padding:9px 12px;font-size:13px;color:#64748b">${r.site || '—'}</td>
      <td style="padding:9px 12px;font-size:13px;color:#64748b;text-align:right">${r.days}</td>
      <td style="padding:9px 12px;font-size:13px;color:#0f172a;text-align:right;font-variant-numeric:tabular-nums">${fmt(r.regular)}</td>
      ${trackOvertime ? `<td style="padding:9px 12px;font-size:13px;text-align:right;color:${r.overtime > 0 ? '#b45309' : '#94a3b8'};font-variant-numeric:tabular-nums">${r.overtime > 0 ? fmt(r.overtime) : '—'}</td>` : ''}
      <td style="padding:9px 12px;font-size:13px;font-weight:700;color:#0f172a;text-align:right;font-variant-numeric:tabular-nums">${fmt(r.total)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:28px 14px"><tr><td align="center">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 22px rgba(15,23,42,.08)">
  <tr><td style="padding:20px 26px;border-bottom:1px solid #e2e8f0">
    <div style="font-size:18px;font-weight:700;color:#4f8ef7">&#9201; PunchClock Pro</div>
  </td></tr>
  <tr><td style="padding:24px 26px 8px">
    <h1 style="margin:0 0 6px;font-size:20px;color:#0f172a">${freqLabel} payroll summary</h1>
    <p style="margin:0 0 4px;font-size:14px;color:#475569">${companyName}${scopeLabel ? ` · ${scopeLabel}` : ''}</p>
    <p style="margin:0 0 18px;font-size:14px;color:#475569">Period <strong style="color:#0f172a">${periodStart}</strong> to <strong style="color:#0f172a">${periodEnd}</strong> (now closed)</p>
  </td></tr>
  <tr><td style="padding:0 26px">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;border-collapse:separate;border-spacing:0;overflow:hidden">
      <thead><tr style="background:#f1f5f9">
        <th style="padding:9px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600">Employee</th>
        <th style="padding:9px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600">Site</th>
        <th style="padding:9px 12px;text-align:right;font-size:12px;color:#64748b;font-weight:600">Days</th>
        <th style="padding:9px 12px;text-align:right;font-size:12px;color:#64748b;font-weight:600">Regular</th>
        ${otHead}
        <th style="padding:9px 12px;text-align:right;font-size:12px;color:#64748b;font-weight:600">Total</th>
      </tr></thead>
      <tbody>${rowsHtml || `<tr><td colspan="6" style="padding:22px;text-align:center;font-size:13px;color:#94a3b8">No hours recorded in this period.</td></tr>`}</tbody>
      ${rows.length ? `<tfoot><tr style="background:#f8fafc;border-top:2px solid #e2e8f0">
        <td style="padding:11px 12px;font-size:13px;font-weight:700;color:#0f172a" colspan="2">${rows.length} employee${rows.length === 1 ? '' : 's'}</td>
        <td style="padding:11px 12px;font-size:13px;font-weight:700;color:#0f172a;text-align:right">${sum('days')}</td>
        <td style="padding:11px 12px;font-size:13px;font-weight:700;color:#0f172a;text-align:right;font-variant-numeric:tabular-nums">${fmt(sum('regular'))}</td>
        ${trackOvertime ? `<td style="padding:11px 12px;font-size:13px;font-weight:700;color:#b45309;text-align:right;font-variant-numeric:tabular-nums">${fmt(sum('overtime'))}</td>` : ''}
        <td style="padding:11px 12px;font-size:14px;font-weight:700;color:#0f172a;text-align:right;font-variant-numeric:tabular-nums">${fmt(sum('total'))}</td>
      </tr></tfoot>` : ''}
    </table>
  </td></tr>
  ${warn.length ? `<tr><td style="padding:16px 26px 0">
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 14px;font-size:13px;color:#92400e;line-height:1.6">
      <strong>Check before you run payroll.</strong> ${warn.length} employee${warn.length === 1 ? '' : 's'} had a clock-in with no matching clock-out
      (${warn.map((w) => w.name).join(', ')}). Those shifts are not counted above until an admin corrects them in PunchClock.
    </div></td></tr>` : ''}
  <tr><td style="padding:18px 26px 26px">
    <p style="margin:0;font-size:12.5px;color:#64748b;line-height:1.65">
      The attached CSV has the same figures, ready to import or copy into payroll.
      Hours are paired clock-in to clock-out${params.roundMin ? `, rounded to the nearest ${params.roundMin} minutes` : ''}${trackOvertime ? ', with anything past 8 hours in a day counted as overtime' : ''}.
    </p>
  </td></tr>
  <tr><td style="padding:14px 26px;border-top:1px solid #e2e8f0;background:#f8fafc">
    <p style="margin:0;font-size:11.5px;color:#94a3b8;line-height:1.6">
      You receive this because an administrator at ${companyName} added you as a payroll report recipient in PunchClock Pro.
      Ask them to remove you if you'd rather not get it.
    </p>
  </td></tr>
</table></td></tr></table></body></html>`;
}

// Build the rows once per scope, then mail them to everyone in that scope.
async function buildSummaryRows(company, siteId, startStr, endStr) {
  let q = supabase.from('employees').select('id,name,emp_code,site_id').eq('company_id', company.id).eq('active', true);
  if (siteId) q = q.eq('site_id', siteId);
  const { data: emps, error } = await q;
  if (error) throw error;

  const { data: sites } = await supabase.from('sites').select('id,name').eq('company_id', company.id);
  const siteName = (id) => (sites || []).find((s) => s.id === id)?.name || null;

  const rows = [];
  for (const e of emps || []) {
    const { data: punches, error: pErr } = await supabase.from('punches')
      .select('type,punch_date,punched_at').eq('emp_id', e.id)
      .gte('punch_date', startStr).lte('punch_date', endStr)
      .order('punched_at', { ascending: true });
    if (pErr) throw pErr;
    const tot = totalsForPunches(punches || [], company.punch_rounding || 0);
    // Someone with no punches at all in the period is noise on a payroll sheet; someone with an
    // unclosed punch still needs to be seen, so they stay in.
    if (tot.total === 0 && tot.openPunches === 0) continue;
    rows.push({ name: e.name, code: e.emp_code, site: siteName(e.site_id), ...tot });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

async function sendPayrollSummaries(company, startStr, endStr, result) {
  const { data: recips, error } = await supabase.from('report_recipients')
    .select('id,email,site_id,label').eq('company_id', company.id).eq('active', true);
  if (error) throw error;
  if (!recips || !recips.length) return;

  const freqLabel = { weekly: 'Weekly', biweekly: 'Bi-weekly', monthly: 'Monthly' }[company.payroll_frequency || 'biweekly'] || 'Period';
  const { data: sites } = await supabase.from('sites').select('id,name').eq('company_id', company.id);

  // One set of figures per distinct scope, so ten recipients on the same scope cost one query.
  const scopes = [...new Set(recips.map((r) => r.site_id || ''))];
  for (const scope of scopes) {
    const siteId = scope || null;
    const scopeLabel = siteId ? ((sites || []).find((s) => s.id === siteId)?.name || null) : null;
    let rows;
    try {
      rows = await buildSummaryRows(company, siteId, startStr, endStr);
    } catch (e) {
      result.errors.push(`summary rows (${scopeLabel || 'all sites'}): ${e.message}`);
      continue;
    }
    const html = buildPayrollSummaryHtml({
      companyName: company.name, scopeLabel, periodStart: startStr, periodEnd: endStr,
      freqLabel, rows, trackOvertime: company.track_overtime !== false, roundMin: company.punch_rounding || 0
    });
    const csv = buildPayrollCsv(rows, startStr, endStr);
    const attachments = [{
      filename: `payroll-hours-${startStr}-to-${endStr}.csv`,
      content: btoa(unescape(encodeURIComponent(csv)))
    }];
    const subject = `${freqLabel} payroll summary — ${company.name}${scopeLabel ? ` (${scopeLabel})` : ''} · ${startStr} to ${endStr}`;
    for (const r of recips.filter((x) => (x.site_id || '') === scope)) {
      try {
        await sendEmail(r.email, subject, html, attachments);
        result.recipientsSent = (result.recipientsSent || 0) + 1;
      } catch (e) {
        result.errors.push(`recipient ${r.email}: ${e.message}`);
      }
    }
  }
}

async function sendToEmployee(emp, startStr, endStr, frequency, companyName, roundMin) {
  const { data: punches, error: pErr } = await supabase.from('punches').select('type,punch_date,punch_time,punched_at,site_name').eq('emp_id', emp.id).gte('punch_date', startStr).lte('punch_date', endStr).order('punched_at', {
    ascending: true
  });
  if (pErr) throw pErr;
  let siteName = null;
  if (emp.site_id) {
    const { data: site } = await supabase.from('sites').select('name').eq('id', emp.site_id).single();
    siteName = site?.name || null;
  }
  const freqLabel = {
    weekly: 'Weekly',
    biweekly: 'Bi-Weekly',
    monthly: 'Monthly'
  };
  const subject = `${freqLabel[frequency] || 'Period'} Hours Summary — ${companyName} (${startStr} → ${endStr})`;
  const html = buildEmailHtml({
    empName: emp.name,
    companyName,
    siteName,
    periodStart: startStr,
    periodEnd: endStr,
    frequency,
    punches: punches || [],
    punchRounding: roundMin || 0
  });
  await sendEmail(emp.email, subject, html);
}
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  try {
    if (req.method === 'POST') {
      const body = await req.json().catch(()=>({}));
      // "Send a test now" from the recipients panel: same email the cron would send, for the
      // period the admin picked, so a typo'd address gets caught before payroll day.
      if (body.test_recipients && body.company_id) {
        const { data: co, error: cErr } = await supabase.from('companies').select('*').eq('id', body.company_id).single();
        if (cErr || !co) throw new Error('Company not found');
        const info = getPeriodInfo(addDays(new Date(new Date().setHours(0, 0, 0, 0)), 0), co.week_start || 'monday', co.payroll_frequency || 'biweekly');
        // The cron only fires on the first day of a period; a test can run any day, so fall back
        // to the period that ended yesterday.
        const endStr = body.end_date || toDateStr(info ? info.periodEnd : addDays(today, -1));
        const startStr = body.start_date || toDateStr(info ? info.periodStart
          : addDays(addDays(today, -1), -((co.payroll_frequency === 'weekly' ? 7 : 14) - 1)));
        const result = { company: co.name, sent: 0, skipped: 0, errors: [], recipientsSent: 0 };
        await sendPayrollSummaries(co, startStr, endStr, result);
        return new Response(JSON.stringify({
          success: result.errors.length === 0,
          test: true,
          period: { start: startStr, end: endStr },
          ...result
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      if (body.manual && body.emp_id) {
        const { data: emp, error: empErr } = await supabase.from('employees').select('*').eq('id', body.emp_id).single();
        if (empErr || !emp) throw new Error('Employee not found');
        if (!emp.email) throw new Error('Employee has no email address');
        const { data: co } = await supabase.from('companies').select('*').eq('id', emp.company_id).single();
        await sendToEmployee(emp, body.start_date, body.end_date, co?.payroll_frequency || 'biweekly', co?.name || 'Your Company', co?.punch_rounding || 0);
        return new Response(JSON.stringify({
          success: true,
          manual_sent: true,
          to: emp.email
        }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
    }
    const results = [];
    const { data: companies, error: coErr } = await supabase.from('companies').select('*');
    if (coErr) throw coErr;
    for (const company of companies || []){
      const companyResult = {
        company: company.name,
        sent: 0,
        skipped: 0,
        errors: []
      };
      const periodInfo = getPeriodInfo(today, company.week_start || 'monday', company.payroll_frequency || 'biweekly');
      if (!periodInfo) {
        companyResult.skipped++;
        results.push(companyResult);
        continue;
      }
      const { periodStart, periodEnd } = periodInfo;
      const startStr = toDateStr(periodStart);
      const endStr = toDateStr(periodEnd);
      const { data: employees, error: empErr } = await supabase.from('employees').select('*').eq('company_id', company.id).eq('active', true).eq('send_report', true).not('email', 'is', null);
      if (empErr) throw empErr;
      for (const emp of employees || []){
        if (!emp.email) {
          companyResult.skipped++;
          continue;
        }
        try {
          await sendToEmployee(emp, startStr, endStr, company.payroll_frequency || 'biweekly', company.name, company.punch_rounding || 0);
          companyResult.sent++;
        } catch (e) {
          companyResult.errors.push(`${emp.name}: ${e.message}`);
        }
      }
      // Whoever runs payroll gets the consolidated version. Kept outside the employee loop and
      // in its own try so a failure here can't stop employees getting their own summaries.
      try {
        await sendPayrollSummaries(company, startStr, endStr, companyResult);
      } catch (e) {
        companyResult.errors.push(`payroll recipients: ${e.message}`);
      }
      results.push(companyResult);
    }
    return new Response(JSON.stringify({
      success: true,
      date: toDateStr(today),
      results
    }, null, 2), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      success: false,
      error: e.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
