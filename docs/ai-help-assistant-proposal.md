# In-app AI help assistant (proposal, 2026-10-24, not started)

Goal: most "how do I...?" tickets are answered inside the app, in French or English, without Meissam. The same
answers nudge Free users toward the plan that unlocks what they just asked about, and nudge paid users toward the
add-on or tier that fits.

## What the customer sees
- A "Help" button in the admin app (replaces the static help link, keeps the help center articles as sources).
- A chat panel that opens with three suggestions chosen from the page they are on (on Sites: "Set up a kiosk tablet",
  "Turn on geofencing"; on Reports: "Export for payroll", "Why are my hours different?"; on Activity: "Fix a missed
  clock-out"; on Schedules: "Build next week's schedule").
- Answers are short, numbered steps with the exact menu names, and a button that opens the right page.
- A "Talk to a person" button that opens the support form with the question and the assistant's answer already in it.
- Thumbs up / down on every answer (the down votes are our to-do list for the knowledge base).

## How it works
1. Edge function `help-assistant` (new). The browser sends the admin session token and the question; the function
   checks the session itself (same lookup as `secure-db`), so it knows the account, never the other way round.
2. Knowledge = the pricing table and plan rules, `docs/support-playbook.md` (customer-safe sections only) and the help
   center text, loaded into the system prompt and prompt-cached. The assistant is told to answer only from it, and to say
   "I'm not sure, here is how to reach us" otherwise. No browsing, no database search in phase 1.
3. Account context passed in (counts and flags only, never names or punches): plan, preview end date, number of
   sites and employees, which features are switched on, whether a kiosk has checked in. This is what makes
   "you have not set up a kiosk yet" and "Excel export needs Starter" possible.
4. Model: Haiku 5.5 by default (fast, cheap). Anything it flags as complicated can be retried once on Sonnet 5.5.
   Answers capped at about 600 tokens.
5. Read-only. The assistant explains and links; it never changes data in phase 1.

## Upsell rules (written into the prompt, tested)
- Mention an upgrade only when the question needs a locked feature or a limit the account has hit. One sentence:
  what is locked, which plan unlocks it, the price. Never in answers about bugs, login problems or billing disputes.
- A Free account inside its preview is told the date the preview ends, once per conversation.
- A paid account is pointed to the add-on that matches the question (Scheduling for shifts, labels, holidays;
  Growth for lunch breaks and visitors).
- Never pushy, never repeated, always true to the pricing page.

## Cost, limits, privacy
- Rate limit per admin (suggest 20 questions a day on Free, 100 on paid) and a global monthly spend cap that turns
  the assistant into "contact support" when reached. Counters live in a small table with RLS on, service key only.
- Conversations are stored 90 days (question, answer, rating, plan) to improve the knowledge base. The panel says so
  in one line (Law 25). Employee names and punch data are never sent to the model.
- Rough size: a few tenths of a cent per question on Haiku; 40 free accounts asking 5 questions a month is pocket
  change. Re-check against the current price list before launch.

## Quality control
- A test file of about 60 real questions (EN and FR, taken from the support inbox and `support-playbook.md`) with the
  facts each answer must contain and must not contain (wrong prices, features that do not exist). Run on every change to
  the knowledge base or prompt, like the other `tools/*-test.mjs` suites.
- The support triage routine keeps feeding the playbook; the assistant gets better when the playbook does.

## Phases
1. (2-3 days) function, panel, knowledge base, rate limits, ratings, escalate-to-support, EN/FR, test suite.
2. Account-aware hints: "you are one step from done" setup nudges, page-aware suggestions.
3. Guided actions with confirmation (prepare a punch correction or a schedule the admin approves). Only after phase 1
   has run for a few weeks and the ratings are good.

## What I need from Meissam
- Go-ahead, and an Anthropic API key stored as the `ANTHROPIC_API_KEY` secret in the PunchClock Supabase project
  (Edge Functions secrets; I never see the value).
- A monthly budget cap for the assistant.
- OK on the one-line privacy notice in the panel.
