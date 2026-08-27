// PunchClock Pro — Onboarding Drip Email Sequence
// Supabase Edge Function: send-onboarding
// Runs daily at 9am UTC via pg_cron
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const FROM_EMAIL = "PunchClock Pro <noreply@punchclock.ca>";
// The day-7 recap asks a question, so it cannot come from a no-reply address with a footer
// telling people not to reply. support@ is a real monitored alias.
const SUPPORT_EMAIL = "PunchClock Pro <support@punchclock.ca>";
const APP_URL = "https://www.punchclock.ca";

const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);

// ── Shared helpers ────────────────────────────────────────────────────────────
function wrapper(body: string, replyable = false): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
<div style="max-width:520px;margin:0 auto;padding:40px 20px;">
  <div style="text-align:center;margin-bottom:32px;">
    <span style="font-size:22px;font-weight:700;color:#4f8ef7;">&#9201; PunchClock Pro</span>
  </div>
  <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:36px 32px;">
    ${body}
  </div>
  <div style="text-align:center;margin-top:28px;">
    <p style="color:#5c6b7f;font-size:12px;">PunchClock Pro &mdash; Time &amp; Attendance Software<br>${replyable ? "Reply to this email and a real person will read it." : "This is an automated message, please do not reply."}</p>
  </div>
</div></body></html>`;
}

function ctaButton(text: string, url: string, color = "#4f8ef7"): string {
  return `<a href="${url}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:600;font-size:15px;width:100%;text-align:center;box-sizing:border-box;margin-top:8px">${text}</a>`;
}

function divider(): string {
  return `<hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0 28px">`;
}

function stepListEn(): string {
  return `<div style="margin:20px 0 24px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div style="width:28px;height:28px;border-radius:50%;background:#4f8ef7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">1</div>
      <span style="color:#1e293b;font-size:14px"><strong>Add your first site</strong> &mdash; name, location, optional geofence</span>
    </div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div style="width:28px;height:28px;border-radius:50%;background:#4f8ef7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">2</div>
      <span style="color:#1e293b;font-size:14px"><strong>Add employees</strong> &mdash; name, site, and 4-digit PIN</span>
    </div>
    <div style="display:flex;align-items:center;gap:12px">
      <div style="width:28px;height:28px;border-radius:50%;background:#4f8ef7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">3</div>
      <span style="color:#1e293b;font-size:14px"><strong>Start tracking</strong> &mdash; point any device at the clock page</span>
    </div>
  </div>`;
}

function stepListFr(): string {
  return `<div style="margin:20px 0 24px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div style="width:28px;height:28px;border-radius:50%;background:#4f8ef7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">1</div>
      <span style="color:#1e293b;font-size:14px"><strong>Ajoutez votre premier site</strong> &mdash; nom, emplacement, g&eacute;ofence optionnel</span>
    </div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <div style="width:28px;height:28px;border-radius:50%;background:#4f8ef7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">2</div>
      <span style="color:#1e293b;font-size:14px"><strong>Ajoutez des employ&eacute;s</strong> &mdash; nom, site et NIP &agrave; 4 chiffres</span>
    </div>
    <div style="display:flex;align-items:center;gap:12px">
      <div style="width:28px;height:28px;border-radius:50%;background:#4f8ef7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">3</div>
      <span style="color:#1e293b;font-size:14px"><strong>Commencez le suivi</strong> &mdash; pointez n&rsquo;importe quel appareil vers la page de pointage</span>
    </div>
  </div>`;
}

// ── Email templates ───────────────────────────────────────────────────────────
function buildDay1(name: string): { subject: string; html: string } {
  return {
    subject: "Welcome to PunchClock Pro — here’s how to get started 🎉 | Bienvenue sur PunchClock Pro",
    html: wrapper(`
      <!-- ENGLISH -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Welcome aboard, ${name}!</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        Your PunchClock Pro account is ready. Getting set up takes less than 5 minutes &mdash; just follow these 3 simple steps:
      </p>
      ${stepListEn()}
      ${ctaButton("Set Up My Account →", APP_URL)}
      <p style="color:#94a3b8;font-size:13px;margin-top:20px;text-align:center">You still have <strong style="color:#1e293b">6 days</strong> to explore &mdash; no credit card needed.</p>

      ${divider()}

      <!-- FRANÇAIS -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Bienvenue, ${name}!</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        Votre compte PunchClock Pro est pr&ecirc;t. La configuration prend moins de 5 minutes &mdash; suivez ces 3 &eacute;tapes simples&nbsp;:
      </p>
      ${stepListFr()}
      ${ctaButton("Configurer mon compte →", APP_URL)}
      <p style="color:#94a3b8;font-size:13px;margin-top:20px;text-align:center">Il vous reste encore <strong style="color:#1e293b">6 jours</strong> pour explorer &mdash; aucune carte de cr&eacute;dit requise.</p>
    `)
  };
}

function buildDay3(name: string): { subject: string; html: string } {
  return {
    subject: "Still getting set up? We’re here to help 👋 | Besoin d’aide?",
    html: wrapper(`
      <!-- ENGLISH -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Hi ${name}, need a hand?</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        We noticed you haven&rsquo;t added your first site yet. No worries &mdash; it only takes a couple of minutes.
      </p>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 8px">Quick reminder of the steps:</p>
      ${stepListEn()}
      ${ctaButton("Add My First Site →", APP_URL)}
      <p style="color:#64748b;font-size:13px;margin-top:20px;text-align:center;font-weight:600">Free plan &mdash; no time limit, no card.</p>

      ${divider()}

      <!-- FRANÇAIS -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Bonjour ${name}, besoin d&rsquo;un coup de main&nbsp;?</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        Nous avons remarqu&eacute; que vous n&rsquo;avez pas encore ajout&eacute; votre premier site. Pas d&rsquo;inqui&eacute;tude &mdash; &ccedil;a ne prend que quelques minutes.
      </p>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 8px">Rappel des &eacute;tapes&nbsp;:</p>
      ${stepListFr()}
      ${ctaButton("Ajouter mon premier site →", APP_URL)}
      <p style="color:#64748b;font-size:13px;margin-top:20px;text-align:center;font-weight:600">Forfait gratuit &mdash; sans limite de dur&eacute;e, sans carte.</p>
    `)
  };
}

// Stalled after adding people but before any punch — by far the most common way a trial dies.
// The usual cause is not knowing the employee PIN, so that is what this email leads with.
function buildNoPunch(name: string, dayLabelEn: string, dayLabelFr: string): { subject: string; html: string } {
  // This used to teach the workaround it had to teach at the time: reveal an employee's PIN
  // one row at a time and punch on their behalf. It never mentioned putting a tablet at the
  // door, which is the actual product and the exact step the funnel dies on. The kiosk wizard
  // and printable PIN cards now exist, so it points at those instead.
  return {
    subject: "Your team is set up — one tablet away from clocking in ⏱ | Une tablette et c'est parti",
    html: wrapper(`
      <!-- ENGLISH -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Hi ${name}, one step left</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 18px">
        Your employees are in — nice work. Nothing has been clocked yet, and it is almost always the same
        missing piece: <strong>your team needs somewhere to tap in.</strong>
      </p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 18px;margin:0 0 22px">
        <p style="color:#1e293b;font-size:14px;line-height:1.7;margin:0">
          <strong>Set up the tablet — about two minutes:</strong><br>
          1. Grab a tablet or an old phone and put it by the door<br>
          2. In PunchClock, open <strong>Sites &rarr; Kiosk Shortcut</strong><br>
          3. Point the tablet&rsquo;s camera at the QR code on screen<br>
          4. Watch it say <em>connected</em> — that&rsquo;s it, it&rsquo;s live
        </p>
      </div>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 14px">
        Then hand out the PINs. On the <strong>Employees</strong> page, <strong>PIN cards</strong> prints one
        cut-out card per person with their code and the three steps to clock in.
      </p>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 8px">
        Your team taps their name, taps IN or OUT, enters four digits. Nothing to install, no accounts for them to make.
      </p>
      ${ctaButton("Set up my tablet →", APP_URL)}
      <p style="color:#64748b;font-size:13px;margin-top:20px;text-align:center;font-weight:600">${dayLabelEn}</p>

      ${divider()}

      <!-- FRANÇAIS -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Bonjour ${name}, il ne reste qu&rsquo;une &eacute;tape</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 18px">
        Vos employ&eacute;s sont ajout&eacute;s — bravo. Aucun pointage n&rsquo;a encore &eacute;t&eacute; enregistr&eacute;, et c&rsquo;est presque
        toujours le m&ecirc;me &eacute;l&eacute;ment qui manque&nbsp;: <strong>il faut un endroit o&ugrave; votre &eacute;quipe peut pointer.</strong>
      </p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 18px;margin:0 0 22px">
        <p style="color:#1e293b;font-size:14px;line-height:1.7;margin:0">
          <strong>Configurez la tablette — environ deux minutes&nbsp;:</strong><br>
          1. Prenez une tablette ou un vieux t&eacute;l&eacute;phone et placez-le pr&egrave;s de la porte<br>
          2. Dans PunchClock, ouvrez <strong>Sites &rarr; Raccourci kiosque</strong><br>
          3. Dirigez la cam&eacute;ra de la tablette vers le code QR &agrave; l&rsquo;&eacute;cran<br>
          4. Attendez le message <em>connect&eacute;</em> — voil&agrave;, c&rsquo;est en service
        </p>
      </div>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 14px">
        Distribuez ensuite les NIP. Sur la page <strong>Employ&eacute;s</strong>, <strong>Cartes NIP</strong> imprime une
        carte &agrave; d&eacute;couper par personne, avec son code et les trois &eacute;tapes pour pointer.
      </p>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 8px">
        Votre &eacute;quipe touche son nom, touche ENTR&Eacute;E ou SORTIE, entre quatre chiffres. Rien &agrave; installer,
        aucun compte &agrave; cr&eacute;er pour eux.
      </p>
      ${ctaButton("Configurer ma tablette →", APP_URL)}
      <p style="color:#64748b;font-size:13px;margin-top:20px;text-align:center;font-weight:600">${dayLabelFr}</p>
    `)
  };
}

// Site exists but nobody has been added yet.
function buildNoEmployees(name: string, dayLabelEn: string, dayLabelFr: string): { subject: string; html: string } {
  return {
    subject: "Add your team to start tracking hours 👥 | Ajoutez votre équipe",
    html: wrapper(`
      <!-- ENGLISH -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Hi ${name}, your site is ready</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        The next step is adding the people who will clock in. Each one gets a 4-digit PIN — that is all they need,
        no app and no account to create.
      </p>
      ${stepListEn()}
      ${ctaButton("Add My Employees →", APP_URL)}
      <p style="color:#f59e0b;font-size:13px;margin-top:20px;text-align:center;font-weight:600">${dayLabelEn}</p>

      ${divider()}

      <!-- FRANÇAIS -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Bonjour ${name}, votre site est pr&ecirc;t</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        L&rsquo;&eacute;tape suivante est d&rsquo;ajouter les personnes qui vont pointer. Chacune re&ccedil;oit un NIP &agrave; 4 chiffres —
        c&rsquo;est tout ce qu&rsquo;il leur faut, aucune application ni compte &agrave; cr&eacute;er.
      </p>
      ${stepListFr()}
      ${ctaButton("Ajouter mes employ&eacute;s →", APP_URL)}
      <p style="color:#f59e0b;font-size:13px;margin-top:20px;text-align:center;font-weight:600">${dayLabelFr}</p>
    `)
  };
}

function buildDay6(name: string): { subject: string; html: string } {
  return {
    subject: "⏰ Your PunchClock Pro trial expires tomorrow | Votre essai expire demain",
    html: wrapper(`
      <!-- ENGLISH -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Your trial expires tomorrow</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        Hi ${name}, your 7-day free trial ends tomorrow. After that, your account will be limited to the free plan.
      </p>
      <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin-bottom:20px">
        <div style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">What you&rsquo;ll lose on the free plan</div>
        <div style="color:#ef4444;font-size:14px;line-height:1.8">
          &bull; Limited to 1 site and 5 employees<br>
          &bull; No scheduling or reporting add-ons<br>
          &bull; No geofencing or GPS tracking
        </div>
      </div>
      <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin-bottom:24px">
        <div style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Upgrade starting at</div>
        <div style="font-size:28px;font-weight:700;color:#22c55e">$19.49<span style="font-size:14px;color:#475569;font-weight:400">/mo CAD</span></div>
      </div>
      ${ctaButton("Upgrade Now →", APP_URL, "#22c55e")}
      <p style="color:#94a3b8;font-size:13px;margin-top:16px;text-align:center">Or continue free with limited features.</p>

      ${divider()}

      <!-- FRANÇAIS -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Votre essai expire demain</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        Bonjour ${name}, votre essai gratuit de 7 jours se termine demain. Apr&egrave;s cela, votre compte sera limit&eacute; au plan gratuit.
      </p>
      <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin-bottom:20px">
        <div style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Ce que vous perdrez avec le plan gratuit</div>
        <div style="color:#ef4444;font-size:14px;line-height:1.8">
          &bull; Limit&eacute; &agrave; 1 site et 5 employ&eacute;s<br>
          &bull; Pas de modules de planification ou de rapports<br>
          &bull; Pas de g&eacute;olocalisation ni de suivi GPS
        </div>
      </div>
      <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin-bottom:24px">
        <div style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">À partir de</div>
        <div style="font-size:28px;font-weight:700;color:#22c55e">$19.49<span style="font-size:14px;color:#475569;font-weight:400">/mois CAD</span></div>
      </div>
      ${ctaButton("Mettre à niveau maintenant →", APP_URL, "#22c55e")}
      <p style="color:#94a3b8;font-size:13px;margin-top:16px;text-align:center">Ou continuez avec les fonctions limit&eacute;es du plan gratuit.</p>
    `)
  };
}

function buildDay7(name: string): { subject: string; html: string } {
  return {
    subject: "Your trial has ended — here’s what happens next | Votre essai est terminé",
    html: wrapper(`
      <!-- ENGLISH -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Your trial period has ended</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        Hi ${name}, your 7-day PunchClock Pro trial has ended. But don&rsquo;t worry &mdash; you can still use the free plan:
      </p>
      <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin-bottom:20px">
        <div style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Free plan includes</div>
        <div style="color:#1e293b;font-size:14px;line-height:1.8">
          &bull; 1 site<br>
          &bull; Up to 5 employees<br>
          &bull; Basic punch clock features
        </div>
      </div>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 20px">
        Need more sites or employees? Upgrade from <strong style="color:#22c55e">$19.49/mo CAD</strong>.
      </p>
      ${ctaButton("See Upgrade Options →", APP_URL)}

      ${divider()}

      <!-- FRANÇAIS -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Votre p&eacute;riode d&rsquo;essai est termin&eacute;e</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 20px">
        Bonjour ${name}, votre essai PunchClock Pro de 7 jours est termin&eacute;. Mais pas d&rsquo;inqui&eacute;tude &mdash; vous pouvez continuer avec le plan gratuit&nbsp;:
      </p>
      <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin-bottom:20px">
        <div style="font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Le plan gratuit comprend</div>
        <div style="color:#1e293b;font-size:14px;line-height:1.8">
          &bull; 1 site<br>
          &bull; Jusqu&rsquo;&agrave; 5 employ&eacute;s<br>
          &bull; Fonctions de pointage de base
        </div>
      </div>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 20px">
        Besoin de plus de sites ou d&rsquo;employ&eacute;s&nbsp;? Passez &agrave; la version payante &agrave; partir de <strong style="color:#22c55e">$19.49/mois CAD</strong>.
      </p>
      ${ctaButton("Voir les options →", APP_URL)}
    `)
  };
}

// ── Send email via Resend ─────────────────────────────────────────────────────
// Day 7, for accounts that ARE punching. They previously heard nothing after day 4 — the only
// day-7 message was the trial one, so success went unacknowledged while failure got a shutdown
// notice. Every figure comes from the account's own punches; the caller skips the send when
// there is nothing real to report.
function buildWeekRecap(name: string, company: string, hours: number, punches: number, people: number) {
  const h = Math.round(hours);
  const stat = (n: string, en: string) =>
    `<td style="border:1px solid #e2e8f0;padding:12px 14px;text-align:center;background:#f8fafc">
       <span style="font-size:21px;font-weight:700;color:#1e293b;display:block">${n}</span>
       <span style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em">${en}</span>
     </td>`;
  return {
    subject: `Your first week at ${company}: ${h}h tracked | Votre première semaine : ${h} h suivies`,
    html: wrapper(`
      <!-- ENGLISH -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Hi ${name} — your first week is in</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 16px">
        Here is what PunchClock recorded at <strong>${company}</strong> over the last seven days. Nobody added any of it up by hand.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:4px 0 18px"><tr>
        ${stat(h + "h", "Tracked")}${stat(String(punches), "Punches")}${stat(String(people), "On the clock")}
      </tr></table>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 18px">
        That is a payroll period you no longer have to reconstruct from memory or a paper sheet.
      </p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 18px;margin:0 0 20px">
        <p style="color:#1e293b;font-size:14px;line-height:1.7;margin:0">
          <strong>When payday comes:</strong> open <strong>Reports</strong>, pick your date range, and export to Excel,
          CSV or PDF. You can also have it emailed to your bookkeeper automatically each period.
        </p>
      </div>
      ${ctaButton("See my first report →", APP_URL)}
      <p style="color:#64748b;font-size:13px;margin-top:20px;text-align:center;font-weight:600">
        Something not adding up? Reply to this email — a real person reads it.
      </p>

      ${divider()}

      <!-- FRANÇAIS -->
      <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin:0 0 8px">Bonjour ${name} — votre premi&egrave;re semaine est compl&eacute;t&eacute;e</h1>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 16px">
        Voici ce que PunchClock a enregistr&eacute; chez <strong>${company}</strong> ces sept derniers jours. Personne n&rsquo;a eu &agrave; l&rsquo;additionner &agrave; la main.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:4px 0 18px"><tr>
        ${stat(h + "&nbsp;h", "Suivies")}${stat(String(punches), "Pointages")}${stat(String(people), "Employ&eacute;s")}
      </tr></table>
      <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 18px">
        C&rsquo;est une p&eacute;riode de paie que vous n&rsquo;avez plus &agrave; reconstituer de m&eacute;moire ou &agrave; partir d&rsquo;une feuille papier.
      </p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 18px;margin:0 0 20px">
        <p style="color:#1e293b;font-size:14px;line-height:1.7;margin:0">
          <strong>Le jour de la paie&nbsp;:</strong> ouvrez <strong>Rapports</strong>, choisissez votre p&eacute;riode, puis exportez
          en Excel, CSV ou PDF. Vous pouvez aussi la faire envoyer automatiquement &agrave; votre comptable &agrave; chaque p&eacute;riode.
        </p>
      </div>
      ${ctaButton("Voir mon premier rapport →", APP_URL)}
      <p style="color:#64748b;font-size:13px;margin-top:20px;text-align:center;font-weight:600">
        Un chiffre qui cloche&nbsp;? R&eacute;pondez &agrave; ce courriel — une vraie personne le lit.
      </p>
    `, true)   // replyable: this one asks a question, so the footer must not forbid answering
  };
}

// Hours from raw punches, pairing each IN with the OUT that follows it for that employee.
// An unclosed IN contributes nothing rather than counting to now, so a tablet left running
// overnight cannot inflate the figure we put in front of a customer.
function weekTotals(rows: Array<{ emp_id: string; type: string; punched_at: string }>) {
  const byEmp: Record<string, Array<{ type: string; at: number }>> = {};
  for (const r of rows) {
    (byEmp[r.emp_id] ||= []).push({ type: r.type, at: new Date(r.punched_at).getTime() });
  }
  let hours = 0;
  const people = new Set<string>();
  for (const [emp, list] of Object.entries(byEmp)) {
    people.add(emp);
    list.sort((a, b) => a.at - b.at);
    for (let i = 0; i < list.length; i++) {
      if (list[i].type === "IN" && list[i + 1]?.type === "OUT") {
        hours += (list[i + 1].at - list[i].at) / 3600000;
        i++;
      }
    }
  }
  return { hours, punches: rows.length, people: people.size };
}

async function sendEmail(to: string, subject: string, html: string, from = FROM_EMAIL): Promise<boolean> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`Resend error for ${to}: ${err}`);
    return false;
  }
  return true;
}

// There is no trial. The free plan is free forever, capped at 10 employees — that is what
// PLANS says, what the landing page promises ("free forever, no credit card"), and what the
// code enforces, which is nothing date-based at all. The only thing that ever referenced
// seven days was a cosmetic "Day N / 7" badge in the super-admin panel.
//
// This drip nevertheless told people their trial was expiring: 11 of 15 free accounts were
// sent "Your trial expires tomorrow" and 12 were sent "Your trial has ended". Nothing
// actually ended, so the day-7 mail reads as "the thing you were evaluating just shut off",
// arriving exactly where the funnel shows people disappear.
//
// The two messages are switched off rather than deleted, so they are one line away from
// working again if a real trial is ever built. The stage-based nudges below stay: they are
// true, and they are the useful half.
const TRIAL_EMAILS_ENABLED = false;

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200 });
  }

  // Copy changes here go straight to customers on the next cron, so the function has to be
  // inspectable without sending. `dry_run` reports exactly who would receive what and marks
  // nothing; `test_recap` sends one recap to a chosen address using that account's real
  // numbers, leaving the drip state untouched.
  let action = "", testTo = "", dryRun = false;
  try {
    const body = await req.json();
    action = body?.action || "";
    testTo = body?.to || "";
    dryRun = !!body?.dry_run;
  } catch { /* cron posts no body */ }

  if (action === "test_recap") {
    if (!testTo) return new Response(JSON.stringify({ ok: false, error: "Missing `to`" }), { status: 400 });
    const { data: admin } = await supabase
      .from("admins").select("id, name").eq("email", testTo.toLowerCase()).maybeSingle();
    if (!admin) return new Response(JSON.stringify({ ok: false, error: "No admin with that email" }), { status: 404 });
    const { data: coRows } = await supabase.from("companies").select("id, name").eq("admin_id", admin.id);
    const coIds = (coRows ?? []).map((c: { id: string }) => c.id);
    const { data: punchRows } = await supabase
      .from("punches").select("emp_id, type, punched_at")
      .in("company_id", coIds.length ? coIds : ["00000000-0000-0000-0000-000000000000"])
      .gte("punched_at", new Date(Date.now() - 7 * 86400000).toISOString());
    const totals = weekTotals(punchRows ?? []);
    const coName = (coRows?.[0] as { name?: string })?.name || "your company";
    const { subject, html } = buildWeekRecap(admin.name, coName, totals.hours, totals.punches, totals.people);
    const ok = await sendEmail(testTo, subject, html, SUPPORT_EMAIL);
    return new Response(JSON.stringify({ ok, sentTo: testTo, subject, totals }, null, 2),
      { headers: { "Content-Type": "application/json" } });
  }

  try {
    // Fetch all eligible free-plan primary admins
    const { data: admins, error: adminsErr } = await supabase
      .from("admins")
      .select("id, name, email, plan, created_at, onboarding_emails_sent")
      .eq("plan", "free")
      .eq("verified", true)
      .neq("role", "super_admin")
      .is("parent_admin_id", null);

    if (adminsErr) throw adminsErr;
    if (!admins?.length) {
      return new Response(JSON.stringify({ ok: true, processed: 0, message: "No eligible admins" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const results: Array<{ admin: string; sent: string[]; skipped: string[] }> = [];

    for (const admin of admins) {
      const sent: string[] = [];
      const skipped: string[] = [];
      const emailsSent: Record<string, boolean> = admin.onboarding_emails_sent || {};
      const daysSinceReg = Math.floor((Date.now() - new Date(admin.created_at).getTime()) / 86400000);

      // Where in the funnel are they actually stuck? Day 1/3 used to fire only when no site
      // existed, but nearly everyone creates a site and then stalls later — so the people who
      // needed a nudge most were the only ones excluded, and heard nothing until "trial expiring".
      let stage: "no_site" | "no_employees" | "no_punch" | "active" = "no_site";
      let coIdsForRecap: string[] = [];
      if (daysSinceReg >= 1 && daysSinceReg <= 5) {
        const { data: coRows } = await supabase
          .from("companies")
          .select("id")
          .eq("admin_id", admin.id);
        const coIds = (coRows ?? []).map((c: { id: string }) => c.id);
        if (coIds.length) {
          const { count: siteCount } = await supabase
            .from("sites").select("id", { count: "exact", head: true }).in("company_id", coIds);
          if ((siteCount ?? 0) > 0) {
            const { count: empCount } = await supabase
              .from("employees").select("id", { count: "exact", head: true })
              .in("company_id", coIds).eq("active", true);
            if ((empCount ?? 0) > 0) {
              const { count: punchCount } = await supabase
                .from("punches").select("id", { count: "exact", head: true }).in("company_id", coIds);
              stage = (punchCount ?? 0) > 0 ? "active" : "no_punch";
            } else {
              stage = "no_employees";
            }
          }
        }
      }

      // Pick the message that matches the stage. Anyone already punching is left alone.
      const stageEmail = (dayEn: string, dayFr: string) => {
        if (stage === "no_site") return buildDay1(admin.name);
        if (stage === "no_employees") return buildNoEmployees(admin.name, dayEn, dayFr);
        if (stage === "no_punch") return buildNoPunch(admin.name, dayEn, dayFr);
        return null;
      };

      // With dry_run set, report what would go out and send nothing.
      const deliver = async (to: string, subject: string, html: string, from = FROM_EMAIL) =>
        dryRun ? true : await sendEmail(to, subject, html, from);

      // Day 1
      if (daysSinceReg >= 1 && daysSinceReg <= 2 && !emailsSent.day1) {
        const msg = stageEmail("Free plan — no time limit, no card.", "Forfait gratuit — sans limite de durée, sans carte.");
        if (msg && await deliver(admin.email, msg.subject, msg.html)) {
          emailsSent.day1 = true;
          sent.push("day1:" + stage);
        }
      }

      // Day 3
      if (daysSinceReg >= 3 && daysSinceReg <= 4 && !emailsSent.day3) {
        const msg = stage === "no_site"
          ? buildDay3(admin.name)   // keeps the "still no site?" wording
          : stageEmail("Free plan — no time limit, no card.", "Forfait gratuit — sans limite de durée, sans carte.");
        if (msg && await deliver(admin.email, msg.subject, msg.html)) {
          emailsSent.day3 = true;
          sent.push("day3:" + stage);
        }
      }

      // Day 6: trial expiring tomorrow — untrue, see TRIAL_EMAILS_ENABLED
      if (TRIAL_EMAILS_ENABLED && daysSinceReg >= 6 && daysSinceReg <= 6 && !emailsSent.day6) {
        const { subject, html } = buildDay6(admin.name);
        if (await deliver(admin.email, subject, html)) {
          emailsSent.day6 = true;
          sent.push("day6");
        }
      }

      // Day 7+: trial ended — untrue, see TRIAL_EMAILS_ENABLED
      if (TRIAL_EMAILS_ENABLED && daysSinceReg >= 7 && !emailsSent.day7) {
        const { subject, html } = buildDay7(admin.name);
        if (await deliver(admin.email, subject, html)) {
          emailsSent.day7 = true;
          sent.push("day7");
        }
      }

      // Day 7: the week in numbers, for accounts that actually used it. Sent from support@
      // because it invites a reply, and skipped entirely when the week produced no completed
      // shifts — a recap reading "0h tracked" is worse than silence.
      if (daysSinceReg >= 7 && daysSinceReg <= 9 && !emailsSent.recap) {
        const { data: coRows } = await supabase.from("companies").select("id, name").eq("admin_id", admin.id);
        coIdsForRecap = (coRows ?? []).map((c: { id: string }) => c.id);
        if (coIdsForRecap.length) {
          const since = new Date(Date.now() - 7 * 86400000).toISOString();
          const { data: punchRows } = await supabase
            .from("punches").select("emp_id, type, punched_at")
            .in("company_id", coIdsForRecap).gte("punched_at", since);
          const totals = weekTotals(punchRows ?? []);
          if (totals.punches > 0 && totals.hours >= 1) {
            const coName = (coRows?.[0] as { name?: string })?.name || "your company";
            const { subject, html } = buildWeekRecap(
              admin.name, coName, totals.hours, totals.punches, totals.people);
            if (await deliver(admin.email, subject, html, SUPPORT_EMAIL)) {
              emailsSent.recap = true;
              sent.push(`recap:${Math.round(totals.hours)}h/${totals.punches}p`);
            }
          } else {
            skipped.push("recap:no-hours");
          }
        }
      }

      // Persist any sent flags back to the admin record
      if (sent.length > 0 && !dryRun) {
        await supabase
          .from("admins")
          .update({ onboarding_emails_sent: emailsSent })
          .eq("id", admin.id);
      }

      results.push({ admin: admin.email, sent, skipped });
    }

    const totalSent = results.reduce((n, r) => n + r.sent.length, 0);
    console.log(`Onboarding drip: processed ${admins.length} admins, sent ${totalSent} emails`);

    return new Response(JSON.stringify({ ok: true, processed: admins.length, totalSent, results }, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Onboarding error:", e);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
