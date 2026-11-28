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
const UPDATED = '2026-11-24';

// ── Plans (keep identical to the pricing page) ────────────────────────────────────────────────────
const PLANS = {
  en: [
    { name: 'Free', price: '$0', limits: '1 company, 1 site, up to 10 active employees', note: 'PIN clock-in on your own tablet or computer, dashboard, activity log, PDF reports. No credit card.' },
    { name: 'Starter', price: '$19.49/month', limits: '1 company, 2 sites, up to 25 employees', note: 'Adds geofencing, remote clock-in, the employee portal, time off, Excel and CSV export, punch corrections, overtime, evening hours and automatic email reports.' },
    { name: 'Growth', price: '$39.49/month', limits: '3 companies, 6 sites, up to 60 employees', note: 'Everything in Starter, plus employee scheduling, lunch-break tracking and visitor check-in. The iPhone and Android apps, planned for January 2027, will be included.' },
    { name: 'Business', price: '$79.49/month', limits: 'Unlimited companies, sites and employees', note: 'Everything in Growth, including employee scheduling. The iPhone and Android apps, planned for January 2027, will be included.' },
  ],
  fr: [
    { name: 'Gratuit', price: '0 $', limits: '1 compagnie, 1 site, jusqu’à 10 employés actifs', note: 'Pointage par NIP sur votre propre tablette ou ordinateur, tableau de bord, journal d’activité, rapports PDF. Aucune carte de crédit.' },
    { name: 'Débutant', price: '19,49 $/mois', limits: '1 compagnie, 2 sites, jusqu’à 25 employés', note: 'Ajoute le géorepérage, le pointage à distance, le portail employé, les congés, l’export Excel et CSV, la correction des pointages, les heures supplémentaires, les heures de soir et les rapports automatiques par courriel.' },
    { name: 'Croissance', price: '39,49 $/mois', limits: '3 compagnies, 6 sites, jusqu’à 60 employés', note: 'Tout le plan Débutant, plus la planification des horaires, le suivi des pauses repas et le pointage visiteur. Les applications iPhone et Android, prévues pour janvier 2027, seront incluses.' },
    { name: 'Entreprise', price: '79,49 $/mois', limits: 'Compagnies, sites et employés illimités', note: 'Tout le plan Croissance, y compris la planification des horaires. Les applications iPhone et Android, prévues pour janvier 2027, seront incluses.' },
  ],
};
const ADDON = {
  en: 'Employee scheduling is included in Growth and Business. On Starter it is a $14.95/month add-on, with a free 14-day trial. All prices in Canadian dollars.',
  fr: 'La planification des horaires est incluse dans les plans Croissance et Entreprise. Sur le plan Débutant, c’est un module à 14,95 $/mois, avec un essai gratuit de 14 jours. Tous les prix sont en dollars canadiens.',
};

// ── Pages. Each topic exists in both languages; `pair` links the two. ─────────────────────────────
const PAGES = [
  {
    pair: 'quebec',
    en: {
      slug: 'time-clock-app-quebec',
      title: 'Punch clock app for Québec businesses | PunchClock Crew',
      desc: 'A bilingual punch clock and time-tracking app made in Québec: PIN clock-in on your own tablet, multi-site, overtime, payroll reports and Québec statutory holidays. Free plan available.',
      h1: 'A punch clock app made in Québec, for Québec businesses',
      lead: 'PunchClock Crew is a time-and-attendance app built in Québec. The whole app, every report and every automatic email work in French or English, and prices are in Canadian dollars.',
      sections: [
        ['What you get', [
          'Employees clock in and out with a 4-digit PIN on a shared tablet, computer or phone at your location. No app to install.',
          'Several locations under one account, each with its own employees and its own clock-in page.',
          'Hours, overtime and evening hours calculated for you, then exported to PDF, Excel or CSV for payroll.',
          'Québec statutory holidays added to the schedule in one click (Scheduling: Growth and up, or the Starter add-on).',
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
      desc: 'Une application de pointage et de suivi des heures conçue au Québec : pointage par NIP sur votre tablette, multi-sites, heures supplémentaires, rapports de paie et jours fériés du Québec. Plan gratuit offert.',
      h1: 'Une application de pointage conçue au Québec, pour les entreprises d’ici',
      lead: 'PunchClock Crew est une application de pointage et de gestion des présences conçue au Québec. Toute l’application, chaque rapport et chaque courriel automatique fonctionnent en français ou en anglais, et les prix sont en dollars canadiens.',
      sections: [
        ['Ce que vous obtenez', [
          'Les employés pointent leur arrivée et leur départ avec un NIP à 4 chiffres sur une tablette, un ordinateur ou un téléphone partagé sur place. Aucune application à installer.',
          'Plusieurs emplacements dans un seul compte, chacun avec ses employés et sa propre page de pointage.',
          'Heures, heures supplémentaires et heures de soir calculées pour vous, puis exportées en PDF, Excel ou CSV pour la paie.',
          'Les jours fériés du Québec ajoutés à l’horaire en un clic (planification : plan Croissance et plus, ou module sur Débutant).',
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
          'Location required, from anywhere: set the site to Strict mode and leave its address empty. Every phone punch must then carry a location, wherever the employee is; a punch with location refused or switched off is blocked.',
          'Your own tablet, fixed at the entrance, is still the simplest option for teams who all work at one place.',
        ]],
      ],
      faq: [
        ['Which plan includes geofencing?', 'Geofencing and remote clock-in are included from the Starter plan ($19.49/month CAD). New accounts can try them for 14 days.'],
        ['What if an employee turns off location?', 'In lenient mode the punch goes through with a warning. In strict mode it is blocked. You choose per site.'],
        ['Our technicians work at a different client site every day. Can we still require location?', 'Yes. Set the site to Strict mode with no address: location is required on every phone punch, from anywhere, with no distance limit, and each punch shows on a map where it was made.'],
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
          'Localisation exigée, de n’importe où : mettez le site en mode strict et laissez son adresse vide. Chaque pointage sur téléphone doit alors être accompagné d’une position, peu importe où se trouve l’employé; un pointage dont la localisation est refusée ou désactivée est bloqué.',
          'Votre propre tablette, fixée à l’entrée, reste l’option la plus simple pour une équipe qui travaille au même endroit.',
        ]],
      ],
      faq: [
        ['Quel plan inclut le géorepérage?', 'Le géorepérage et le pointage à distance sont inclus dès le plan Débutant (19,49 $/mois). Les nouveaux comptes peuvent les essayer pendant 14 jours.'],
        ['Que se passe-t-il si un employé désactive sa localisation?', 'En mode souple, le pointage est accepté avec un avertissement. En mode strict, il est bloqué. Vous choisissez pour chaque site.'],
        ['Nos techniciens travaillent chez un client différent chaque jour. Peut-on quand même exiger la localisation?', 'Oui. Mettez le site en mode strict sans adresse : la localisation est exigée à chaque pointage sur téléphone, de n’importe où, sans limite de distance, et chaque pointage s’affiche sur une carte à l’endroit où il a été fait.'],
        ['Les employés doivent-ils installer une application?', 'Non. Les employés utilisent le web sur un appareil partagé ou, pour le pointage à distance, leur propre téléphone par le portail employé.'],
      ],
    },
  },
  {
    pair: 'free',
    en: {
      slug: 'free-time-clock-app',
      title: 'Free time clock app for small teams in Canada | PunchClock Crew',
      desc: 'A free punch clock for small teams: 1 site, up to 10 employees, PIN clock-in on your own tablet, dashboard, activity log and PDF reports. No credit card, no time limit.',
      h1: 'A free time clock app for small teams',
      lead: 'The Free plan is free with no time limit and no credit card. It covers what a small team needs to stop using paper time sheets.',
      sections: [
        ['What the Free plan includes', [
          '1 company, 1 site and up to 10 active employees.',
          'PIN clock-in on your own tablet or computer: employees punch in and out with a 4-digit PIN. No hardware to buy from us.',
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
      desc: 'Un pointage gratuit pour les petites équipes : 1 site, jusqu’à 10 employés, pointage par NIP sur votre tablette, tableau de bord, journal d’activité et rapports PDF. Sans carte de crédit, sans limite de temps.',
      h1: 'Une application de pointage gratuite pour les petites équipes',
      lead: 'Le plan Gratuit est gratuit, sans limite de temps et sans carte de crédit. Il couvre ce qu’une petite équipe doit avoir pour abandonner les feuilles de temps en papier.',
      sections: [
        ['Ce que comprend le plan Gratuit', [
          '1 compagnie, 1 site et jusqu’à 10 employés actifs.',
          'Le pointage par NIP sur votre propre tablette ou ordinateur : les employés pointent leur arrivée et leur départ avec un NIP à 4 chiffres. Aucun appareil à nous acheter.',
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
      desc: 'Build weekly shift schedules, email them to your team, let employees add their shifts to Google Calendar, Apple Calendar or Outlook, and add Québec statutory holidays in one click. Included in Growth and Business, or $14.95/month CAD on Starter with a 14-day free trial.',
      h1: 'Employee scheduling in the same app as your punch clock',
      lead: 'Scheduling puts weekly shift planning next to clock-in, time off and hours, so you are not copying names between two tools.',
      sections: [
        ['What it does', [
          'Build a weekly schedule per company and add shifts with start and end times.',
          'Email the schedule to your team from the grid. Employees can also see their upcoming shifts in their portal.',
          'Calendar sync: each employee can add their own shifts to Google Calendar, Apple Calendar or Outlook with a private link from their portal. The shifts then show there on their own, with the work label, the site and the note.',
          'Add holidays, including the Québec statutory holidays in one click, and tag shifts with work labels.',
          'Approved time off shows up where you plan, so you do not schedule someone who is away.',
        ]],
        ['Price', [
          'Included in the Growth and Business plans. On Starter it is a $14.95/month CAD add-on, with a free 14-day trial started from the Schedule tab.',
        ]],
      ],
      faq: [
        ['Do I need a separate scheduling tool?', 'No. Schedules, punches, time off and hours are in the same app and the same account.'],
        ['Can employees see their schedule?', 'Yes, in their employee portal, by email when you send the schedule, and in their own calendar.'],
        ['Does the schedule sync with Google Calendar, Apple Calendar or Outlook?', 'Yes. In the employee portal, each employee chooses “Add my shifts to my calendar” and adds a private link once. It shows only that person’s shifts, and they can replace it or turn it off at any time. Calendar apps re-read the schedule on their own timetable (Google Calendar about once or twice a day), so a same-day change can show up late; the portal is always up to date.'],
        ['Is there a free trial?', 'Growth and Business include Scheduling. On Starter, yes: 14 days, started with one click from the Schedule tab.'],
      ],
    },
    fr: {
      slug: 'logiciel-horaires-employes',
      title: 'Logiciel d’horaires pour employés, avec pointage | PunchClock Crew',
      desc: 'Créez les horaires de la semaine, envoyez-les à votre équipe par courriel, laissez les employés ajouter leurs quarts à Google Agenda, au Calendrier Apple ou à Outlook, et ajoutez les jours fériés du Québec en un clic. Inclus dans les plans Croissance et Entreprise, ou 14,95 $/mois sur le plan Débutant, essai gratuit de 14 jours.',
      h1: 'Les horaires de vos employés dans la même application que le pointage',
      lead: 'La planification place les horaires de la semaine à côté du pointage, des congés et des heures. Plus besoin de recopier les noms d’un outil à l’autre.',
      sections: [
        ['Ce qu’il fait', [
          'Créez l’horaire de la semaine par compagnie et ajoutez des quarts avec heure de début et de fin.',
          'Envoyez l’horaire à votre équipe par courriel à partir de la grille. Les employés voient aussi leurs prochains quarts dans leur portail.',
          'Synchronisation du calendrier : chaque employé peut ajouter ses propres quarts à Google Agenda, au Calendrier Apple ou à Outlook au moyen d’un lien privé obtenu dans son portail. Ses quarts s’y affichent ensuite d’eux-mêmes, avec l’étiquette de travail, le site et la note.',
          'Ajoutez les jours fériés, dont ceux du Québec en un clic, et identifiez les quarts avec des étiquettes de travail.',
          'Les congés approuvés apparaissent là où vous planifiez, pour ne pas mettre à l’horaire une personne absente.',
        ]],
        ['Prix', [
          'Incluse dans les plans Croissance et Entreprise. Sur le plan Débutant, c’est un module à 14,95 $/mois, avec un essai gratuit de 14 jours lancé à partir de l’onglet Horaires.',
        ]],
      ],
      faq: [
        ['Ai-je besoin d’un autre outil pour les horaires?', 'Non. Horaires, pointages, congés et heures sont dans la même application et le même compte.'],
        ['Les employés peuvent-ils voir leur horaire?', 'Oui, dans leur portail employé, par courriel quand vous envoyez l’horaire, et dans leur propre calendrier.'],
        ['L’horaire se synchronise-t-il avec Google Agenda, le Calendrier Apple ou Outlook?', 'Oui. Dans le portail employé, chaque employé choisit « Ajouter mes quarts à mon calendrier » et ajoute un lien privé une seule fois. Le lien ne montre que ses quarts, et il peut le remplacer ou le désactiver en tout temps. Les applications de calendrier relisent l’horaire à leur propre rythme (Google Agenda environ une ou deux fois par jour); un changement fait le jour même peut donc apparaître en retard. Le portail, lui, est toujours à jour.'],
        ['Y a-t-il un essai gratuit?', 'Les plans Croissance et Entreprise incluent la planification. Sur le plan Débutant, oui : 14 jours, lancé en un clic à partir de l’onglet Horaires.'],
      ],
    },
  },
  // ── Added 2026-11-24 from Search Console: searches where the site showed on page 2 or 3 with no page that answers
  // them directly. Each pair has its own angle so the pages do not compete: A = what the software does end to end,
  // B = replacing a punch machine, C = crews who never pass by the office. Same rules: proven claims only, plan
  // names and prices as on the pricing page, software only, and say plainly what the product does NOT do.
  {
    pair: 'software',
    en: {
      slug: 'time-and-attendance-software-canada',
      title: 'Time and attendance software for Canadian small businesses | PunchClock Crew',
      desc: 'Time and attendance software made in Canada: PIN or phone clock-in, live attendance, overtime, time off and payroll-ready reports, in English and French, priced in Canadian dollars. Free plan, no credit card.',
      h1: 'Time and attendance software for Canadian small businesses',
      lead: 'Time and attendance software records when each employee starts and stops, adds up the hours and prepares the report for payroll. PunchClock Crew does that for small businesses, with nothing to install and no hardware to buy.',
      pricing: true,
      sections: [
        ['From clock-in to payroll report', [
          'Clock-in: each employee punches with a 4-digit PIN on your own tablet or computer, or on their phone with remote clock-in (Starter plan and up).',
          'Attendance: the dashboard shows who is at work right now, and the activity log keeps every punch.',
          'Hours: totals per employee are calculated for you. Overtime, with the daily and weekly thresholds you set, and evening hours are added from the Starter plan.',
          'Corrections: a manager fixes a forgotten or wrong punch, and every correction stays in the audit log (Starter plan and up).',
          'Payroll: PDF reports for any date range, plus Excel or CSV export and an automatic end-of-period email with a summary for your accountant (Starter plan and up).',
        ]],
        ['What comes with it', [
          'Time-off requests and an employee portal where each person sees their hours and schedule (paid plans).',
          'Lunch-break tracking and visitor check-in (Growth plan and up).',
          'Several sites from the Starter plan, and several companies under one account from the Growth plan.',
          'Shift schedules with Scheduling (Growth and up, or the Starter add-on), including Québec statutory holidays in one click.',
          'English and French throughout: the app, the reports and the automatic emails.',
        ]],
        ['What it does not do', [
          'PunchClock Crew does not run payroll: it prepares the hours, which you export to your payroll software or send to your accountant. It does not calculate statutory holiday pay either.',
        ]],
      ],
      faq: [
        ['How much does time and attendance software cost?', 'PunchClock Crew has a Free plan (1 site, up to 10 active employees) and paid plans at $19.49, $39.49 and $79.49 per month, in Canadian dollars.'],
        ['Do I need to install anything?', 'No. It runs in a web browser, on a tablet, computer or phone you already have.'],
        ['Does it follow the overtime rules of my province?', 'You set the daily and weekly overtime thresholds yourself, so they can match the rules that apply to your business. Overtime is included from the Starter plan.'],
        ['Does it do payroll?', 'No. It calculates the hours and prepares the reports. Payroll is done in your payroll software or by your accountant, from the Excel, CSV or PDF export.'],
        ['Is it available in French?', 'Yes. The app, the reports and the automatic emails work in French or English, and each person can switch language at any time.'],
      ],
    },
    fr: {
      slug: 'logiciel-de-pointage',
      title: 'Logiciel de pointage des employés pour PME | PunchClock Crew',
      desc: 'Un logiciel de pointage horaire pour les entreprises : pointage par NIP ou sur téléphone, présences en temps réel, heures supplémentaires, congés et rapports prêts pour la paie. Plan gratuit, sans carte de crédit.',
      h1: 'Un logiciel de pointage simple pour les entreprises',
      lead: 'Un logiciel de pointage enregistre l’heure d’arrivée et de départ de chaque employé, additionne les heures et prépare le rapport pour la paie. PunchClock Crew fait ce travail pour les PME, sans rien à installer et sans appareil à acheter.',
      pricing: true,
      sections: [
        ['Du pointage au rapport de paie', [
          'Pointage : chaque employé pointe avec un NIP à 4 chiffres sur votre propre tablette ou ordinateur, ou sur son téléphone avec le pointage à distance (plan Débutant et plus).',
          'Présences : le tableau de bord montre en tout temps qui est au travail, et le journal d’activité garde chaque pointage.',
          'Heures : le total par employé est calculé pour vous. Les heures supplémentaires, selon les seuils par jour et par semaine que vous réglez, et les heures de soir s’ajoutent dès le plan Débutant.',
          'Corrections : un gestionnaire corrige un pointage oublié ou erroné, et chaque correction reste au journal d’audit (plan Débutant et plus).',
          'Paie : rapports PDF pour n’importe quelle période, puis export Excel ou CSV et courriel automatique de fin de période avec un sommaire pour votre comptable (plan Débutant et plus).',
        ]],
        ['Ce qui s’ajoute au pointage', [
          'Demandes de congé et portail employé, où chacun voit ses heures et son horaire (plans payants).',
          'Suivi des pauses repas et pointage des visiteurs (plan Croissance et plus).',
          'Plusieurs sites dès le plan Débutant, et plusieurs compagnies dans un même compte dès le plan Croissance.',
          'Horaires de travail avec la planification (plan Croissance et plus, ou module sur Débutant), y compris les jours fériés du Québec en un clic.',
          'Tout en français ou en anglais : l’application, les rapports et les courriels automatiques.',
        ]],
        ['Ce qu’il ne fait pas', [
          'PunchClock Crew ne produit pas la paie : il prépare les heures, que vous exportez vers votre logiciel de paie ou envoyez à votre comptable. Il ne calcule pas non plus l’indemnité des jours fériés.',
        ]],
      ],
      faq: [
        ['Combien coûte un logiciel de pointage?', 'PunchClock Crew offre un plan Gratuit (1 site, jusqu’à 10 employés actifs) et des plans payants à 19,49 $, 39,49 $ et 79,49 $ par mois, en dollars canadiens.'],
        ['Faut-il installer quelque chose?', 'Non. Le logiciel fonctionne dans un navigateur web, sur une tablette, un ordinateur ou un téléphone que vous avez déjà.'],
        ['Le logiciel calcule-t-il les heures supplémentaires?', 'Oui, dès le plan Débutant. Vous réglez vous-même les seuils par jour et par semaine, pour qu’ils correspondent aux règles qui s’appliquent à votre entreprise.'],
        ['Est-ce que le logiciel fait la paie?', 'Non. Il calcule les heures et prépare les rapports. La paie se fait dans votre logiciel de paie ou chez votre comptable, à partir de l’export Excel, CSV ou PDF.'],
        ['Le logiciel est-il en français?', 'Oui. L’application, les rapports et les courriels automatiques fonctionnent en français ou en anglais, et chacun peut changer de langue en tout temps.'],
      ],
    },
  },
  {
    pair: 'machine',
    en: {
      slug: 'online-punch-clock',
      title: 'Online punch clock: replace the time clock machine | PunchClock Crew',
      desc: 'An online punch clock that runs on a tablet or computer you already own: PIN clock-in, hours added up for you, PDF reports. No machine, no punch cards, no hardware to buy. Free for up to 10 employees.',
      h1: 'An online punch clock on a tablet you already own',
      lead: 'An online punch clock does the job of the time clock machine and its punch cards, with no machine to buy and no cards to add up. With PunchClock Crew, the punch clock is a web page open on your own tablet, fixed at the entrance.',
      sections: [
        ['What you need', [
          'A tablet, computer or phone you already have, with a web browser and an internet connection: an iPad, an Android tablet, a Windows PC or a Mac.',
          'A PunchClock Crew account. The Free plan is enough for 1 site and up to 10 active employees.',
          'That is all. PunchClock Crew is software: we do not sell, rent or supply any device.',
        ]],
        ['How your employees punch', [
          'The employee picks their name, punches in or out and confirms with their 4-digit PIN.',
          'Each employee has their own PIN, and the page locks for a while after several wrong PINs.',
          'The dashboard shows right away who is at work.',
        ]],
        ['What replaces the punch cards', [
          'Hours are added up for you: no more cards to total by hand at the end of the period.',
          'PDF reports for any date range, and Excel or CSV export for payroll from the Starter plan.',
          'A manager fixes a forgotten punch, and the correction stays in the audit log (Starter plan and up).',
          'Several locations: each site has its own clock-in page, and you see everything in the same account.',
        ]],
      ],
      faq: [
        ['Do I need to buy a punch clock machine?', 'No. PunchClock Crew is software. You use a tablet, computer or phone you already have, and we do not sell any device.'],
        ['Does it work on a computer?', 'Yes. The clock-in page runs in a web browser on a Windows PC, a Mac, an iPad or an Android tablet.'],
        ['What happens if the internet goes down?', 'The clock-in page needs an internet connection to record a punch. If the connection drops, a manager can add the missing punches afterwards (Starter plan and up).'],
        ['Is it free?', 'The Free plan covers 1 company, 1 site and up to 10 active employees, with no credit card and no end date. Paid plans start at $19.49 per month in Canadian dollars.'],
      ],
    },
    fr: {
      slug: 'pointeuse-en-ligne',
      title: 'Pointeuse en ligne : remplacez l’horodateur | PunchClock Crew',
      desc: 'Une pointeuse en ligne qui fonctionne sur une tablette ou un ordinateur que vous avez déjà : pointage par NIP, heures additionnées pour vous, rapports PDF. Pas de machine, pas de cartes de punch, aucun appareil à acheter. Gratuit jusqu’à 10 employés.',
      h1: 'Une pointeuse en ligne, sur une tablette que vous avez déjà',
      lead: 'Une pointeuse en ligne fait le travail de l’horodateur et des cartes de punch, sans machine à acheter ni cartes à compiler. Avec PunchClock Crew, la pointeuse est une page web ouverte sur votre propre tablette, fixée à l’entrée.',
      sections: [
        ['Ce qu’il vous faut', [
          'Une tablette, un ordinateur ou un téléphone que vous avez déjà, avec un navigateur web et une connexion Internet : un iPad, une tablette Android, un PC Windows ou un Mac.',
          'Un compte PunchClock Crew. Le plan Gratuit suffit pour 1 site et jusqu’à 10 employés actifs.',
          'C’est tout. PunchClock Crew est un logiciel : nous ne vendons, ne louons et ne fournissons aucun appareil.',
        ]],
        ['Comment vos employés pointent', [
          'L’employé choisit son nom, pointe son arrivée ou son départ et confirme avec son NIP à 4 chiffres.',
          'Chaque employé a son propre NIP, et la page se verrouille un moment après plusieurs NIP erronés.',
          'Le tableau de bord montre tout de suite qui est au travail.',
        ]],
        ['Ce qui remplace les cartes de punch', [
          'Les heures sont additionnées pour vous : plus de cartes à compiler à la main à la fin de la période.',
          'Rapports PDF pour n’importe quelle période, et export Excel ou CSV pour la paie dès le plan Débutant.',
          'Un gestionnaire corrige un pointage oublié, et la correction reste au journal d’audit (plan Débutant et plus).',
          'Plusieurs emplacements : chaque site a sa propre page de pointage, et vous voyez tout dans le même compte.',
        ]],
      ],
      faq: [
        ['Faut-il acheter une pointeuse ou un horodateur?', 'Non. PunchClock Crew est un logiciel. Vous utilisez une tablette, un ordinateur ou un téléphone que vous avez déjà, et nous ne vendons aucun appareil.'],
        ['Est-ce que ça fonctionne sur un ordinateur?', 'Oui. La page de pointage fonctionne dans un navigateur web, sur un PC Windows, un Mac, un iPad ou une tablette Android.'],
        ['Que se passe-t-il si Internet tombe?', 'La page de pointage a besoin d’une connexion Internet pour enregistrer un pointage. Si la connexion tombe, un gestionnaire peut ajouter les pointages manquants par la suite (plan Débutant et plus).'],
        ['Est-ce gratuit?', 'Le plan Gratuit couvre 1 compagnie, 1 site et jusqu’à 10 employés actifs, sans carte de crédit et sans date de fin. Les plans payants commencent à 19,49 $ par mois.'],
      ],
    },
  },
  {
    pair: 'field',
    en: {
      slug: 'time-clock-for-field-crews',
      title: 'Time clock app for field crews and job sites | PunchClock Crew',
      desc: 'A time clock for crews who never pass by the office: employees punch on their own phone, each punch records the GPS location, with a zone per job site or location required anywhere. From $19.49/month CAD.',
      h1: 'A time clock for field crews and job sites',
      lead: 'When the crew does not pass by the office, a tablet at the entrance is not enough. With remote clock-in, each employee punches on their own phone, and you see where and when each punch was made.',
      sections: [
        ['How it works in the field', [
          'You turn on remote clock-in and grant it to the employees who need it.',
          'The employee opens their employee portal on their phone and punches in or out. Nothing to install.',
          'Each punch records the GPS position, shown as a map pin in the activity log.',
        ]],
        ['One job site, or a different client every day', [
          'A fixed job site: draw a zone around the address, from 10 m to 500 m. A punch from outside the zone is blocked, and the employee sees how far away they are.',
          'A different client every day: set the site to Strict mode with no address. Location is then required on every punch, from anywhere, with no distance limit.',
          'Several job sites: each site has its own employees. The Starter plan covers 2 sites, Growth 6, and Business has no limit.',
        ]],
        ['For the office', [
          'The dashboard shows who is at work right now.',
          'An employee who forgot to punch reports it from their portal, and you approve or deny it.',
          'Hours and overtime are calculated, then exported to Excel or CSV for payroll.',
        ]],
        ['Good to know', [
          'The phone needs an internet connection at the moment of the punch. Remote clock-in, geofencing and the employee portal are included from the Starter plan ($19.49/month CAD).',
        ]],
      ],
      faq: [
        ['What should a time clock app for a construction or field crew have?', 'Look for phone clock-in with the GPS position, a zone per job site, and an export for payroll. PunchClock Crew includes all three from the Starter plan, at $19.49 per month in Canadian dollars, in English and French.'],
        ['Do employees need to install an app?', 'No. They punch from the employee portal in their phone’s web browser.'],
        ['Does it track employees all day?', 'No. The location is recorded only at the moment of a punch. PunchClock Crew does not follow anyone between punches.'],
        ['What if an employee refuses to share their location?', 'You choose per site. In lenient mode the punch goes through with a warning. In strict mode it is blocked.'],
      ],
    },
    fr: {
      slug: 'punch-chantier-equipes-mobiles',
      title: 'Application de punch pour chantiers et équipes mobiles | PunchClock Crew',
      desc: 'Un punch pour les équipes qui ne passent pas par le bureau : chaque employé pointe sur son téléphone, la position GPS est enregistrée, avec une zone par chantier ou la localisation exigée partout. Dès 19,49 $/mois.',
      h1: 'L’application de punch pour les chantiers et les équipes sur la route',
      lead: 'Quand l’équipe ne passe pas par le bureau, la tablette à l’entrée ne suffit plus. Avec le pointage à distance, chaque employé pointe sur son propre téléphone, et vous voyez où et quand chaque pointage a été fait.',
      sections: [
        ['Comment ça marche sur le terrain', [
          'Vous activez le pointage à distance et l’accordez aux employés qui en ont besoin.',
          'L’employé ouvre son portail employé sur son téléphone et pointe son arrivée ou son départ. Rien à installer.',
          'Chaque pointage enregistre la position GPS, affichée sur une carte dans le journal d’activité.',
        ]],
        ['Un chantier fixe, ou un client différent chaque jour', [
          'Chantier fixe : tracez une zone autour de l’adresse, de 10 m à 500 m. Un pointage fait hors de la zone est bloqué, et l’employé voit à quelle distance il se trouve.',
          'Client différent chaque jour : mettez le site en mode strict sans adresse. La localisation est alors exigée à chaque pointage, de n’importe où, sans limite de distance.',
          'Plusieurs chantiers : chaque site a ses employés. Le plan Débutant couvre 2 sites, le plan Croissance 6, et le plan Entreprise n’a pas de limite.',
        ]],
        ['Pour le bureau', [
          'Le tableau de bord montre qui est au travail en ce moment.',
          'Un employé qui a oublié de pointer le signale à partir de son portail, et vous approuvez ou refusez.',
          'Les heures et les heures supplémentaires sont calculées, puis exportées en Excel ou CSV pour la paie.',
        ]],
        ['Bon à savoir', [
          'Le téléphone a besoin d’une connexion Internet au moment du pointage. Le pointage à distance, le géorepérage et le portail employé sont inclus dès le plan Débutant (19,49 $/mois).',
        ]],
      ],
      faq: [
        ['Quelle application de punch choisir pour des employés de chantier au Québec?', 'Cherchez un pointage sur téléphone avec la position GPS, une zone par chantier, une application en français et un export pour la paie. PunchClock Crew offre ces quatre éléments dès le plan Débutant, à 19,49 $ par mois.'],
        ['Les employés doivent-ils installer une application?', 'Non. Ils pointent à partir du portail employé, dans le navigateur web de leur téléphone.'],
        ['Est-ce que l’application suit les employés toute la journée?', 'Non. La position est enregistrée seulement au moment d’un pointage. PunchClock Crew ne suit personne entre les pointages.'],
        ['Que se passe-t-il si un employé refuse de partager sa position?', 'Vous choisissez pour chaque site. En mode souple, le pointage est accepté avec un avertissement. En mode strict, il est bloqué.'],
      ],
    },
  },
  // ── Industry pages, added 2026-11-24 for the trades that show up in Search Console (restaurants, retail,
  // factories). They describe how the product fits the trade. No customer names, no "used by N restaurants",
  // nothing about a trade's labour rules (tips, decrees), and each says what the product does not do.
  {
    pair: 'restaurants',
    en: {
      slug: 'time-clock-for-restaurants',
      title: 'Time clock app for restaurants and cafés | PunchClock Crew',
      desc: 'A time clock for restaurants, cafés and bars: staff punch in with a PIN on your own tablet by the kitchen door, with breaks, evening hours, weekly schedules and hours ready for your accountant. Free for up to 10 employees.',
      h1: 'A time clock for restaurants, cafés and bars',
      lead: 'In a restaurant, shifts start at different times, people cover for each other, and nobody has time to fill in a time sheet. With PunchClock Crew, each person punches in with a PIN on your own tablet, and the hours add themselves up.',
      sections: [
        ['On the floor and in the kitchen', [
          'One tablet you already own, by the kitchen door or the staff entrance. Each person picks their name, punches in or out and confirms with a 4-digit PIN.',
          'The dashboard shows who is on shift right now, from any web browser.',
          'Someone forgot to punch out after closing? A manager fixes it, and the correction stays in the audit log (Starter plan and up).',
        ]],
        ['Shifts, breaks and evenings', [
          'Overtime follows the daily and weekly thresholds you set, and evening hours can be reported separately (Starter plan and up).',
          'Meal breaks: a Break button on the clock-in screen, separate from punching out, and break time shows as its own line in reports (Growth plan and up).',
          'Weekly schedule with Scheduling (Growth and up, or the Starter add-on): build the week, email it to the team, and each person sees their shifts in their portal or in their own calendar.',
          'Time-off requests come in through the employee portal, and approved time off shows where you plan (paid plans).',
        ]],
        ['At the end of the pay period', [
          'Hours per employee for any date range as a PDF, and as Excel or CSV from the Starter plan.',
          'An automatic end-of-period email with a payroll summary for your accountant (Starter plan and up).',
        ]],
        ['Two locations or more', [
          'Each restaurant has its own clock-in page and its own staff, under one account: 2 sites on Starter, 6 on Growth, no limit on Business.',
        ]],
        ['What it does not do', [
          'PunchClock Crew does not run payroll, does not handle tips or tip sharing, and does not connect to a point-of-sale system. It tracks hours, breaks, time off and schedules.',
        ]],
      ],
      faq: [
        ['Can a small café use it for free?', 'Yes. The Free plan covers 1 site and up to 10 active employees, with PIN clock-in, the dashboard, the activity log and PDF reports, with no credit card and no end date.'],
        ['Do staff need a phone or an app?', 'No. They punch on the shared tablet with their PIN. Clock-in from a phone exists for those who need it, from the Starter plan.'],
        ['Does it handle tips?', 'No. PunchClock Crew tracks hours, breaks and schedules. Tips are handled in your payroll or point-of-sale system.'],
        ['Does it connect to my point-of-sale system?', 'No. Hours are exported as PDF, Excel or CSV, which your accountant or payroll software can read.'],
      ],
    },
    fr: {
      slug: 'pointage-restaurant',
      title: 'Application de pointage pour restaurants et cafés | PunchClock Crew',
      desc: 'Un punch pour les restaurants, cafés et bars : le personnel pointe par NIP sur votre propre tablette près de la cuisine, avec les pauses, les heures de soir, l’horaire de la semaine et les heures prêtes pour votre comptable. Gratuit jusqu’à 10 employés.',
      h1: 'Le pointage pour les restaurants, les cafés et les bars',
      lead: 'Dans un restaurant, les quarts commencent à des heures différentes, on se remplace entre collègues, et personne n’a le temps de remplir une feuille de temps. Avec PunchClock Crew, chacun pointe avec un NIP sur votre propre tablette, et les heures s’additionnent toutes seules.',
      sections: [
        ['En salle et en cuisine', [
          'Une tablette que vous avez déjà, près de la porte de la cuisine ou de l’entrée du personnel. Chacun choisit son nom, pointe son arrivée ou son départ et confirme avec un NIP à 4 chiffres.',
          'Le tableau de bord montre qui est en poste en ce moment, à partir de n’importe quel navigateur web.',
          'Quelqu’un a oublié de pointer sa sortie à la fermeture? Un gestionnaire corrige, et la correction reste au journal d’audit (plan Débutant et plus).',
        ]],
        ['Quarts, pauses et soirées', [
          'Les heures supplémentaires suivent les seuils par jour et par semaine que vous réglez, et les heures de soir peuvent être présentées à part (plan Débutant et plus).',
          'Pauses repas : un bouton Pause à l’écran de pointage, distinct de la sortie, et le temps de pause a sa propre ligne dans les rapports (plan Croissance et plus).',
          'Horaire de la semaine avec la planification (plan Croissance et plus, ou module sur Débutant) : préparez la semaine, envoyez-la à l’équipe par courriel, et chacun voit ses quarts dans son portail ou dans son propre calendrier.',
          'Les demandes de congé arrivent par le portail employé, et les congés approuvés apparaissent là où vous planifiez (plans payants).',
        ]],
        ['À la fin de la période de paie', [
          'Les heures par employé pour n’importe quelle période en PDF, et en Excel ou CSV dès le plan Débutant.',
          'Un courriel automatique de fin de période avec un sommaire de paie pour votre comptable (plan Débutant et plus).',
        ]],
        ['Deux établissements ou plus', [
          'Chaque restaurant a sa propre page de pointage et son personnel, dans un même compte : 2 sites au plan Débutant, 6 au plan Croissance, sans limite au plan Entreprise.',
        ]],
        ['Ce qu’il ne fait pas', [
          'PunchClock Crew ne produit pas la paie, ne gère pas les pourboires ni leur partage, et ne se connecte pas à un système de point de vente. Il suit les heures, les pauses, les congés et les horaires.',
        ]],
      ],
      faq: [
        ['Un petit café peut-il l’utiliser gratuitement?', 'Oui. Le plan Gratuit couvre 1 site et jusqu’à 10 employés actifs, avec le pointage par NIP, le tableau de bord, le journal d’activité et les rapports PDF, sans carte de crédit et sans date de fin.'],
        ['Le personnel a-t-il besoin d’un téléphone ou d’une application?', 'Non. Chacun pointe sur la tablette partagée avec son NIP. Le pointage sur téléphone existe pour ceux qui en ont besoin, dès le plan Débutant.'],
        ['Est-ce que ça gère les pourboires?', 'Non. PunchClock Crew suit les heures, les pauses et les horaires. Les pourboires se gèrent dans votre système de paie ou de point de vente.'],
        ['Est-ce que ça se connecte à mon système de point de vente?', 'Non. Les heures sont exportées en PDF, Excel ou CSV, que votre comptable ou votre logiciel de paie peut lire.'],
      ],
    },
  },
  {
    pair: 'retail',
    en: {
      slug: 'time-clock-for-retail-stores',
      title: 'Time clock app for retail stores and boutiques | PunchClock Crew',
      desc: 'A time clock for retail: a clock-in page at each store, every store’s hours in one account, schedules and time off for part-time staff, and reports ready for payroll. Free for one store and up to 10 employees.',
      h1: 'A time clock for retail stores and boutiques',
      lead: 'A store runs on part-time staff, changing shifts and often more than one location. PunchClock Crew keeps the hours of every store in one account, with a clock-in page at each one.',
      sections: [
        ['In each store', [
          'A tablet you already own near the back door, or the computer in the back office: the clock-in page runs in any web browser.',
          'Each employee picks their name, punches in or out and confirms with a 4-digit PIN.',
          'The dashboard shows, store by store, who is at work right now.',
        ]],
        ['Several stores, one account', [
          'Each store has its own clock-in page and its own staff: 2 sites on the Starter plan, 6 on Growth, no limit on Business.',
          'Geofencing keeps punches at the store: with a zone around the address, a punch from outside it is blocked (Starter plan and up).',
          'Several companies under one account from the Growth plan.',
        ]],
        ['Part-time staff and changing shifts', [
          'Weekly schedule with Scheduling (Growth and up, or the Starter add-on): build the week, email it to the team, and each person can add their shifts to their own calendar.',
          'Each employee sees their own hours and schedule in the employee portal, and asks for time off there (paid plans).',
          'Approved time off shows where you plan, so you do not schedule someone who is away.',
        ]],
        ['At the end of the pay period', [
          'Hours per employee and per store for any date range as a PDF, and as Excel or CSV from the Starter plan.',
          'Overtime, with the daily and weekly thresholds you set, is separated from regular hours (Starter plan and up).',
        ]],
        ['What it does not do', [
          'PunchClock Crew does not run payroll and does not connect to a cash register or point-of-sale system.',
        ]],
      ],
      faq: [
        ['How many employees can I have?', 'Up to 10 active employees on the Free plan, 25 on Starter, 60 on Growth, and no limit on Business.'],
        ['Can it run on the store computer?', 'Yes. The clock-in page runs in a web browser on a Windows PC, a Mac, an iPad or an Android tablet.'],
        ['Can employees see their schedule on their phone?', 'Yes, with Scheduling (Growth and up, or the Starter add-on): in their employee portal, by email when you send the schedule, and in their own calendar.'],
        ['Does it connect to my cash register?', 'No. Hours are exported as PDF, Excel or CSV for your payroll software or your accountant.'],
      ],
    },
    fr: {
      slug: 'pointage-commerce-de-detail',
      title: 'Application de pointage pour commerces et boutiques | PunchClock Crew',
      desc: 'Un punch pour le commerce de détail : une page de pointage dans chaque magasin, les heures de tous les magasins dans un même compte, horaires et congés pour le personnel à temps partiel, et rapports prêts pour la paie. Gratuit pour un magasin et jusqu’à 10 employés.',
      h1: 'Le pointage pour les commerces de détail et les boutiques',
      lead: 'Un magasin fonctionne avec du personnel à temps partiel, des quarts qui changent et souvent plus d’une adresse. PunchClock Crew garde les heures de tous vos magasins dans un même compte, avec une page de pointage dans chacun.',
      sections: [
        ['Dans chaque magasin', [
          'Une tablette que vous avez déjà près de la porte arrière, ou l’ordinateur de l’arrière-boutique : la page de pointage fonctionne dans n’importe quel navigateur web.',
          'Chaque employé choisit son nom, pointe son arrivée ou son départ et confirme avec un NIP à 4 chiffres.',
          'Le tableau de bord montre, magasin par magasin, qui est au travail en ce moment.',
        ]],
        ['Plusieurs magasins, un seul compte', [
          'Chaque magasin a sa propre page de pointage et son personnel : 2 sites au plan Débutant, 6 au plan Croissance, sans limite au plan Entreprise.',
          'Le géorepérage garde les pointages au magasin : avec une zone autour de l’adresse, un pointage fait à l’extérieur est bloqué (plan Débutant et plus).',
          'Plusieurs compagnies dans un même compte dès le plan Croissance.',
        ]],
        ['Temps partiel et quarts qui changent', [
          'Horaire de la semaine avec la planification (plan Croissance et plus, ou module sur Débutant) : préparez la semaine, envoyez-la à l’équipe par courriel, et chacun peut ajouter ses quarts à son propre calendrier.',
          'Chaque employé voit ses heures et son horaire dans le portail employé, et y fait ses demandes de congé (plans payants).',
          'Les congés approuvés apparaissent là où vous planifiez, pour ne pas mettre à l’horaire une personne absente.',
        ]],
        ['À la fin de la période de paie', [
          'Les heures par employé et par magasin pour n’importe quelle période en PDF, et en Excel ou CSV dès le plan Débutant.',
          'Les heures supplémentaires, selon les seuils par jour et par semaine que vous réglez, sont séparées des heures normales (plan Débutant et plus).',
        ]],
        ['Ce qu’il ne fait pas', [
          'PunchClock Crew ne produit pas la paie et ne se connecte pas à une caisse ni à un système de point de vente.',
        ]],
      ],
      faq: [
        ['Combien d’employés puis-je avoir?', 'Jusqu’à 10 employés actifs au plan Gratuit, 25 au plan Débutant, 60 au plan Croissance, et sans limite au plan Entreprise.'],
        ['Est-ce que ça fonctionne sur l’ordinateur du magasin?', 'Oui. La page de pointage fonctionne dans un navigateur web, sur un PC Windows, un Mac, un iPad ou une tablette Android.'],
        ['Les employés peuvent-ils voir leur horaire sur leur téléphone?', 'Oui, avec la planification (plan Croissance et plus, ou module sur Débutant) : dans leur portail employé, par courriel quand vous envoyez l’horaire, et dans leur propre calendrier.'],
        ['Est-ce que ça se connecte à ma caisse?', 'Non. Les heures sont exportées en PDF, Excel ou CSV pour votre logiciel de paie ou votre comptable.'],
      ],
    },
  },
  {
    pair: 'factories',
    en: {
      slug: 'time-clock-for-manufacturing',
      title: 'Time clock app for factories and workshops | PunchClock Crew',
      desc: 'A time clock for plants and workshops: employees punch with a PIN on your own tablet at the entrance, overtime and evening hours are calculated, visitors sign in, and hours go to payroll. No punch machine, no cards, no badges.',
      h1: 'A time clock for factories and workshops',
      lead: 'A plant needs everyone punched in at the start of the shift, overtime counted properly, and a record of who is in the building. PunchClock Crew does this on your own tablet at the entrance, with no punch machine, cards or badges.',
      sections: [
        ['At the plant entrance', [
          'A tablet or computer you already own at the door. Each employee picks their name, punches in or out and confirms with a 4-digit PIN.',
          'The dashboard shows who is in right now, from the office.',
          'Several buildings or plants: each site has its own clock-in page and its own employees, in the same account.',
        ]],
        ['Shifts and overtime', [
          'Overtime follows the daily and weekly thresholds you set, and evening hours can be reported separately (Starter plan and up).',
          'Meal breaks: a Break button separate from punching out, with break time on its own line in reports (Growth plan and up).',
          'Shift schedules with Scheduling (Growth and up, or the Starter add-on), including Québec statutory holidays in one click.',
          'A manager fixes a forgotten punch, and every correction stays in the audit log (Starter plan and up).',
        ]],
        ['Visitors', [
          'Visitor check-in on the same tablet: visitors sign in and out, and you see who is currently in the building (Growth plan and up).',
        ]],
        ['For payroll', [
          'Hours per employee for any date range as a PDF, and as Excel or CSV from the Starter plan, with regular and overtime hours separated.',
          'Up to 25 employees on Starter, 60 on Growth, and no limit on Business.',
        ]],
        ['What it does not do', [
          'No badge reader, no fingerprint and no facial recognition: employees punch with a PIN. PunchClock Crew does not run payroll, and the clock-in page needs an internet connection.',
        ]],
      ],
      faq: [
        ['Do we need badges or a punch machine?', 'No. PunchClock Crew is software. Employees punch with a PIN on a tablet or computer you already have, and we do not sell any device.'],
        ['Can it replace our punch cards?', 'Yes. Punches are recorded online and the hours are added up for you, so there are no cards to total at the end of the period.'],
        ['What happens if the internet goes down?', 'The clock-in page needs an internet connection to record a punch. If the connection drops, a manager can add the missing punches afterwards (Starter plan and up).'],
        ['Is it available in French?', 'Yes. The clock-in page, the app, the reports and the automatic emails work in French or English.'],
      ],
    },
    fr: {
      slug: 'pointage-usine-manufacturier',
      title: 'Application de pointage pour usines et ateliers | PunchClock Crew',
      desc: 'Un punch pour les usines et les ateliers : les employés pointent par NIP sur votre propre tablette à l’entrée, les heures supplémentaires et de soir sont calculées, les visiteurs s’enregistrent, et les heures vont à la paie. Sans pointeuse, sans cartes, sans badges.',
      h1: 'Le pointage pour les usines et les ateliers',
      lead: 'Une usine a besoin que tout le monde soit pointé au début du quart, que les heures supplémentaires soient bien comptées, et de savoir qui est dans le bâtiment. PunchClock Crew le fait sur votre propre tablette à l’entrée, sans pointeuse, sans cartes et sans badges.',
      sections: [
        ['À l’entrée de l’usine', [
          'Une tablette ou un ordinateur que vous avez déjà, à la porte. Chaque employé choisit son nom, pointe son arrivée ou son départ et confirme avec un NIP à 4 chiffres.',
          'Le tableau de bord montre qui est sur place en ce moment, à partir du bureau.',
          'Plusieurs bâtiments ou usines : chaque site a sa propre page de pointage et ses employés, dans le même compte.',
        ]],
        ['Quarts et heures supplémentaires', [
          'Les heures supplémentaires suivent les seuils par jour et par semaine que vous réglez, et les heures de soir peuvent être présentées à part (plan Débutant et plus).',
          'Pauses repas : un bouton Pause distinct de la sortie, et le temps de pause a sa propre ligne dans les rapports (plan Croissance et plus).',
          'Horaires de quarts avec la planification (plan Croissance et plus, ou module sur Débutant), y compris les jours fériés du Québec en un clic.',
          'Un gestionnaire corrige un pointage oublié, et chaque correction reste au journal d’audit (plan Débutant et plus).',
        ]],
        ['Visiteurs', [
          'Pointage des visiteurs sur la même tablette : les visiteurs s’enregistrent à l’arrivée et au départ, et vous voyez qui est dans le bâtiment (plan Croissance et plus).',
        ]],
        ['Pour la paie', [
          'Les heures par employé pour n’importe quelle période en PDF, et en Excel ou CSV dès le plan Débutant, avec les heures normales et supplémentaires séparées.',
          'Jusqu’à 25 employés au plan Débutant, 60 au plan Croissance, et sans limite au plan Entreprise.',
        ]],
        ['Ce qu’il ne fait pas', [
          'Pas de lecteur de badges, pas d’empreinte digitale ni de reconnaissance faciale : les employés pointent avec un NIP. PunchClock Crew ne produit pas la paie, et la page de pointage a besoin d’une connexion Internet.',
        ]],
      ],
      faq: [
        ['Faut-il des badges ou une pointeuse?', 'Non. PunchClock Crew est un logiciel. Les employés pointent avec un NIP sur une tablette ou un ordinateur que vous avez déjà, et nous ne vendons aucun appareil.'],
        ['Est-ce que ça remplace nos cartes de punch?', 'Oui. Les pointages sont enregistrés en ligne et les heures sont additionnées pour vous : plus de cartes à compiler à la fin de la période.'],
        ['Que se passe-t-il si Internet tombe?', 'La page de pointage a besoin d’une connexion Internet pour enregistrer un pointage. Si la connexion tombe, un gestionnaire peut ajouter les pointages manquants par la suite (plan Débutant et plus).'],
        ['Est-ce offert en français?', 'Oui. La page de pointage, l’application, les rapports et les courriels automatiques fonctionnent en français ou en anglais.'],
      ],
    },
  },
  {
    pair: 'pricing',
    en: {
      slug: 'pricing',
      title: 'Pricing: punch clock and scheduling plans in CAD | PunchClock Crew',
      desc: 'PunchClock Crew plans in Canadian dollars: Free, Starter $19.49, Growth $39.49 and Business $79.49 per month, with employee scheduling included from Growth (a $14.95 add-on on Starter).',
      h1: 'PunchClock Crew pricing',
      lead: 'Simple monthly plans in Canadian dollars. Start free, and every new account tries the paid features for 14 days.',
      pricing: true,
      sections: [],
      faq: [
        ['Do I need a credit card to start?', 'No. The Free plan needs no credit card.'],
        ['Can I change plans later?', 'Yes, from your account at any time. Your data stays where it is.'],
        ['Is employee scheduling included?', 'Yes, in Growth and Business. On Starter it is a $14.95/month CAD add-on, and you can try it free for 14 days.'],
        // Owner's decision 2026-11-28. Replace with the real answer and the store links on the day the apps are released.
        ['Is there a phone app?', 'iPhone and Android apps are on the way, planned for January 2027, and will be included with the Growth and Business plans. Today everything runs in the browser on every plan, and from Starter up employees can clock in from their own phone through the employee portal.'],
        ['Can I get a refund?', 'No. Payments are not refundable, including partial months, so try the paid features free for 14 days first. If you cancel, you keep your plan until the end of the month already paid and are not charged again.'],
        // Referral program (owner-approved 2026-11-20). Only in a build made from 1 to 31 December 2026 (a build before or after leaves it out).
        ["Is there a referral offer?", "Yes, for new accounts created from 1 to 31 December 2026. Sign up with the referral code of a business that already uses PunchClock Crew and you get 10% off your first paid month. The business that referred you gets a $19.49 credit, the price of one month of Starter: $9.75 when you pay your first month and $9.74 when you pay your second. The credit comes off their next invoice automatically, for up to 10 referred businesses. Every account has its own code in the profile menu, under \"Refer a business\". Conditions are in the Terms of Service.", { from: '2026-12-01T05:00:00Z', until: '2027-01-01T05:00:00Z' }],
      ],
    },
    fr: {
      slug: 'tarifs',
      title: 'Tarifs : plans de pointage et d’horaires en dollars canadiens | PunchClock Crew',
      desc: 'Les plans PunchClock Crew en dollars canadiens : Gratuit, Débutant 19,49 $, Croissance 39,49 $ et Entreprise 79,49 $ par mois, avec la planification des horaires incluse dès Croissance (module à 14,95 $ sur Débutant).',
      h1: 'Tarifs PunchClock Crew',
      lead: 'Des plans mensuels simples, en dollars canadiens. Commencez gratuitement : chaque nouveau compte essaie les fonctions payantes pendant 14 jours.',
      pricing: true,
      sections: [],
      faq: [
        ['Faut-il une carte de crédit pour commencer?', 'Non. Le plan Gratuit ne demande aucune carte de crédit.'],
        ['Puis-je changer de plan plus tard?', 'Oui, à partir de votre compte, en tout temps. Vos données restent en place.'],
        ['La planification des horaires est-elle incluse?', 'Oui, dans les plans Croissance et Entreprise. Sur le plan Débutant, c’est un module à 14,95 $/mois, et vous pouvez l’essayer gratuitement pendant 14 jours.'],
        ['Y a-t-il une application mobile?', 'Des applications pour iPhone et Android arrivent : la sortie est prévue pour janvier 2027, et elles seront incluses dans les plans Croissance et Entreprise. Aujourd’hui, tout fonctionne dans le navigateur avec tous les plans, et à partir du plan Débutant, les employés peuvent pointer de leur propre téléphone par le portail employé.'],
        // Programme de parrainage (approuvé 2026-11-20). Seulement dans une reconstruction faite du 1er au 31 décembre 2026.
        ["Y a-t-il une offre de parrainage?", "Oui, pour les nouveaux comptes créés du 1er au 31 décembre 2026. Inscrivez-vous avec le code de parrainage d'une entreprise qui utilise déjà PunchClock Crew et obtenez 10 % de rabais sur votre premier mois payé. L'entreprise qui vous a recommandé reçoit un crédit de 19,49 $, soit le prix d'un mois du forfait Débutant : 9,75 $ lorsque vous payez votre premier mois et 9,74 $ lorsque vous payez le deuxième. Le crédit se déduit automatiquement de sa prochaine facture, pour au plus 10 entreprises recommandées. Chaque compte a son propre code dans le menu du profil, sous « Recommander une entreprise ». Les conditions figurent dans les Conditions d'utilisation.", { from: '2026-12-01T05:00:00Z', until: '2027-01-01T05:00:00Z' }],
        ['Puis-je obtenir un remboursement?', 'Non. Les paiements ne sont pas remboursables, y compris pour un mois partiel : essayez d’abord les fonctions payantes gratuitement pendant 14 jours. Si vous annulez, vous gardez votre forfait jusqu’à la fin du mois déjà payé et vous n’êtes plus facturé.'],
      ],
    },
  },
];

// ── French home page (/fr/). Why: French used to exist only as the English page with ?lang=fr, translated in the
// browser, so Google had no French page of its own to rank (Search Console, Nov 2026: 69% of impressions were French,
// click rate 0.48%). Plain HTML like the topic pages; its buttons open the app in French. The English home stays `/`.
// Same rules as above: only claims we can prove, prices identical to the pricing page, software only.
const HOME_FR = {
  home: true,
  en: { slug: '' },
  fr: {
    slug: '',
    title: 'Application de punch pour employés au Québec | PunchClock Crew',
    desc: 'PunchClock Crew est une application de punch et de pointage des heures de travail pour les entreprises du Québec. Vos employés pointent par NIP sur votre propre tablette ou sur leur téléphone. Heures, heures supplémentaires, rapports de paie et horaires. Plan gratuit.',
    h1: 'L’application de punch pour vos employés, conçue au Québec',
    lead: 'PunchClock Crew est un logiciel de pointage des heures de travail. Vos employés pointent leur arrivée et leur sortie avec un NIP sur votre propre tablette, ou à partir de leur téléphone, et vous obtenez les heures prêtes pour la paie.',
    pricing: true,
    sections: [
      ['Comment ça marche', [
        'Ouvrez la page de pointage sur une tablette, un ordinateur ou un téléphone que vous avez déjà. Rien à acheter : PunchClock Crew est un logiciel.',
        'Chaque employé pointe son arrivée et sa sortie avec un NIP à 4 chiffres.',
        'Les heures sont calculées pour vous, et vous voyez en tout temps qui est au travail.',
        'À la fin de la période, le rapport des heures est prêt pour la paie.',
      ]],
      ['Un système de pointage complet', [
        'Plusieurs sites sous un même compte, chacun avec ses employés et sa propre page de pointage.',
        'Pointage à distance sur le téléphone de l’employé, avec la position GPS et le géorepérage par site, pour les équipes sur la route ou sur les chantiers (plan Débutant et plus).',
        'Portail employé : chacun voit ses heures et son horaire, demande un congé et signale un pointage oublié (plans payants).',
        'Heures supplémentaires, correction des pointages et export Excel ou CSV pour la paie (plan Débutant et plus).',
        'Suivi des pauses repas et pointage des visiteurs (plan Croissance et plus).',
        'Horaires et quarts de travail avec la planification (plan Croissance et plus, ou module sur Débutant), y compris les jours fériés du Québec en un clic.',
        'Tout fonctionne en français ou en anglais : l’application, les rapports et les courriels automatiques.',
      ]],
      ['Remplace la pointeuse et les feuilles de temps', [
        'Pas d’horodateur mécanique, pas de cartes de punch, pas de feuilles de temps à retranscrire. Les pointages sont enregistrés en ligne, et chaque correction faite par un gestionnaire reste au journal d’audit.',
      ]],
      ['Pour qui', [
        'Commerces, restaurants, cliniques, garages, fermes, entreprises d’entretien et autres équipes qui travaillent par quarts, au Québec et ailleurs au Canada.',
      ]],
    ],
    faq: [
      ['Est-ce que l’application de punch est gratuite?', 'Oui. Le plan Gratuit couvre 1 compagnie, 1 site et jusqu’à 10 employés actifs, sans carte de crédit. Les plans payants commencent à 19,49 $ par mois.'],
      ['Faut-il acheter une pointeuse ou une tablette?', 'Non. PunchClock Crew est un logiciel : vous utilisez une tablette, un ordinateur ou un téléphone que vous avez déjà. Nous ne vendons aucun appareil.'],
      ['Les employés peuvent-ils puncher avec leur téléphone?', 'Oui, avec le pointage à distance (plan Débutant et plus). La position GPS est enregistrée à chaque pointage, et vous pouvez définir une zone autour de chaque site.'],
      ['Est-ce que le logiciel calcule les heures supplémentaires?', 'Oui, à partir du plan Débutant. Les rapports séparent les heures normales et les heures supplémentaires.'],
      ['Peut-on essayer avant de payer?', 'Oui. Chaque nouveau compte essaie les fonctions payantes gratuitement pendant 14 jours, et une démo avec des données fictives est offerte.'],
    ],
  },
};

// ── Screenshots. The images already exist in both languages under assets/screenshots (made by
// tools/capture-screenshots.mjs from demo mode, so they never show a customer's data). A page shows up to two:
// the first under the buttons, the second before the questions. Keyed by `pair` ('home' = /fr/).
const SHOT_SIZE = { 'product-punch-mobile': [828, 1720], '12-geofence': [2880, 1780], '16-phone-clock-in': [2880, 1780], '15-time-off': [2880, 1208] }; // others 2880x1800
const CAP = {
  dashboard: { en: 'The dashboard: who is clocked in at each site, and the latest punches.', fr: 'Le tableau de bord : qui est pointé à chaque site, et les derniers pointages.' },
  punch: { en: 'The clock-in page on your own tablet: pick your name, then IN or OUT.', fr: 'La page de pointage sur votre propre tablette : choisissez votre nom, puis ENTRÉE ou SORTIE.' },
  reports: { en: 'A report for a pay period, with total and overtime hours, exported to Excel, CSV or PDF.', fr: 'Un rapport pour une période de paie, avec le total des heures et les heures supplémentaires, exporté en Excel, CSV ou PDF.' },
  schedule: { en: 'The weekly schedule grid (Scheduling).', fr: 'La grille d’horaire de la semaine (planification).' },
  activity: { en: 'The activity log: every punch, with Edit and Delete for a manager.', fr: 'Le journal d’activité : chaque pointage, avec Modifier et Supprimer pour un gestionnaire.' },
  geofence: { en: 'A site’s settings: the zone on the map, its radius, and lenient or strict mode.', fr: 'Les réglages d’un site : la zone sur la carte, son rayon, et le mode souple ou strict.' },
  phone: { en: 'Choosing who may clock in from their own phone, and from where.', fr: 'Choisir qui peut pointer avec son propre téléphone, et à partir d’où.' },
  timeoff: { en: 'Adding time off for an employee.', fr: 'Ajouter un congé pour un employé.' },
};
const SHOTS = {
  home: [['hero-dashboard', CAP.dashboard], ['product-punch', CAP.punch]],
  quebec: [['hero-dashboard', CAP.dashboard]],
  gps: [['12-geofence', CAP.geofence], ['16-phone-clock-in', CAP.phone]],
  free: [['product-punch', CAP.punch]],
  scheduling: [['product-schedule', CAP.schedule]],
  software: [['hero-dashboard', CAP.dashboard], ['product-reports', CAP.reports]],
  machine: [['product-punch', CAP.punch], ['product-activity', CAP.activity]],
  field: [['16-phone-clock-in', CAP.phone], ['12-geofence', CAP.geofence]],
  restaurants: [['product-punch', CAP.punch], ['product-schedule', CAP.schedule]],
  retail: [['hero-dashboard', CAP.dashboard], ['15-time-off', CAP.timeoff]],
  factories: [['product-punch', CAP.punch], ['product-reports', CAP.reports]],
};

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────────
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const urlOf = (lang, slug) => `${SITE}/${lang}/${slug}/`;
// The home pages are `/` (English, the app's own landing page) and `/fr/` (HOME_FR above).
const homeUrl = lang => (lang === 'fr' ? `${SITE}/fr/` : `${SITE}/`);
const pageUrl = (page, lang) => (page.home ? homeUrl(lang) : urlOf(lang, page[lang].slug));
const T = {
  en: { tagline: 'Punch, schedules and time off in one Canadian app', start: 'Start free', demo: 'Try the live demo', faq: 'Questions', more: 'More about PunchClock Crew', other: 'Français', home: 'Home', updated: 'Updated', plansH: 'Plans', addonH: 'Add-on' },
  fr: { tagline: 'Pointage, horaires et congés dans une seule application québécoise', start: 'Commencer gratuitement', demo: 'Essayer la démo', faq: 'Questions', more: 'En savoir plus', other: 'English', home: 'Accueil', updated: 'Mis à jour le', plansH: 'Plans', addonH: 'Module' },
};

function render(page, lang) {
  const p = page[lang], o = page[lang === 'en' ? 'fr' : 'en'], other = lang === 'en' ? 'fr' : 'en';
  const t = T[lang];
  const home = homeUrl(lang);
  const signup = lang === 'fr' ? `${SITE}/?signup=1&lang=fr` : `${SITE}/?signup=1`;
  const demo = lang === 'fr' ? `${SITE}/?demo=1&lang=fr` : `${SITE}/?demo=1`;
  const related = PAGES.filter(x => x !== page).map(x => `<li><a href="${urlOf(lang, x[lang].slug)}">${esc(x[lang].h1)}</a></li>`).join('');
  const shots = SHOTS[page.home ? 'home' : page.pair] || [];
  const fig = i => {
    if (!shots[i]) return '';
    const [id, cap] = shots[i], [w, h] = SHOT_SIZE[id] || [2880, 1800];
    return `  <figure><img src="/assets/screenshots/${id}-${lang}.webp" alt="${esc(cap[lang])}" width="${w}" height="${h}" loading="${i === 0 ? 'eager' : 'lazy'}" decoding="async"><figcaption>${esc(cap[lang])}</figcaption></figure>`;
  };
  const sections = p.sections.map(([h, items]) =>
    `<h2>${esc(h)}</h2>` + (items.length > 1 ? `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : `<p>${esc(items[0])}</p>`)).join('\n');
  const pricing = p.pricing ? `<h2>${t.plansH}</h2><div class="plans">${PLANS[lang].map(pl =>
    `<div class="plan"><h3>${esc(pl.name)}</h3><div class="price">${esc(pl.price.split('/')[0])}${pl.price.includes('/')?'<small>/'+esc(pl.price.split('/')[1])+'</small>':''}</div><p class="lim">${esc(pl.limits)}</p><p>${esc(pl.note)}</p></div>`).join('')}</div><h2>${t.addonH}</h2><p>${esc(ADDON[lang])}</p>` : '';
  // An entry may carry { from, until }: a time-limited offer is only in a build made inside that window. These pages
  // have no script, so a build made before `from` leaves it out (it does not appear by itself later).
  const inWindow = (w) => !w || ((!w.from || Date.now() >= Date.parse(w.from)) && (!w.until || Date.now() < Date.parse(w.until)));
  const faqItems = p.faq.filter((f) => inWindow(f[2]));
  const faq = faqItems.map(([q, a]) => `<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join('\n');
  const ld = [
    { '@context': 'https://schema.org', '@type': 'WebPage', name: p.title, description: p.desc, url: pageUrl(page, lang), inLanguage: lang === 'fr' ? 'fr-CA' : 'en-CA', dateModified: UPDATED,
      isPartOf: { '@type': 'WebSite', name: 'PunchClock Crew', url: SITE },
      about: { '@type': 'SoftwareApplication', name: 'PunchClock Crew', applicationCategory: 'BusinessApplication', operatingSystem: 'Web', url: SITE } },
    { '@context': 'https://schema.org', '@type': 'FAQPage', inLanguage: lang === 'fr' ? 'fr-CA' : 'en-CA',
      mainEntity: faqItems.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
  ];
  return `<!DOCTYPE html>
<html lang="${lang === 'fr' ? 'fr-CA' : 'en-CA'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.desc)}">
<link rel="canonical" href="${pageUrl(page, lang)}">
<link rel="alternate" hreflang="${lang === 'fr' ? 'fr-CA' : 'en-CA'}" href="${pageUrl(page, lang)}">
<link rel="alternate" hreflang="${other === 'fr' ? 'fr-CA' : 'en-CA'}" href="${pageUrl(page, other)}">
<link rel="alternate" hreflang="x-default" href="${pageUrl(page, 'en')}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.desc)}">
<meta property="og:url" content="${pageUrl(page, lang)}">
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
figure{margin:26px 0}figure img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:12px;background:var(--bg)}figcaption{font-size:13px;color:var(--muted);margin-top:8px}
footer{padding-top:24px;padding-bottom:40px;font-size:14px;color:var(--muted)}footer ul{list-style:none;padding:0}
</style>
</head>
<body>
<header>
  <a class="brand" href="${home}"><img src="/icon-192.png" alt="" width="34" height="34">PunchClock Crew</a>
  <nav><a href="${home}">${t.home}</a><a href="${urlOf(lang, PAGES.find(x => x.pair === 'pricing')[lang].slug)}">${lang === 'fr' ? 'Tarifs' : 'Pricing'}</a><a href="${pageUrl(page, other)}" hreflang="${other}">${t.other}</a></nav>
</header>
<main>
  <p class="tag">${esc(t.tagline)}</p>
  <h1>${esc(p.h1)}</h1>
  <p class="lead">${esc(p.lead)}</p>
  <div class="cta"><a class="btn primary" href="${signup}">${t.start}</a><a class="btn ghost" href="${demo}">${t.demo}</a></div>
${fig(0)}
${sections}
${pricing}
${fig(1)}
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
- Plans (CAD per month): Free $0 (1 company, 1 site, up to 10 active employees); Starter $19.49 (2 sites, 25 employees); Growth $39.49 (3 companies, 6 sites, 60 employees, adds employee scheduling, lunch breaks and visitor check-in); Business $79.49 (unlimited).
- Phone apps: iPhone and Android apps are planned for January 2027 and will be included with Growth and Business. Nothing is in the App Store or Google Play yet; today everything runs in the browser, and employees can clock in from their own phone through the employee portal (Starter and up).
- Starter and up add geofencing, remote clock-in with GPS (location can be required on every phone punch, from anywhere, for crews on the road), the employee self-service portal (schedule, hours, time off, and reporting a forgotten clock-in or clock-out for the manager to approve), time-off requests, Excel and CSV export, punch corrections, overtime and evening-hours tracking, and automatic email reports including a payroll summary for the accountant.
- Scheduling: included in Growth and Business; on Starter a $14.95/month add-on with a 14-day free trial; includes Québec statutory holidays in one click, work labels, and calendar sync: each employee can add their own shifts to Google Calendar, Apple Calendar or Outlook with a private link.
- Every new account previews the paid features free for 14 days. No credit card for the Free plan.
- Works in a web browser; no app install needed for the clock-in page.
- Software only: PunchClock Crew does not sell, lend or supply tablets or any hardware. Customers use a tablet, computer or phone they already have.
- Operated by 9317-3516 Québec Inc. Support: support@punchclock.ca

## Pages (English)
${PAGES.map(x => line('en', x)).join('\n')}

## Pages (français)
- [${HOME_FR.fr.h1}](${homeUrl('fr')}): ${HOME_FR.fr.desc}
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
writeFileSync(join(ROOT, 'fr', 'index.html'), render(HOME_FR, 'fr'));
written.push(homeUrl('fr'));
writeFileSync(join(ROOT, 'llms.txt'), llmsTxt());
console.log(written.join('\n'));
console.log('+ llms.txt');
