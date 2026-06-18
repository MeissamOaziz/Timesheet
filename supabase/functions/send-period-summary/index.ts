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
  const { empName, companyName, siteName, periodStart, periodEnd, frequency, punches } = params;
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
        const hours = next ? (new Date(next.punched_at).getTime() - new Date(p.punched_at).getTime()) / 3600000 : null;
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
async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'PunchClock Pro <noreply@punchclock.ca>',
      to: [
        to
      ],
      subject,
      html
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error for ${to}: ${err}`);
  }
}
async function sendToEmployee(emp, startStr, endStr, frequency, companyName) {
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
    punches: punches || []
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
      if (body.manual && body.emp_id) {
        const { data: emp, error: empErr } = await supabase.from('employees').select('*').eq('id', body.emp_id).single();
        if (empErr || !emp) throw new Error('Employee not found');
        if (!emp.email) throw new Error('Employee has no email address');
        const { data: co } = await supabase.from('companies').select('*').eq('id', emp.company_id).single();
        await sendToEmployee(emp, body.start_date, body.end_date, co?.payroll_frequency || 'biweekly', co?.name || 'Your Company');
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
          await sendToEmployee(emp, startStr, endStr, company.payroll_frequency || 'biweekly', company.name);
          companyResult.sent++;
        } catch (e) {
          companyResult.errors.push(`${emp.name}: ${e.message}`);
        }
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
