// Builds the static topic pages under /en/ and /fr/, plus /llms.txt, from the content below.
// Why: the site itself is one page (index.html), so search engines and AI assistants (Google/Gemini,
// Bing/ChatGPT, Brave/Claude) have only the home page to quote. These pages each answer one question
// a buyer actually asks, in both languages, as plain HTML with no scripts.
//
// Rules for the copy (owner decision 2026-11-11): only claims we can prove. No "best", "favourite",
// "fastest growing", "most complete". Prices and plan limits must match the pricing page, the app
// (PLANS in index.html) and the server (skill punchclock-plan-entitlements). Change them together.
//
// Run:  node tools/seo-pages/build.mjs      (writes en/, fr/ and llms.txt at the repo root)
// Then add any new URL to sitemap.xml (the script prints the list).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = 'https://www.punchclock.ca';
const UPDATED = '2026-11-11';

// ── Plans (keep identical to the pricing page) ────────────────────────────────────────────────────
const PLANS = {
  en: [
    { name: 'Free', price: '$0', limits: '1 company, 1 site, up to 10 active employees', note: 'Clock-in terminal with PINs, dashboard, activity log, PDF reports. No credit card.' },
    { name: 'Starter', price: '$19.49/month', limits: '1 company, 2 sites, up to 25 employees', note: 'Adds geofencing, remote clock-in, the employee portal, time off, Excel and CSV export, punch corrections, overtime, evening hours and automatic email reports.' },
    { name: 'Growth', price: '$39.49/month', limits: '3 companies, 6 sites, up to 60 employees', note: 'Everything in Starter, plus lunch-break tracking and visitor check-in.' },
    { name: 'Business', price: '$79.49/month', limits: 'Unlimited companies, sites and employees', note: 'Everything in Growth.' },
  ],
  fr: [
    { name: 'Gratuit', price: '0 $', limits: '1 compagnie, 1 site, jusqu’à 10 employés actifs', note: 'Terminal de pointage avec NIP, tableau de bord, journal d’activité, rapports PDF. Aucune carte de crédit.' },
    { name: 'Débutant', price: '19,49 $/mois', limits: '1 compagnie, 2 sites, jusqu’à 25 employés', note: 'Ajoute le géorepérage, le pointage à distance, le portail employé, les congés, l’export Excel et CSV, la correction des pointages, les heures supplémentaires, les heures de soir et les rapports automatiques par courriel.' },
    { name: 'Croissance', price: '39,49 $/mois', limits: '3 compagnies, 6 sites, jusqu’à 60 employés', note: 'Tout le plan Débutant, plus le suivi des pauses repas et le pointage visiteur.' },
    { name: 'Entreprise', price: '79,49 $/mois', limits: 'Compagnies, sites et employés illimités', note: 'Tout le plan Croissance.' },
  ],
};
const ADDON = {
  en: 'Scheduling add-on: $14.95/month on any paid plan, with a free 14-day trial. All prices in Canadian dollars.',
  fr: 'Module Planification : 14,95 $/mois sur tout plan payant, avec un essai gratuit de 14 jours. Tous les prix sont en dollars canadiens.',
};

// ── Pages. Each topic exists in both languages; `pair` links the two. ─────────────────────────────
const PAGES = [
  {
    pair: 'quebec',
    en: {
      slug: 'time-clock-app-quebec',
      title: 'Punch clock app for Québec businesses | PunchClock Crew',
      desc: 'A bilingual punch clock and time-tracking app made in Québec: PIN clock-in on a tablet, multi-site, overtime, payroll reports and Québec statutory holidays. Free plan available.',
      h1: 'A punch clock app made in Québec, for Québec businesses',
      lead: 'PunchClock Crew is a time-and-attendance app built in Québec. The whole app, every report and every automatic email work in French or English, and prices are in Canadian dollars.',
      sections: [
        ['What you get', [
          'Employees clock in and out with a 4-digit PIN on a shared tablet, computer or phone at your location. No app to install.',
          'Several locations under one account, each with its own employees and clock-in terminal.',
          'Hours, overtime and evening hours calculated for you, then exported to PDF, Excel or CSV for payroll.',
          'Québec statutory holidays added to the schedule in one click (Scheduling add-on).',
          'Time-off requests, an employee portal and automatic pay-period emails, including a payroll summary for your accountant.',
        ]],
        ['Who uses it', [
          'Shops, restaurants, clinics, garages, farms, cleaning companies and other teams that work in shifts across Québec and the rest of Canada.',
        ]],
      ],
      faq: [
        ['Is PunchClock Crew available in French?', 'Yes. The interface, the reports and the automatic emails are fully available in French and in English, and you can switch language at any time.'],
        ['Where is my data stored and how is it protected?', 'Data is stored with Supabase (PostgreSQL) with row-level security, passwords are hashed and every connection uses HTTPS. The app was designed with Québec’s Law 25 on personal information in mind: it asks employees only for what it needs, and you can ask for your data to be deleted.'],
        ['Can I try it before paying?', 'Yes. The Free plan is free with no time limit and no credit card, and every new account previews the paid features for 14 days.'],
      ],
    },
    fr: {
      slug: 'application-pointage-quebec',
      title: 'Application de pointage pour les entreprises du Québec | PunchClock Crew',
      desc: 'Une application de pointage et de suivi des heures conçue au Québec : pointage par NIP sur tablette, multi-sites, heures supplémentaires, rapports de paie et jours fériés du Québec. Plan gratuit offert.',
      h1: 'Une application de pointage conçue au Québec, pour les entreprises d’ici',
      lead: 'PunchClock Crew est une application de pointage et de gestion des présences conçue au Québec. Toute l’application, chaque rapport et chaque courriel automatique fonctionnent en français ou en anglais, et les prix sont en dollars canadiens.',
      sections: [
        ['Ce que vous obtenez', [
          'Les employés pointent leur arrivée et leur départ avec un NIP à 4 chiffres sur une tablette, un ordinateur ou un téléphone partagé sur place. Aucune application à installer.',
          'Plusieurs emplacements dans un seul compte, chacun avec ses employés et son terminal de pointage.',
          'Heures, heures supplémentaires et heures de soir calculées pour vous, puis exportées en PDF, Excel ou CSV pour la paie.',
          'Les jours fériés du Québec ajoutés à l’horaire en un clic (module Planification).',
          'Demandes de congé, portail employé et courriels automatiques de fin de période, y compris un sommaire de paie pour votre comptable.',
        ]],
        ['Pour qui', [
          'Commerces, restaurants, cliniques, garages, fermes, entreprises d’entretien et toutes les équipes qui travaillent par quarts, au Québec et ailleurs au Canada.',
        ]],
      ],
      faq: [
        ['PunchClock Crew est-il offert en français?', 'Oui. L’interface, les rapports et les courriels automatiques sont entièrement offerts en français et en anglais, et vous pouvez changer de langue en tout temps.'],
        ['Où mes données sont-elles conservées et comment sont-elles protégées?', 'Les données sont conservées chez Supabase (PostgreSQL) avec une sécurité au niveau des lignes, les mots de passe sont hachés et toutes les connexions passent par HTTPS. L’application a été conçue en tenant compte de la Loi 25 sur les renseignements personnels : elle ne demande aux employés que ce qui est nécessaire, et vous pouvez demander la suppression de vos données.'],
        ['Puis-je l’essayer avant de payer?', 'Oui. Le plan Gratuit est gratuit sans limite de temps et sans carte de crédit, et chaque nouveau compte essaie les fonctions payantes pendant 14 jours.'],
      ],
    },
  },
  {
    pair: 'gps',
    en: {
      slug: 'gps-geofencing-time-clock',
      title: 'Time clock app with GPS and geofencing | PunchClock Crew',
      desc: 'Stop clock-ins from home or the parking lot: per-site geofencing, remote clock-in from the employee’s phone with the GPS location recorded on each punch. Included from the Starter plan.',
      h1: 'Time clock with GPS and geofencing',
      lead: 'Geofencing draws an invisible boundary around each of your sites. A punch from inside the boundary goes through; a punch from home or from the car is blocked, and the employee sees how far away they are.',
      sections: [
        ['How it works', [
          'You set a radius per site, from 10 m for a small store to 500 m for a large facility.',
          'Lenient mode (the default) lets a punch through when GPS is unavailable and shows a warning. Strict mode blocks it.',
          'Each punch records the GPS position and the distance from the site, shown as a map pin in the activity log.',
        ]],
        ['For crews on the road', [
          'Turn on remote clock-in and grant it to the employees who need it. They punch in from their own phone through the employee portal, and you see where each punch was made.',
          'A fixed tablet at the entrance is still the simplest option for teams who all work at one place.',
        ]],
      ],
      faq: [
        ['Which plan includes geofencing?', 'Geofencing and remote clock-in are included from the Starter plan ($19.49/month CAD). New accounts can try them for 14 days.'],
        ['What if an employee turns off location?', 'In lenient mode the punch goes through with a warning. In strict mode it is blocked. You choose per site.'],
        ['Do employees need to install an app?', 'No. Employees use the web on a shared device or, for remote clock-in, their own phone through the employee portal.'],
      ],
    },
    fr: {
      slug: 'pointage-gps-georeperage',
      title: 'Pointage avec GPS et géorepérage | PunchClock Crew',
      desc: 'Empêchez le pointage à partir de la maison ou du stationnement : géorepérage par site, pointage à distance depuis le téléphone de l’employé avec la position GPS enregistrée. Inclus dès le plan Débutant.',
      h1: 'Pointage avec GPS et géorepérage',
      lead: 'Le géorepérage trace une limite invisible autour de chacun de vos sites. Un pointage fait à l’intérieur de la limite est accepté; un pointage fait de la maison ou de l’auto est bloqué, et l’employé voit à quelle distance il se trouve.',
      sections: [
        ['Comment ça fonctionne', [
          'Vous choisissez un rayon par site, de 10 m pour un petit commerce à 500 m pour un grand établissement.',
          'Le mode souple (par défaut) accepte le pointage quand le GPS est indisponible et affiche un avertissement. Le mode strict le bloque.',
          'Chaque pointage enregistre la position GPS et la distance du site, affichées sur une carte dans le journal d’activité.',
        ]],
        ['Pour les équipes sur la route', [
          'Activez le pointage à distance et accordez-le aux employés qui en ont besoin. Ils pointent depuis leur propre téléphone par le portail employé, et vous voyez où chaque pointage a été fait.',
          'Une tablette fixe à l’entrée reste l’option la plus simple pour une équipe qui travaille au même endroit.',
        ]],
      ],
      faq: [
        ['Quel plan inclut le géorepérage?', 'Le géorepérage et le pointage à distance sont inclus dès le plan Débutant (19,49 $/mois). Les nouveaux comptes peuvent les essayer pendant 14 jours.'],
        ['Que se passe-t-il si un employé désactive sa localisation?', 'En mode souple, le pointage est accepté avec un avertissement. En mode strict, il est bloqué. Vous choisissez pour chaque site.'],
        ['Les employés doivent-ils installer une application?', 'Non. Les employés utilisent le web sur un appareil partagé ou, pour le pointage à distance, leur propre téléphone par le portail employé.'],
      ],
    },
  },
  {
    pair: 'free',
    en: {
      slug: 'free-time-clock-app',
      title: 'Free time clock app for small teams in Canada | PunchClock Crew',
      desc: 'A free punch clock for small teams: 1 site, up to 10 employees, PIN clock-in on a tablet, dashboard, activity log and PDF reports. No credit card, no time limit.',
      h1: 'A free time clock app for small teams',
      lead: 'The Free plan is free with no time limit and no credit card. It covers what a small team needs to stop using paper time sheets.',
      sections: [
        ['What the Free plan includes', [
          '1 company, 1 site and up to 10 active employees.',
          'A clock-in terminal where employees punch in and out with a 4-digit PIN.',
          'A dashboard showing who is clocked in, an activity log, and PDF reports for any date range.',
        ]],
        ['When to move to a paid plan', [
          'When you need more sites or employees, Excel or CSV export for payroll, overtime tracking, punch corrections, geofencing, remote clock-in, the employee portal or time-off requests. Paid plans start at $19.49/month CAD.',
          'Every new account tries those paid features free for 14 days, so you can decide with your own team.',
        ]],
      ],
      faq: [
        ['Is the Free plan really free?', 'Yes. There is no credit card and no end date. You only pay if you choose a paid plan.'],
        ['What happens after the 14-day preview?', 'The paid features lock and your account stays on Free. Nothing is deleted: your settings come back if you upgrade.'],
        ['Can I export to my payroll software on Free?', 'Free includes PDF reports. Excel and CSV export start with the Starter plan.'],
      ],
    },
    fr: {
      slug: 'application-pointage-gratuite',
      title: 'Application de pointage gratuite pour petites équipes | PunchClock Crew',
      desc: 'Un pointage gratuit pour les petites équipes : 1 site, jusqu’à 10 employés, pointage par NIP sur tablette, tableau de bord, journal d’activité et rapports PDF. Sans carte de crédit, sans limite de temps.',
      h1: 'Une application de pointage gratuite pour les petites équipes',
      lead: 'Le plan Gratuit est gratuit, sans limite de temps et sans carte de crédit. Il couvre ce qu’une petite équipe doit avoir pour abandonner les feuilles de temps en papier.',
      sections: [
        ['Ce que comprend le plan Gratuit', [
          '1 compagnie, 1 site et jusqu’à 10 employés actifs.',
          'Un terminal où les employés pointent leur arrivée et leur départ avec un NIP à 4 chiffres.',
          'Un tableau de bord qui montre qui est pointé, un journal d’activité et des rapports PDF pour n’importe quelle période.',
        ]],
        ['Quand passer à un plan payant', [
          'Quand il vous faut plus de sites ou d’employés, l’export Excel ou CSV pour la paie, les heures supplémentaires, la correction des pointages, le géorepérage, le pointage à distance, le portail employé ou les demandes de congé. Les plans payants commencent à 19,49 $/mois.',
          'Chaque nouveau compte essaie ces fonctions payantes gratuitement pendant 14 jours, pour décider avec votre propre équipe.',
        ]],
      ],
      faq: [
        ['Le plan Gratuit est-il vraiment gratuit?', 'Oui. Aucune carte de crédit et aucune date de fin. Vous ne payez que si vous choisissez un plan payant.'],
        ['Que se passe-t-il après l’essai de 14 jours?', 'Les fonctions payantes se verrouillent et votre compte reste au plan Gratuit. Rien n’est supprimé : vos réglages reviennent si vous passez à un plan payant.'],
        ['Puis-je exporter vers mon logiciel de paie avec le plan Gratuit?', 'Le plan Gratuit comprend les rapports PDF. L’export Excel et CSV commence au plan Débutant.'],
      ],
    },
  },
  {
    pair: 'scheduling',
    en: {
      slug: 'employee-scheduling-app',
      title: 'Employee scheduling app with time clock | PunchClock Crew',
      desc: 'Build weekly shift schedules, email them to your team, add Québec statutory holidays in one click and see time off in the same app as your punch clock. $14.95/month CAD, 14-day free trial.',
      h1: 'Employee scheduling in the same app as your punch clock',
      lead: 'The Scheduling add-on puts weekly shift planning next to clock-in, time off and hours, so you are not copying names between two tools.',
      sections: [
        ['What it does', [
          'Build a weekly schedule per company and add shifts with start and end times.',
          'Email the schedule to your team from the grid. Employees can also see their upcoming shifts in their portal.',
          'Add holidays, including the Québec statutory holidays in one click, and tag shifts with work labels.',
          'Approved time off shows up where you plan, so you do not schedule someone who is away.',
        ]],
        ['Price', [
          '$14.95/month CAD on any paid plan (Starter, Growth or Business), with a free 14-day trial started from the Schedule tab.',
        ]],
      ],
      faq: [
        ['Do I need a separate scheduling tool?', 'No. Schedules, punches, time off and hours are in the same app and the same account.'],
        ['Can employees see their schedule?', 'Yes, in their employee portal, and by email when you send the schedule.'],
        ['Is there a free trial?', 'Yes, 14 days, started with one click from the Schedule tab.'],
      ],
    },
    fr: {
      slug: 'logiciel-horaires-employes',
      title: 'Logiciel d’horaires pour employés, avec pointage | PunchClock Crew',
      desc: 'Créez les horaires de la semaine, envoyez-les à votre équipe par courriel, ajoutez les jours fériés du Québec en un clic et voyez les congés dans la même application que le pointage. 14,95 $/mois, essai gratuit de 14 jours.',
      h1: 'Les horaires de vos employés dans la même application que le pointage',
      lead: 'Le module Planification place les horaires de la semaine à côté du pointage, des congés et des heures. Plus besoin de recopier les noms d’un outil à l’autre.',
      sections: [
        ['Ce qu’il fait', [
          'Créez l’horaire de la semaine par compagnie et ajoutez des quarts avec heure de début et de fin.',
          'Envoyez l’horaire à votre équipe par courriel à partir de la grille. Les employés voient aussi leurs prochains quarts dans leur portail.',
          'Ajoutez les jours fériés, dont ceux du Québec en un clic, et identifiez les quarts avec des étiquettes de travail.',
          'Les congés approuvés apparaissent là où vous planifiez, pour ne pas mettre à l’horaire une personne absente.',
        ]],
        ['Prix', [
          '14,95 $/mois sur tout plan payant (Débutant, Croissance ou Entreprise), avec un essai gratuit de 14 jours lancé à partir de l’onglet Horaires.',
        ]],
      ],
      faq: [
        ['Ai-je besoin d’un autre outil pour les horaires?', 'Non. Horaires, pointages, congés et heures sont dans la même application et le même compte.'],
        ['Les employés peuvent-ils voir leur horaire?', 'Oui, dans leur portail employé, et par courriel quand vous envoyez l’horaire.'],
        ['Y a-t-il un essai gratuit?', 'Oui, 14 jours, lancé en un clic à partir de l’onglet Horaires.'],
      ],
    },
  },
  {
    pair: 'pricing',
    en: {
      slug: 'pricing',
      title: 'Pricing: punch clock and scheduling plans in CAD | PunchClock Crew',
      desc: 'PunchClock Crew plans in Canadian dollars: Free, Starter $19.49, Growth $39.49 and Business $79.49 per month, plus the Scheduling add-on at $14.95.',
      h1: 'PunchClock Crew pricing',
      lead: 'Simple monthly plans in Canadian dollars. Start free, and every new account tries the paid features for 14 days.',
      pricing: true,
      sections: [],
      faq: [
        ['Do I need a credit card to start?', 'No. The Free plan needs no credit card.'],
        ['Can I change plans later?', 'Yes, from your account at any time. Your data stays where it is.'],
        ['Is the Scheduling add-on included?', 'No. It is $14.95/month CAD on any paid plan, and you can try it free for 14 days.'],
        ['Can I get a refund?', 'No. Payments are not refundable, including partial months, so try the paid features free for 14 days first. If you cancel, you keep your plan until the end of the month already paid and are not charged again.'],
      ],
    },
    fr: {
      slug: 'tarifs',
      title: 'Tarifs : plans de pointage et d’horaires en dollars canadiens | PunchClock Crew',
      desc: 'Les plans PunchClock Crew en dollars canadiens : Gratuit, Débutant 19,49 $, Croissance 39,49 $ et Entreprise 79,49 $ par mois, plus le module Planification à 14,95 $.',
      h1: 'Tarifs PunchClock Crew',
      lead: 'Des plans mensuels simples, en dollars canadiens. Commencez gratuitement : chaque nouveau compte essaie les fonctions payantes pendant 14 jours.',
      pricing: true,
      sections: [],
      faq: [
        ['Faut-il une carte de crédit pour commencer?', 'Non. Le plan Gratuit ne demande aucune carte de crédit.'],
        ['Puis-je changer de plan plus tard?', 'Oui, à partir de votre compte, en tout temps. Vos données restent en place.'],
        ['Le module Planification est-il inclus?', 'Non. Il coûte 14,95 $/mois sur tout plan payant, et vous pouvez l’essayer gratuitement pendant 14 jours.'],
        ['Puis-je obtenir un remboursement?', 'Non. Les paiements ne sont pas remboursables, y compris pour un mois partiel : essayez d’abord les fonctions payantes gratuitement pendant 14 jours. Si vous annulez, vous gardez votre forfait jusqu’à la fin du mois déjà payé et vous n’êtes plus facturé.'],
      ],
    },
  },
];

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────────
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const urlOf = (lang, slug) => `${SITE}/${lang}/${slug}/`;
const T = {
  en: { tagline: 'Punch, schedules and time off in one Canadian app', start: 'Start free', demo: 'Try the live demo', faq: 'Questions', more: 'More about PunchClock Crew', other: 'Français', home: 'Home', updated: 'Updated', plansH: 'Plans', addonH: 'Add-on' },
  fr: { tagline: 'Pointage, horaires et congés dans une seule application québécoise', start: 'Commencer gratuitement', demo: 'Essayer la démo', faq: 'Questions', more: 'En savoir plus', other: 'English', home: 'Accueil', updated: 'Mis à jour le', plansH: 'Plans', addonH: 'Module' },
};

function render(page, lang) {
  const p = page[lang], o = page[lang === 'en' ? 'fr' : 'en'], other = lang === 'en' ? 'fr' : 'en';
  const t = T[lang];
  const home = lang === 'fr' ? `${SITE}/?lang=fr` : `${SITE}/`;
  const signup = lang === 'fr' ? `${SITE}/?signup=1&lang=fr` : `${SITE}/?signup=1`;
  const demo = lang === 'fr' ? `${SITE}/?demo=1&lang=fr` : `${SITE}/?demo=1`;
  const related = PAGES.filter(x => x !== page).map(x => `<li><a href="${urlOf(lang, x[lang].slug)}">${esc(x[lang].h1)}</a></li>`).join('');
  const sections = p.sections.map(([h, items]) =>
    `<h2>${esc(h)}</h2>` + (items.length > 1 ? `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : `<p>${esc(items[0])}</p>`)).join('\n');
  const pricing = p.pricing ? `<h2>${t.plansH}</h2><div class="plans">${PLANS[lang].map(pl =>
    `<div class="plan"><h3>${esc(pl.name)}</h3><div class="price">${esc(pl.price.split('/')[0])}${pl.price.includes('/')?'<small>/'+esc(pl.price.split('/')[1])+'</small>':''}</div><p class="lim">${esc(pl.limits)}</p><p>${esc(pl.note)}</p></div>`).join('')}</div><h2>${t.addonH}</h2><p>${esc(ADDON[lang])}</p>` : '';
  const faq = p.faq.map(([q, a]) => `<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join('\n');
  const ld = [
    { '@context': 'https://schema.org', '@type': 'WebPage', name: p.title, description: p.desc, url: urlOf(lang, p.slug), inLanguage: lang === 'fr' ? 'fr-CA' : 'en-CA', dateModified: UPDATED,
      isPartOf: { '@type': 'WebSite', name: 'PunchClock Crew', url: SITE },
      about: { '@type': 'SoftwareApplication', name: 'PunchClock Crew', applicationCategory: 'BusinessApplication', operatingSystem: 'Web', url: SITE } },
    { '@context': 'https://schema.org', '@type': 'FAQPage', inLanguage: lang === 'fr' ? 'fr-CA' : 'en-CA',
      mainEntity: p.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
  ];
  return `<!DOCTYPE html>
<html lang="${lang === 'fr' ? 'fr-CA' : 'en-CA'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.desc)}">
<link rel="canonical" href="${urlOf(lang, p.slug)}">
<link rel="alternate" hreflang="${lang === 'fr' ? 'fr-CA' : 'en-CA'}" href="${urlOf(lang, p.slug)}">
<link rel="alternate" hreflang="${other === 'fr' ? 'fr-CA' : 'en-CA'}" href="${urlOf(other, o.slug)}">
<link rel="alternate" hreflang="x-default" href="${urlOf('en', page.en.slug)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.desc)}">
<meta property="og:url" content="${urlOf(lang, p.slug)}">
<meta property="og:image" content="${SITE}/og-image.png">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" href="/favicon.ico" sizes="any">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
<style>
:root{--bg:#f6f7fb;--card:#fff;--text:#1a1d27;--muted:#5b6275;--line:#e4e8f1;--accent:#3d7be0;--accentText:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1117;--card:#181b24;--text:#e8eaf0;--muted:#a3aabb;--line:#2a2f3c;--accent:#5b93ef;--accentText:#fff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
a{color:var(--accent)}header,main,footer{max-width:820px;margin:0 auto;padding:0 20px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:18px;padding-bottom:18px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--text);font-weight:700;font-size:18px}
.brand img{width:34px;height:34px;border-radius:8px}nav a{margin-left:14px;font-size:14px}
main{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:34px clamp(20px,5vw,48px)}
h1{font-size:clamp(26px,4.5vw,36px);line-height:1.2;margin:0 0 12px}h2{font-size:21px;margin:30px 0 8px}h3{font-size:17px;margin:20px 0 4px}
.lead{font-size:18px;color:var(--muted);margin:0 0 22px}.tag{font-size:13px;color:var(--muted);margin:0 0 6px;font-weight:600}
.cta{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0 6px}.btn{display:inline-block;padding:11px 20px;border-radius:10px;font-weight:700;text-decoration:none}
.btn.primary{background:var(--accent);color:var(--accentText)}.btn.ghost{border:1px solid var(--line);color:var(--text)}
ul{padding-left:20px}li{margin:4px 0}.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.plan{border:1px solid var(--line);border-radius:12px;padding:16px}.plan h3{margin:0}.price{font-size:20px;font-weight:800;margin:4px 0}.price small{font-size:13px;font-weight:600;color:var(--muted)}.lim{font-weight:600;font-size:14px}.plan p{font-size:14px;margin:6px 0 0}
footer{padding-top:24px;padding-bottom:40px;font-size:14px;color:var(--muted)}footer ul{list-style:none;padding:0}
</style>
</head>
<body>
<header>
  <a class="brand" href="${home}"><img src="/icon-192.png" alt="" width="34" height="34">PunchClock Crew</a>
  <nav><a href="${home}">${t.home}</a><a href="${urlOf(lang, PAGES.find(x => x.pair === 'pricing')[lang].slug)}">${lang === 'fr' ? 'Tarifs' : 'Pricing'}</a><a href="${urlOf(other, o.slug)}" hreflang="${other}">${t.other}</a></nav>
</header>
<main>
  <p class="tag">${esc(t.tagline)}</p>
  <h1>${esc(p.h1)}</h1>
  <p class="lead">${esc(p.lead)}</p>
  <div class="cta"><a class="btn primary" href="${signup}">${t.start}</a><a class="btn ghost" href="${demo}">${t.demo}</a></div>
${sections}
${pricing}
  <h2>${t.faq}</h2>
${faq}
  <div class="cta"><a class="btn primary" href="${signup}">${t.start}</a></div>
</main>
<footer>
  <p><strong>${t.more}</strong></p>
  <ul>${related}</ul>
  <p>PunchClock Crew · 9317-3516 Québec Inc. · <a href="mailto:support@punchclock.ca">support@punchclock.ca</a> · ${t.updated} ${UPDATED}</p>
</footer>
</body>
</html>
`;
}

function llmsTxt() {
  const line = (lang, x) => `- [${x[lang].h1}](${urlOf(lang, x[lang].slug)}): ${x[lang].desc}`;
  return `# PunchClock Crew

> Time-and-attendance software made in Québec, Canada: employees clock in and out with a PIN on a shared tablet or computer (or from their phone with remote clock-in), and owners get hours, overtime, time off, schedules and payroll reports. Fully bilingual (French and English). Prices in Canadian dollars. Website: ${SITE}

Key facts:
- Plans (CAD per month): Free $0 (1 company, 1 site, up to 10 active employees); Starter $19.49 (2 sites, 25 employees); Growth $39.49 (3 companies, 6 sites, 60 employees, adds lunch breaks and visitor check-in); Business $79.49 (unlimited).
- Starter and up add geofencing, remote clock-in with GPS, the employee self-service portal, time-off requests, Excel and CSV export, punch corrections, overtime and evening-hours tracking, and automatic email reports including a payroll summary for the accountant.
- Scheduling add-on: $14.95/month on any paid plan, 14-day free trial; includes Québec statutory holidays in one click.
- Every new account previews the paid features free for 14 days. No credit card for the Free plan.
- Works in a web browser; no app install needed for the clock-in terminal.
- Operated by 9317-3516 Québec Inc. Support: support@punchclock.ca

## Pages (English)
${PAGES.map(x => line('en', x)).join('\n')}

## Pages (français)
${PAGES.map(x => line('fr', x)).join('\n')}

## Start
- [Create a free account](${SITE}/?signup=1)
- [Live demo with sample data](${SITE}/?demo=1)
`;
}

const written = [];
for (const page of PAGES) {
  for (const lang of ['en', 'fr']) {
    const file = join(ROOT, lang, page[lang].slug, 'index.html');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, render(page, lang));
    written.push(urlOf(lang, page[lang].slug));
  }
}
writeFileSync(join(ROOT, 'llms.txt'), llmsTxt());
console.log(written.join('\n'));
console.log('+ llms.txt');
