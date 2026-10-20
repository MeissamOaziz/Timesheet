# PunchClock Pro support playbook

Read this before answering any support ticket. It records what the product does today, how past
tickets were diagnosed, and the traps already hit. Keep it current: whenever a customer-visible
feature ships or a ticket teaches something, add it here in the same change.

## Ground rules

- Drafts carry no signature (the Gmail alias appends one). Interactive sessions never send customer email:
  they draft and Meissam reviews and sends. The triage routine follows its own prompt: it may send a
  reply itself only for a Lane A or B fix it has verified, and everything else it drafts.
- Reply in the customer's language (French or English).
- Before trusting a triage summary, check whether a draft or reply already exists in that thread and
  when it was written. A concurrent session may already have changed the facts (the Marie-Pier
  "not a feature yet" reply went out the day the feature shipped).
- Check recent commits and the live product before saying a feature does not exist. Features land
  often, and this document may lag a day.
- Prefer the in-app Message centre (the bell) for announcing updates over emailing every customer.
- Editing a customer's punch rows is never a routine fix. Find the cause, then draft the reply and
  put the exact row and the correction in the summary email for Meissam to approve. If a fix is made
  in an interactive session, say in the draft what was changed.
- If a ticket reveals something this playbook does not cover (a new cause, a feature question, a
  trap), add a short "Playbook suggestion:" line to the summary email so it can be added.

## How punching works (the usual source of confusion)

- The kiosk is a shared tablet, phone or PC set up per site (Sites, Kiosk Shortcut). Staff tap their
  name and enter their PIN. No login.
- The employee portal (employee.html) shows schedule, hours and time off. It can also clock in and
  out remotely, but only when BOTH are on: the company's "Remote Access" switch and that employee's
  own "Remote Clock-In" grant (Employees, edit). "Can't find a punch button" is usually no kiosk set
  up, or one of those two switches being off.
- There is no native phone app yet (an Expo app is planned and not released). A punch made from the
  employee portal on a phone is tagged MOBILE in Activity. Portal punches always use the employee's
  assigned site: there is no site picker, so geofence distance is measured against that one site.

## Wrong hours on a phone punch (Thrive Medical, 2026-10-14)

- Symptom: a day shows about 23 hours instead of about 1 hour.
- Cause: the portal page did not finish sending the clock-out until it was reopened the next morning
  (22 hours later); the portal has no offline queue, so the likely reason is the phone suspending the
  page in the background right after the tap. The portal sends the tap time along with the punch,
  but the server only trusted that time for 16 hours, so it stamped the sync time while keeping the
  real date and time for display. Hours use the stamped time. The GPS pin on such a punch is likely
  from when the page woke up, not from the tap (Stephanie's late OUT and her next IN had identical
  coordinates). This was first described as an offline app queue; that was an inference, not a fact.
  Since 2026-10-19 the portal drops a GPS fix taken more than 30 seconds after the tap, so a delayed
  punch carries no location instead of a wrong one. Older delayed punches may still show a wrong pin.
- Fixed 2026-10-15: the phone's time is now trusted for 48 hours. Activity shows a grey LATE SYNC tag
  on phone punches synced late, and a red CHECK TIME tag if the stamped and displayed times differ by
  12 hours or more.
- Past 48 hours late, the stamped time is still the sync time. Fix: Activity, Edit on the punch,
  re-save the date and time. Employees should open the app once they are back online.
- Diagnosis query: compare punches.punched_at with punch_date + punch_time (company time zone), and
  check synced_late and source.

## Employee can't sign in to the portal (Thrive Medical, 2026-10-19)

- Symptom: "invalid credentials or account not verified" although the employee is sure the password is
  right, and "Forgot password" seems to send nothing.
- Cause found: portal login compared the stored email with the lowercased typed one, so an account
  stored with a capital letter (Kennedy@...) could never match. Fixed 2026-10-19: stored emails are
  lowercased, a trigger keeps them lowercase, and both login functions ignore case. A password
  reset would NOT have fixed this, because login failed the same way afterwards.
- Forgot password only sends a code to the exact email the account is registered under, and says
  nothing either way (so addresses cannot be probed). If no code arrives, ask which address the
  employee typed and compare with employee_portal.email.
- Diagnosis: check employee_portal (status = active, password set, last_login), then Resend's sent
  list for that address. A reset sends an email titled "NNNNNN - Your PunchClock Pro verification
  code". If none exists there, no code was generated for that address.
- Admin workaround when someone is locked out: Admin, Employees, resend the portal invitation.

## GPS and geofencing (sales questions come up often)

- Phone punches (employee portal, "Remote clock-in") record GPS latitude/longitude, accuracy and, when the
  employee's site has a location, the distance from it. Admins see a map pin per punch in Activity.
- Remote clock-in needs BOTH the company's Remote Access switch and a per-employee Remote Clock-In
  grant (set individually or in bulk from Employees). Employees activate the portal from an email
  invitation. Nothing to install: it runs in the phone's browser and can be saved to the home screen.
  The phone must allow location access.
- Geofence: each site can have a location and a radius of 25 to 500 m, in Lenient mode (the punch goes
  through with a warning if GPS is unavailable) or Strict mode (blocked outside the radius or without
  GPS). The kiosk blocks a punch outside the radius. Portal punches only block in Strict mode.
- Caveat for crews that move between job sites: a portal punch always counts against the employee's
  assigned site, so Strict mode would block them anywhere else. For roaming crews, do not enable Strict
  mode; the recorded GPS pin per punch is the proof of where they started and finished.
- Plans: Free (1 site, 10 employees), Starter $19.49/month CAD (2 sites, 25 employees), Growth $39.49
  (6 sites, 60 employees), Business $79.49 (unlimited). Flat price per account, not per employee. Remote
  clock-in and geofencing are not plan-gated.

## Everyone was signed out on 2026-10-19 (evening, Toronto)

- All admin sessions were reset as a security precaution after a fix to the data access layer. If a
  customer says they were suddenly logged out of the admin dashboard, that is expected: sign in again
  with the usual email and password. Kiosks, clock-in and the employee portal were not affected.
- Do not describe it as a breach. Say a security update required everyone to sign in again.

## Features and how to explain them

Work labels (Scheduling add-on, $14.95/month, paid plans). Customers define their own labels (a task,
a job, a project, a client) with a colour.
- Setup: Schedule, Create/Manage labels. Owners and admins only; managers can use labels, not edit them.
- Scheduling: pick a Label on each shift. A day with two kinds of work is two shifts. Use "Also apply
  this shift to" (other days) and "Also assign this shift to" (other employees).
- At clock-in (optional): Sites, edit company, "Work labels at clock-in": Off (default), Ask but allow
  skipping, or Required. The employee picks the task after their PIN; today's scheduled label is
  highlighted. "Switch task" (name, PIN, new task) records an OUT then an IN at the same moment, so
  totals and overtime are unaffected. Returning from a break keeps the same task.
- Reporting: Activity shows a label badge and filter; Edit/Add Punch can set a label. Reports has a
  Label filter, a Label column and an "Hours by label" table (also in PDF/Excel/CSV). Hours are
  attributed from the IN punch. Filtering never changes overtime. Not shown: dollar labour cost
  (planned, not built).
- Not supported yet: choosing a task when clocking in from the employee portal.
- A label is not the employee's Department. Department says who a person is; a label says what a
  shift or stretch of work is for.
- Granting a 7-day trial is manual: set admins.scheduling_addon = true and scheduling_trial_ends_at,
  and schedule a guarded one-off pg_cron job to switch it off. Nothing expires it automatically.

Other recent changes
- Reports and Activity: Previous / Next / Current period buttons that step through pay periods.
- Schedule: "Clear week" for one employee; copy a shift to other employees; a company setting lets
  site managers see and schedule staff from all sites (off means only their own sites).
- Retention: records older than 18 months are archived monthly. Every company can always pull reports
  for the last 18 months. Older data is available on request. This is stated in the Terms
  and the Privacy Policy.
- Kiosk device list (site settings) shows IP, model and OS, which helps identify a tablet.
- Kiosks reload themselves when they detect stale data (the Windsor ghost clock-in issue).

## Diagnostic recipes

- "Someone shows clocked in who wasn't there": check the kiosk's site and device list, and whether the
  punch came from MOBILE (location map in Activity). A stale kiosk screen was a past cause.
- "Report or Activity missing punches": the data layer pages through results and reports split large
  ranges; very large ranges ask the user to narrow the dates.
- "Hours look wrong": compare punched_at, punch_date and punch_time, then look for is_manual,
  synced_late, break rows (is_break) and task switches (is_switch pairs with no gap).

- "Company settings / company information will not save, nothing happens when I press Save": from
  2026-10-13 to 2026-10-20 the company edit form threw an error on every account WITHOUT the Scheduling
  add-on (a variable used before it was declared in saveCompany), so nothing reached the server and no
  error showed. Fixed 2026-10-20. If it is reported again, first check audit_log for a `companies` PATCH
  by that admin (none = the click never reached the server, so it is a browser-side error), ask for a
  hard reload (Ctrl+Shift+R, or fully close and reopen the app) and a screenshot of the console.

- "An employee cannot sign in" / "Invalid credentials or account not verified": that exact wording only
  exists on the ADMIN sign-in screen (punchclock.ca, "Admin Login"). The employee portal at
  https://www.punchclock.ca/employee.html says "Invalid email or password." instead. So the employee is
  almost certainly typing their email on the wrong page: employees have a portal account, not an admin
  account, so the admin screen can never accept them, and its "Forgot password?" sends nothing (it only
  looks up admins), which looks like "the reset email never arrives". Check this FIRST (Thrive Medical /
  Kennedy Watson, Oct 16-20, took three rounds because it was missed). Since 2026-10-20 the admin
  sign-in card, its error message and its forgot-password page link to the employee portal.
- Employee wants a new password: in the portal, tap "Change password" at the bottom of the page (or the
  circle with their initial, top right); it needs the current password. If they forgot it, "Forgot your
  password?" on the portal sign-in page emails a 6-digit code (15 minutes). Support can also set a
  temporary password directly in employee_portal.password_hash with
  `extensions.crypt('<temp>', extensions.gen_salt('bf', 10))` and then ask them to change it at once.
  Emails are matched case-insensitively. Portal account emails are stored in lowercase.

## Style of a good reply

State what happened in plain words, say what was fixed and for whom, say what changes from now on,
and give one concrete step the customer can take themselves, using the exact on-screen names (they
are in the app's French and English dictionaries). Do not blame the employee unless it was their action.
