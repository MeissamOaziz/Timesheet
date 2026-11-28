# PunchClock Crew support playbook

Read this before answering any support ticket. It records what the product does today, how past
tickets were diagnosed, and the traps already hit. Keep it current: whenever a customer-visible
feature ships or a ticket teaches something, add it here in the same change.

## Brand (since 2026-11-04)

The product is **PunchClock Crew**. It was called PunchClock Pro until 2026-11-04, so a customer's older emails, screenshots and invoices may still say "PunchClock Pro": same product. Use "PunchClock Crew" in every reply and draft. Support replies come from "PunchClock Crew Support". The employee phone app is also called PunchClock Crew (iPhone and Android, early testing only: do not promise a release date). If an instruction elsewhere in your prompt still says "PunchClock Pro", this section wins.

## Ground rules

- Drafts carry no signature (the mail alias appends one). Interactive sessions never send customer email:
  they draft and the owner reviews and sends. Automated triage follows its own prompt and drafts
  everything it is not explicitly allowed to send.
- Reply in the customer's language (French or English).
- Account deletion requests (public page: punchclock.ca/delete-account.html; the phone apps link to it). NEVER delete
  anything yourself and never promise a date shorter than the page's 30 days. Check that the request comes from the
  email address of the account it names; if it does not, say kindly that we can only act on a request sent from the
  account's own address. Then flag it to the owner as ACCOUNT DELETION REQUESTED with who asked and which kind of
  account (employee login, co-admin or manager, or the whole owner account), and answer that the request is
  received and will be confirmed when done. An employee's punches, time off and schedule stay in the employer's
  account (the employer's work records): tell the employee to ask their employer for those. An owner should export
  what they need first; a deleted account cannot be restored.
- We sell software, never hardware (owner's rule, 2026-11-23). Never write a feature so that it reads as an
  object we hand over: not "clock-in tablet with PIN", "terminal included", "Tablette de pointage avec NIP" or
  "terminal de pointage inclus". Always say whose device it is: "PIN clock-in on your own tablet or computer",
  "vous configurez votre propre tablette ou ordinateur comme kiosque de pointage avec NIP". In any price list or
  quote, add one plain sentence: the customer uses a tablet, computer or phone they already have; we do not
  sell, lend or supply devices. If someone asks us to send or include a tablet, say so kindly and tell them any
  recent tablet or spare phone with a browser works.
- Phone calls (owner's rule, 2026-11-16). Never refuse a call, and never write that we prefer email, that we
  reply by email only, or anything else about how we would rather be contacted. Still answer the question
  as fully as possible by email in the same reply: the call comes on top of the answer, never instead of it.
  A call is wanted when the customer asks to be called or to speak with someone, gives a phone number so we
  can reach them, or accepts a call we offered. Offer one yourself when email is clearly not getting there:
  a second follow-up on the same question, a need we still do not understand, a prospect deciding whether we
  fit. In the reply, say we will gladly call, repeat the number they gave (or ask for one) and ask what time
  suits them; never promise an exact time or day. Only the owner makes calls, so he must know every time:
  the summary email's subject and first line start with "CALL REQUESTED", followed by the name, company,
  number, language, plan or prospect, and what the call should cover. Never file a call request under
  "optional" or "nothing needed".
- Before trusting a triage summary, check whether a draft or reply already exists in that thread and
  when it was written. A concurrent session may already have changed the facts (a customer once got a
  "not a feature yet" reply on the day the feature shipped).
- Check recent commits and the live product before saying a feature does not exist. Features land
  often, and this document may lag a day.
- Prefer the in-app Message centre (the bell) for announcing updates over emailing every customer.
- Editing a customer's punch rows is never a routine fix. Find the cause, then draft the reply and
  put the exact row and the correction in the summary email for the owner to approve. If a fix is made
  in an interactive session, say in the draft what was changed.
- If a ticket reveals something this playbook does not cover (a new cause, a feature question, a
  trap), add a short "Playbook suggestion:" line to the summary email so it can be added.

## What changed on 2026-11-17 and 2026-11-18 (read first: new releases, symptoms and what to do)

Many changes shipped in two days while customers were using the product. Nothing here is known to be broken, but a ticket
that matches one of the symptoms below is probably about one of these changes. **If a ticket could be caused by one of
them, put "POSSIBLE REGRESSION: <the change>" as the first line of that ticket's entry in the digest and quote what the
customer saw**, so the owner can look the same day. A customer or employee who cannot clock in or out is CRITICAL as always: follow
the CRITICAL steps first. Never edit punch rows to fix these (see the ground rules); draft the reply and put the exact row in
the summary.

| What the customer says | What changed / most likely cause | What to do |
|---|---|---|
| "Where is Company Info?" / "I cannot find overtime, rounding, alerts, the logo" (from 2026-11-20) | The long Company Info window became a **Settings** page, same fields saved the same way: left menu Settings (also in the profile menu and the phone menu) with four tabs: **Company** (name, address, phone, industry, logo), **Pay and hours** (week start, pay frequency, rounding, overtime, evening hours), **Clocking** (remote and phone clock-in, work labels, lunch breaks, visitor check-in), **Managers and alerts** (managers see all sites, alerts). A company picker shows at the top when the account has several companies. Managers do not have it, as before | Point them to the tab. Changes are saved with the **Save changes** bar at the bottom; leaving with unsaved edits asks first. The New company window is unchanged. If a value "did not save": ask whether they pressed Save changes and whether an error showed above the form; a Free account past its preview still sees overtime, evening hours and remote clock-in locked, as before |
| "Where is Phone clock-in?" / "I do not see the Phone column" | Since 2026-11-17 phone clock-in is hidden until it is in use (company Remote Access switch on, someone granted it, or the owner chose phones/both in the first-run question) | Not on for them yet. Path: Settings (left menu or profile menu), Clocking tab, Remote Access, "Set up phone clock-in". See "Phone clock-in: the quick way" |
| "Why do I have Phone clock-in? Can my employees punch from their phones? I do not want that" | Same change: the owner no longer sees it unless it is in use | No: nothing lets anyone punch from a phone unless the owner switches it on AND grants it person by person. Reassure, no action needed |
| Manager: "Phone clock-in is not turned on for your company yet. Ask the account owner to turn it on." | Only owners and co-admins turn the company switch on; managers can invite and grant at their own sites once it is on | Expected message, not a bug. The owner turns it on |
| Several companies on one account: an employee shows "Portal only" although phone clock-in is on | Each person is judged by their own company's switch; the window manages one company and names it at the top | Open Phone clock-in for that company (Settings, pick that company at the top, Clocking tab, "Set up phone clock-in") |
| Invitation arrived in the wrong language | The admin picks the language when sending (Email language: English / Francais, default = the admin's screen language, remembered in that browser). The set-password page has its own EN/FR switch | Resend the invitation with the right language. An employee who already activated must be revoked first (Edit employee, Revoke Access), then invited again |
| "Invited" but no email arrived | The invitation row is now removed/restored when the email fails to send, so this should not appear any more. Spam folders and the hourly email limit are the usual causes | Check the spam folder, then the employee's email address; if the screen says "too many emails", wait an hour |
| Portal on a phone: "Could not record punch", still shows Clocked in, then "You are not clocked in yet" (before 2026-11-18 evening) | A weak connection lost the server's reply, the punch WAS stored (found 2026-11-18). Fixed in cache v101: the portal retries safely and re-checks | Tell the employee to reload the portal: the punch is almost always there. Check Activity first; add a missed punch only if it is really absent |
| Portal on a phone after the fix: "No connection. Your punch was NOT recorded" | Nothing reached the server | Retry when the signal is back; if it persists, take the exact time and report it |
| Tablet: "Error saving punch: Failed to fetch" | Weak Wi-Fi; before cache v103 the punch could be stored with the reply lost | Check Activity: if the punch is there do not add another one. Tap again only if it is absent |
| Activity "Map" button / colours on the punch map (new 2026-11-18) | Map shows located punches in the current filter, green inside the geofence, orange outside, grey no position; filled dot = IN, ring = OUT; the pin on a row opens one punch with its GPS accuracy and distance | A punch without a dot had no position: a fixed kiosk tablet does not save one, and a phone that refused location has none. It is not an error |
| "Blocked / outside the geofence while standing at the door" | Phones are often 10 to 30 m off indoors; a 25 m radius in Strict mode turns people away (the editor now advises 50 to 100 m and warns under 50 m in Strict) | Edit the site, Set Geofence, raise the radius to 50 to 100 m; offer Lenient if they only want a warning |
| Homepage: "the login button disappeared" (phone or half-width window) | The links moved into the menu button (three lines) at the top right | Open that menu: Admin Login and Employee Portal are inside |
| A table is cut off or scrolls sideways at a mid-width window; employee portal header looks different on a phone | Layout fixes of 2026-11-17: tables scroll sideways, the portal header shrinks | Expected; ask for a screenshot and the window width if something is really unreachable |
| Something looks like the old version | Tablets and installed pages update only when the service worker version changes (current: v103 on 2026-11-18); a page left open can be a day behind | Reload (hard refresh) or close and reopen the app; on a kiosk tablet reload the page once |

**Not yet seen with real customers** (so a ticket here is more likely to be a real bug, flag it): an invitation email that
fails to send, a French invitation email, an account with several companies using phone clock-in, a manager signed in to the
phone clock-in screens, and a tablet on very bad Wi-Fi. Also new and used by nobody yet: the Activity crew map on busy
accounts (it draws at most the latest 300 located punches).

Quick checks the owner's tools can do for a suspected regression: the punch list for that employee (is the punch there?),
two punches of the same type in a row, and the audit log events plan_write_blocked, role_write_blocked, cross_tenant_write_blocked.
As of 2026-11-18 evening none of these showed anything unusual after the releases, and no same-type-in-a-row punches existed in
the previous 48 hours.

## How punching works (the usual source of confusion)

- The kiosk is a shared tablet, phone or PC set up per site (Sites, Kiosk Shortcut). Staff tap their
  name and enter their PIN. No login.
- The employee portal (employee.html) shows schedule, hours and time off. It can also clock in and
  out remotely, but only when BOTH are on: the company's "Remote Access" switch and that employee's
  own "Remote Clock-In" grant (Employees, edit). "Can't find a punch button" is usually no kiosk set
  up, or one of those two switches being off.
- Phone apps (owner's answer, 2026-11-23). Nothing is in the App Store or Google Play yet, but when someone asks
  "is there an app?" or "is one coming?", the answer is YES, one is coming: we are building two apps, one for
  employees (clock in and out, hours, schedule, time off) and one for owners and managers, and we plan to
  release both on the App Store and Google Play in January 2027. Say "planned for January 2027", never a
  day, and never promise a feature of the apps that the website does not already have. Then say what works
  today: everything runs in the browser, employees clock in from their own phone through the employee portal
  (Starter and up), and the page can be added to the phone's home screen. Their account, employees and hours
  will carry over to the apps; nothing to redo. Do not answer only "no app": that reads as a dead end.
  Plans (owner's decision, 2026-11-28): the apps will be included with Growth and Business only, not with Free
  or Starter. Say so whenever the apps come up, and never tell a Free or Starter customer the apps will be part
  of their plan. On Free and Starter everything keeps working in the browser exactly as today, phone clock-in
  through the employee portal included (Starter and up). The home page and the dashboard carry a short notice
  with the same wording.
  A punch made from the
  employee portal on a phone is tagged MOBILE in Activity. Portal punches always use the employee's
  assigned site: there is no site picker, so geofence distance is measured against that one site.
- Sales: a prospect who asks about "the terminal" (how to get it, who supplies it) may not want a fixed
  device at all: staff placed at client sites, crews on the road. Do not answer with kiosk steps only.
  Give both ways in the same reply, then ask how their people work. (1) Employees punch on their own
  phones through the employee portal: nothing to buy or install, each punch carries its time and GPS pin,
  Starter and up (a new Free account can try it during its 14-day preview). (2) A shared kiosk at a fixed
  place: any tablet or spare phone they already own, included in every plan; we sell no hardware. Both can
  be used in one account. (Recruiting-agency prospect, 2026-11-16: three kiosk-only replies in a row missed
  what they were really asking.)

## Wrong hours on a phone punch (clinic customer, 2026-10-14)

- Symptom: a day shows about 23 hours instead of about 1 hour.
- Cause: the portal page did not finish sending the clock-out until it was reopened the next morning
  (22 hours later); the portal has no offline queue, so the likely reason is the phone suspending the
  page in the background right after the tap. The portal sends the tap time along with the punch,
  but the server only trusted that time within a limited window, so it stamped the sync time while
  keeping the real date and time for display. Hours use the stamped time. The GPS pin on such a punch
  is likely from when the page woke up, not from the tap (the late OUT and the next IN had identical
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

## Employee can't sign in to the portal (clinic customer, 2026-10-19)

- Symptom: "invalid credentials or account not verified" although the employee is sure the password is
  right, and "Forgot password" seems to send nothing.
- Cause found: portal login compared the stored email with the lowercased typed one, so an account
  stored with a capital letter in the email could never match. Fixed 2026-10-19: stored emails are
  lowercased, a trigger keeps them lowercase, and both login functions ignore case. A password
  reset would NOT have fixed this, because login failed the same way afterwards.
- Forgot password only sends a code to the exact email the account is registered under, and says
  nothing either way (so addresses cannot be probed). If no code arrives, ask which address the
  employee typed and compare with employee_portal.email.
- Diagnosis: check employee_portal (status = active, password set, last_login), then Resend's sent
  list for that address. A reset sends an email titled "NNNNNN - Your PunchClock Crew verification
  code". If none exists there, no code was generated for that address.
- Admin workaround when someone is locked out: Admin, Employees, resend the portal invitation.

## Phone clock-in: the quick way (since 2026-11-17)

- **It stays out of sight until it is in use (2026-11-17, owner's request).** The Team menu entry (and the phone menu entry),
  the Phone column on Employees and the bulk "Invite to phone clock-in" button only appear once the company's Remote Access
  switch is on, someone has been granted remote clock-in, or the owner chose "their own phones" or "both" in the first-run
  question. Everyone else never sees the word "phone" in the admin screens, so nobody wonders whether their employees can
  suddenly punch from phones: they cannot unless the owner switches it on and grants it person by person. The way in is
  **Settings** (left menu or profile menu), the **Clocking** tab, **Remote Access**, **Set up phone clock-in** (owners and
  co-admins; managers do not see it). If a customer says "I do not see Phone clock-in": it is not on for them yet, send them that path.
- **Where (once it is on):** left menu, Team, **Phone clock-in**. One window: tick who may
  clock in from their phone, type any missing email, choose where they can clock in for each site, press **Send N
  invitations**. It turns on the company's Remote Access switch if it is off, writes the email if one was typed, sends
  the portal invitation, and grants the employee's Remote Clock-In, in that order. A confirmation explains the grant first.
- **Where can they clock in** (per site, only for a site with no address): "Anywhere" (location saved when the phone allows
  it) or "Anywhere, location required" (Strict, no address: the roaming-crew setup). A site that has a geofence shows its
  radius and a Change button that opens the site's own geofence settings.
- **The Phone column** on Employees replaced the old "Email report" column. It reads: Needs an email (Add email), Not
  invited (Invite), Invited (Resend), Portal only (Allow clock-in) or Can clock in. Free accounts past their preview see
  "Starter and up". The bulk bar has **Invite to phone clock-in**. Whether an employee gets the automatic email report is
  still set in their Edit window.
- **A manager** can invite people and grant phone clock-in at their own sites once the company's Remote Access switch is on.
  Turning that switch on is the owner's: if a manager presses Invite or Allow clock-in while it is off, the screen says
  "Phone clock-in is not turned on for your company yet. Ask the account owner to turn it on." (nothing is written). Managers
  do not see the Phone clock-in menu entry or window.
- **Several companies on one account:** the Employees list shows everyone together, and each person is judged by THEIR
  company's Remote Access switch (an employee of a company where it is off reads "Portal only" even if another company
  has it on). The bulk invite turns the switch on for each company among the people chosen. The Phone clock-in window
  manages one company, and names it at the top when the account has more than one; "Set up phone clock-in" in Settings
  opens it for the company being edited.
- **"Could not record punch" on a phone, then "You are not clocked in yet" (fixed 2026-11-18):** on a weak connection the server could
  store the punch while its reply never reached the phone, so the portal showed an error and stayed on the old state. The
  portal now sends one id per tap and retries up to three times with the same id (the server answers the first result, never
  a second punch), gives up a silent request after 20 s, and always re-reads the punches afterwards so the screen matches the
  server. If the punch did go through it says "Clocked in/out"; if not it says "No connection. Your punch was NOT recorded".
  Before that fix: ask the employee to reload the portal (the punch is usually already recorded) and check Activity; add a
  missed punch only if it is really absent.
- **Forgot to clock in or out (since 2026-11-24):** the employee reports the real time themselves: in the phone app (Home shows
  "Still clocked in?" after 12 hours, or Hours > Report a missed punch) or in the employee portal (My Hours > Report a missed
  punch). Up to 14 days back. The forgot-to-clock-out alert now also emails the employee (when they have a portal login) and
  pushes to their phone, both leading to that form. The manager approves it under Requests. If a manager already added a punch
  by hand for that shift, approving shows both times and asks which one is right (the other is removed, or the request is
  declined). Older than 14 days: the manager adds it from Activity.
- **Tablet shows "Error saving punch: Failed to fetch" (weak Wi-Fi), 2026-11-18:** the punch may be stored with only its reply lost.
  The terminal now re-reads the server before reporting a failure and shows the normal green confirmation if the punch is there;
  it never re-sends a punch by itself. If a red error stays, nothing reached the server: tap again once the Wi-Fi is back. Before
  this fix an employee who tapped again got "Already clocked in": the first punch was real, do not add a second one.
- **Language of the invitation email (2026-11-18):** the admin picks it when sending: an "Email language" choice (English / Français)
  beside the invitation button in the Edit employee window and above the Send button in the Phone clock-in window; the
  confirmation names the language. It defaults to the admin's screen language and is remembered in that browser. There is
  no per-employee language stored yet (that would need a database column). The set-password page the employee reaches from
  the email has its own EN/FR switch; the portal otherwise starts in the phone's/browser's language. If a French-speaking
  employee got an English email, resend the invitation with Français selected.
- **First-run question:** a new account with no punches is asked on the dashboard "How will your team clock in?" (tablet,
  their own phones, both). The checklist then lists the matching steps; for phones the last step is the first punch from a
  phone (a punch whose source is mobile). The answer is kept on that browser only; "Change how your team clocks in" on the
  checklist asks again.
- It writes only settings that already existed, so every old way (Settings, the employee's Edit window, the bulk
  buttons) still works and agrees with it.
- **"N could not be sent" or "Stopped: the hourly limit on emails was reached"** (since 2026-11-17): an account can send
  30 invitations and other one-off emails per hour (schedule emails have their own, higher limit). At the limit the window
  stops, says why, and leaves the people it did not reach ticked; the bulk button says how many went out before it stopped.
  Answer: wait an hour and press Send again, nothing is lost. The one person whose invitation was refused at the limit can
  show **Invited** although no email arrived: press **Resend** in the Phone column. In the window, any other reason shown
  after the count (for example a bad email address) concerns that person only and the others were still sent; the bulk
  button on the Employees list stops at the first failure of any kind and says how many went out before it.
- **Checked on the live site on 2026-11-17** with a real owner account and a test employee: the Phone column and the window
  show the right state for every person, and an employee who "Can clock in" sees the Clock In button at the top of the
  portal, is asked "What are you working on?" when work labels are on, and the punch appears in Activity with a Mobile tag.
  When the phone or browser gives no location and the site is not Strict, the punch still goes through and is tagged
  "No location". The invitation email itself and the map pin were not part of that check.
- **Display problem at mid widths (found and fixed 2026-11-17):** in a window wider than a phone but narrower than about
  1,250 px (a small laptop, a tablet held sideways, a half-width browser window) the right-hand columns of the Employees
  list (Phone, Status, Actions with Edit) used to be cut off. Tables now scroll sideways at those widths, so every column
  can be reached; Reports had the same problem at about 800 px and is fixed too. A customer on a copy opened before the
  fix may need to reload the page (or fully close and reopen the app on a tablet). If someone still says they "cannot find
  the Edit button" or "the Phone column is empty", ask about the window size, tell them to scroll the table sideways, and
  check they are on the current version.

## GPS and geofencing (sales questions come up often)

- Phone punches (employee portal, "Remote clock-in") record GPS latitude/longitude, accuracy and, when the
  employee's site has a location, the distance from it. Admins see a map pin per punch in Activity.
- Remote clock-in needs BOTH the company's Remote Access switch and a per-employee Remote Clock-In
  grant (set individually or in bulk from Employees). Employees activate the portal from an email
  invitation. Nothing to install: it runs in the phone's browser and can be saved to the home screen.
  By default an employee who refuses location access can still clock in (the punch has no pin and is
  flagged "no location" when the site has an address). To make location mandatory, use Strict mode.
- Maps (2026-11-18): Activity has a **Map** button next to Filter that shows every punch with a location in the current filter
  on one map (latest 300), with the site circles; dot colour = status (green inside, orange outside, grey no position), filled
  dot = IN, ring = OUT; tap a dot for name, time, status and distance. The pin on a row opens that single punch with a light
  circle for the GPS accuracy, a dashed line to the site with the distance, and an IN/OUT + time label. The radius editor now
  advises 50 to 100 m (phones are often 10 to 30 m off indoors) and warns under 50 m in Strict mode; site cards show radius and
  mode, e.g. "75 m · Strict". A punch with no dot on the map had no position (grey status), a fixed kiosk tablet does not save one.
- Geofence: each site can have a location and a radius of 25 to 500 m, in Lenient mode (the punch goes
  through with a warning if GPS is unavailable) or Strict mode (blocked outside the radius or without
  GPS). The kiosk blocks a punch outside the radius. Portal punches only block in Strict mode.
- Crews that move between job sites (location required, clock in from anywhere): edit the site, open
  Set Geofence, choose Strict and do NOT set an address (or press Remove Geofence first, then choose
  Strict). Every phone punch then needs a location, with no distance limit, and each punch carries its
  GPS pin. Do not combine Strict with an address for a roaming crew: a portal punch counts against the
  employee's assigned site, so they would be blocked anywhere else. The kiosk is not affected by Strict
  when the site has no address.
- Plans: Free (1 site, 10 employees), Starter $19.49/month CAD (2 sites, 25 employees), Growth $39.49
  (6 sites, 60 employees), Business $79.49 (unlimited). Flat price per account, not per employee. Remote
  clock-in and geofencing are Starter-and-up features (Free previews them 14 days; see the plan table below).

## Kiosk link or QR "opens the sign-up page" (retail customer, 2026-11-04)

- What the page does: a kiosk link is the site address plus `?kiosk=<site id>`. A device also remembers its kiosk
  in its own browser storage (`pc_kiosk_device`), so a home-screen icon that opens the bare address returns to the
  punch page only while that storage survives. With no `?kiosk=` and nothing stored, the page shows the landing
  (sign-up) page. If the site id is unknown the landing page shows with a red "Kiosk URL not found" message. Any
  error in the lookup also falls back to the landing page silently.
- Check in this order: (1) is the kiosk really down? Compare the latest punches of that site by `source` (`kiosk`
  versus `admin`) and the site's `kiosk_devices.last_seen`; a tablet that never reached the page leaves no check-in.
  (2) Does the link work from a fresh browser? POST `{action:'kiosk_bootstrap',kioskV:2,kioskSiteId}` to secure-db
  and expect `ok:true` with the site and employees, then open the link in a clean mobile browser with the
  `kiosk_device_checkin` call stubbed so no fake terminal is added to the customer's list. (3) Is the QR valid?
  Run the page's own encoder on the link and decode it with a second scanner (zbar). All three were fine on
  2026-11-04, so the cause was on the tablet or in how the code was opened.
- Reply with a QR-free path: Sites, the site's kiosk shortcut, "Copy link", send the link to the tablet and open it
  there, then "Add to Home Screen". Ask for the address shown in the tablet's browser, the tablet model and browser,
  and any red message. A reset needs a confirmation tap, so an accidental reset is unlikely.

## Everyone was signed out on 2026-10-19 (evening, Toronto)

- All admin sessions were reset once as a security precaution. If a customer says they were suddenly
  logged out of the admin dashboard around that date, that is expected: sign in again with the usual
  email and password. Kiosks, clock-in and the employee portal were not affected.
- Keep the explanation to: a security update required everyone to sign in again.

## What each plan includes, and the 14-day preview (from 2026-10-24)

The pricing page, the in-app locks and the server jobs all follow this table. If it changes, change all three
(`index.html` `featureEntitled`, `public.has_paid_features`, the pricing cards and FAQ) in the same commit.

| | Free | Starter $19.49 | Growth $39.49 | Business $79.49 |
|---|---|---|---|---|
| Company / sites / employees / admins | 1 / 1 / 10 / 1 | 1 / 2 / 25 / 2 | 3 / 6 / 60 / 4 | unlimited / unlimited / unlimited / 6 |
| PIN clock-in on the customer's own tablet or computer (we supply no device), dashboard and activity log, PDF reports, missed clock-out alerts | yes | yes | yes | yes |
| Geofencing, remote clock-in, employee portal, time off, Excel and CSV export, add / edit / delete punches, overtime tracking, evening hours, automatic email reports (employees and the accountant's payroll summary) | no | yes | yes | yes |
| Lunch breaks, visitor check-in | no | no | yes | yes |
| Scheduling (shifts, holidays and the Québec holiday button, work labels, calendar sync for employees) | 14-day trial only | $14.95 add-on, 14-day trial | included | included |

- **Growth and Business include Scheduling (from 2026-11-26).** Starter buys it as the $14.95 add-on and can try it
  free for 14 days. The rule lives in four places that must agree: `index.html` `hasSchedulingAddon`, secure-db
  `schedulingActive`, the database helper `admin_scheduling_active` (portal schedule, portal labels and clock-in
  label, calendar link) and `stripe-handler` (refuses the add-on checkout for Growth and up).
- A Starter customer who pays the add-on and moves to Growth or Business: the add-on subscription is set to end
  with the month already paid (no refund, per the Terms; no further charge). Scheduling stays on the whole time,
  because the new plan includes it. Nothing for the customer to do. If they later move back to Starter, they buy
  the add-on again (or start the trial, if they never used it).

- Every Free account previews the Starter features until **14 days after it was created, and in any case until
  2026-11-06**. The lock starts at midnight Eastern at the start of 6 November (the screens and the portal lock at once;
  the clean-up job below runs 10 minutes past every hour, so settings are switched off by 00:10). Accounts created after
  23 October keep their full 14 days and lock later. After that the controls lock, the hourly job
  (`enforce_plan_features`) switches off overtime and evening hours, and the email reports stop (recipients stay on file
  and resume the day they upgrade).
  Geofences and the remote clock-in switch are switched off by the same job but their
  settings are kept aside (`sites.geo_*_bak`, `companies.remote_punch_bak`) and come back automatically within the hour
  of an upgrade. The employee portal stops at once for a company that is not entitled (its employees see "your
  employer's plan does not include the portal"), which also stops remote punches and their time-off requests; the
  Time Off page and the portal invitation / remote grant controls are replaced by an upgrade note. Nothing is deleted.
  Lunch breaks and visitor check-in have no preview.
- If a Free customer complains that a feature disappeared: it is as advertised on the pricing page, they had a
  preview period to try it, and upgrading brings everything back as it was (recipients, geofences, the remote switch
  and time-off entries are still saved; overtime and evening hours need to be switched on again).
- A small number of grandfathered accounts have unlimited limits (the owner's own company and one partner account). Never grant or promise this to a customer.
- Counts (employees, sites, companies, admins) are enforced in the app; extra seats are $4.90 each.
- **Refunds: none (owner decision, 2026-11-12; Terms of Service section 4).** Every payment is final, including the
  first one and a plan cancelled an hour after paying: customers had the free 14-day preview to evaluate. Answer a
  refund request politely: no refund, as stated in the Terms; cancelling stops any further charge; they keep the paid
  plan until the end of the period already paid; the account then returns to the Free plan with nothing deleted.
  Never promise, hint at or process a refund or credit, and never say "exceptionally". If the customer insists,
  disputes the charge or mentions a chargeback, escalate to the owner and send only a holding reply.

## "I paid but it still says Free" (new customer, 2026-11-23)

Symptom: the customer paid (they have the Stripe receipt), but the header still shows "Free" under their name, and "Add Scheduling" sends them back to the "Upgrade Your Plan" list.

Cause: the plan was right on the server. The browser kept the plan it saved on the day that device signed in ("Remember me" keeps a sign-in for 30 days). A payment made from another device or browser, or a plan we changed for them, never reached that saved copy.

- Fixed on 2026-11-23: every time the page loads it now re-reads the plan and extra seats from the server. A refresh of the page is enough.
- If it still shows the old plan after a refresh: sign out and sign in again (this always worked, also before the fix).
- Never tell a customer in this situation to pay again. First confirm the plan in the database (the owner's row: plan, subscription present). If the database also says Free and they have a receipt, that is a billing matter for the owner: escalate.
- On Starter, the plan and the Scheduling add-on are two separate purchases: Starter alone does not open the Schedule
  tab. Growth and Business include Scheduling (from 2026-11-26), so there is nothing extra to buy there.

## Referral program, December 2026 ("Refer a business")

- **Dates.** The offer starts on 1 December 2026. Before that date do not bring it up; if a customer asks, say a
  referral offer for new accounts runs from 1 to 31 December and that the conditions are in the Terms (section 4.1).
- **The offer.** A new account created from 1 to 31 December 2026 (Toronto time) that enters another account's
  referral code gets 10% off its first paid month (Starter, Growth or Business; not add-ons; not combinable with
  another promo code). The referrer gets a $19.49 credit per referred account (the price of a month of Starter,
  whatever their own plan): $9.75 when the referred account pays its first month, $9.74 when it pays its second.
  At most 10 referred accounts earn a referrer credit ($194.90); an 11th referred account still gets its 10%.
- **Where.** Profile menu, **Refer a business**: the code, Copy code, Copy sign-up link, the counts and the credit.
  Owners and co-admins see it; managers do not. New accounts type the code in the optional "Referral code" field of
  the sign-up form, or later in the same panel ("Did another business refer you?") until their first payment.
- **How the referrer is paid.** A credit on their account, taken off their next invoice automatically. Nothing to
  claim, no payout, no cash value. A referrer on Free keeps the credit until they move to a paid plan, for at most
  12 months from when it was earned; the panel shows it as "Credit waiting for your upgrade" with the expiry date.
  Credits already applied to the account never expire.
- **Emails.** The referrer gets an email (English then French) each time a half is earned: "added to your account",
  or for a Free referrer "kept for you until <date>". The email never names the business they referred. The owner
  gets his own copy of every credit.
- **"I referred someone and got nothing."** Check in this order: did the new account type the code (the panel of the
  NEW account says "You joined with a referral code")? Has it paid yet (a Free account or one still in its 14-day
  preview has paid nothing)? Was it created between 1 and 31 December? Only half arrives after the first month; the
  other half comes after the second.
- **"My code was refused."** Reasons the screen gives: not a valid code; your own code; a code from someone in your
  own organisation (same email domain); the account already has a code; the account has already paid; the account
  was created outside December 2026; only the owner can add it. None of these can be overridden.
- **Does not count:** the same payment card on both accounts, a $0 invoice, an add-on bought alone, a first payment
  more than 90 days after sign-up, a second payment more than 75 days after the first. If the referred account
  cancels before paying a second month, the second half is never earned.
- **Never** promise a credit, add one by hand, extend the dates, or apply the discount after a payment: escalate to
  the owner with both account emails. The no-refund rule is unchanged: a referral credit is not a refund.
- After 31 December new codes are refused, but referrals already recorded keep earning, and the panel stays in the
  menu until the end of April 2027.

## Features and how to explain them

Work labels (part of Scheduling: included in Growth and Business, the $14.95/month add-on on Starter). Customers define their own labels (a task,
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
- Employee portal (phone clock-in, since 2026-10-31): with the same "Work labels at clock-in" setting, an
  employee who taps Clock In sees "What are you working on?" with the company's active labels (Skip only
  when the setting is "Ask but allow skipping"; Cancel records nothing). The label is saved on the IN only; a
  clock-out never asks. It needs Scheduling (Growth and up, or the add-on or its trial on Starter), like the kiosk. If it lapses the
  picker disappears and punches carry no label. If the list does not appear: check the setting, that the
  company has active labels, and the plan or add-on. Server messages: "That job is no longer available" (label
  deleted or deactivated since the page loaded) and "Please choose what you are working on" (Required).
  Requested by a consulting customer whose technicians move between client jobs.
- A label is not the employee's Department. Department says who a person is; a label says what a
  shift or stretch of work is for.
- The Scheduling trial is 14 days and self-serve (from 2026-10-28): Schedule tab, "Try it free for 14 days"
  (owner only, once per account, no card; Free and Starter. Growth and up include Scheduling and are not offered
  the trial, so it stays unused should they move down to Starter). It is only an end date on the owner's account
  (`admins.scheduling_trial_ends_at`, set by secure-db `start_scheduling_trial`); `scheduling_addon` stays true only
  for a paying account, so nothing has to be switched off and trials never count as revenue. While it runs the
  Schedule tab, work labels (admin and kiosk) and the employee portal's team schedule are open; a banner shows the
  days left and a "Keep it" button. After it, the Schedule tab shows the sample week and says the trial ended.
  To give someone a second trial by hand, set the end date back to null (or in the future) on their owner row.

Evening hours (added 2026-10-22, all plans). For customers who pay an evening/night premium.
- Setup: Settings, Pay and hours tab, "Evening Hours": tick "Report evening hours separately", then From
  (default 17:00), Until (empty = end of day) and the weekdays. The window cannot cross midnight (a shift
  running past midnight counts the part before midnight; the part after is judged against the next day).
- Result: Reports on screen, Excel, CSV and PDF get an "Evening Hrs" column (per punch, per employee
  total, per site total) and a stat card. Regular and overtime hours do NOT change, and punch rounding is
  applied the same way as the hour totals. Not in the employee portal or the emailed period summaries.
- It does not price the premium: we store no wages, so customers apply their own rate to the hours.

Calendar sync, "Add my shifts to my calendar" (added 2026-11-14; needs Scheduling, which is included in Growth and
Business or the add-on or its trial on Starter, plus the employee portal). In the employee portal, My Schedule, the employee presses "Get my calendar link" and
adds it once to Google Calendar, Apple Calendar or Outlook. Their own shifts then show there: time, work label,
site name and the note. Nothing else is in the calendar, and nobody else's shifts.
- It is a private link per employee, read-only. It is shown once, when it is made. To add it to a second
  calendar the employee presses "Get a new link"; the old one stops working at once, so the first calendar
  needs the new link too. Up to 5 new links an hour.
- **"I changed a shift and the calendar still shows the old one."** Normal. Calendar apps re-read a link on their
  own timetable and we cannot hurry them: Google Calendar about once or twice a day, Apple and Outlook usually
  within a few hours. The portal and the emailed schedule are always current. Do not promise same-day updates.
- **"Add to Google Calendar" does nothing on a phone.** Google only adds a calendar by link on a computer
  (calendar.google.com, Other calendars, +, From URL). Once added there it shows in the phone app (if not, in
  the app: Settings, the calendar's name, turn Sync on).
- **The calendar stopped updating or went empty.** Check, in this order: the employee pressed "Get a new link" or
  "Turn off"; an admin cancelled it (employee dialog, "Calendar link: on ... Cancel link") or revoked portal
  access; the employee was made inactive; the Scheduling add-on or trial ended (Starter), or the account went back to
  Free. In the last case the same link works again when the plan is back; in the others the employee makes a
  new link.
- An owner, co-admin or the site's manager can see that a link exists and when a calendar last read it, and can
  cancel it. Nobody but the employee can see or create the link. If a link was shared by mistake: cancel it or
  have the employee get a new one.
- Not included: a company-wide calendar, co-workers' shifts, time off or holidays in the calendar, instant
  updates, and changing a shift from the calendar. Log requests for those in the deferred list.
- Gemini / Google Workspace AI: asked on 2026-11-13. Google does not let a Workspace account add its own
  connector today, so the answer is "not yet"; the Claude and ChatGPT connector is the one in progress.

Quebec statutory holidays (added 2026-10-22, part of Scheduling). Schedule, Holidays, "Add Quebec
statutory holidays": adds the 8 statutory holidays for the chosen year for all sites, skipping dates that
are already listed. Good Friday is used for the Easter holiday (employer may use Easter Monday: delete it
and add that date); Canada Day moves to 2 July when 1 July is a Sunday. Holidays are only a calendar flag
in the schedule. We do NOT calculate holiday pay (no wages stored).

Not available yet (say so plainly; see the deferred-requests memory): authorized-devices-only punching
(the terminal "revoke" button only hides a device), multi-factor sign-in for admins, offline punching on the
kiosk, payroll integrations such as ADP (exports only), leave balances, wages and premium amounts.

Other recent changes
- Homepage on a phone or a half-width window (since 2026-11-17): the section links, Employee Portal, **Admin Login**, the
  light/dark switch and Get Started Free are inside the menu button (three lines) at the top right of the header, below
  about 1,240 px. Customers who say "the login disappeared" just need to open that menu.
- Reports and Activity: Previous / Next / Current period buttons that step through pay periods.
- Schedule: "Clear week" for one employee; copy a shift to other employees; a company setting lets
  site managers see and schedule staff from all sites (off means only their own sites).
- Retention: records older than 18 months are archived monthly. Every company can always pull reports
  for the last 18 months. Older data is available on request. This is stated in the Terms
  and the Privacy Policy.
- Kiosk device list (site settings) shows IP, model and OS, which helps identify a tablet.
- Kiosks reload themselves when they detect stale data (fixes a past ghost clock-in issue).
- "How did you hear about us?" (sign-up form, optional, since 2026-11-07): together with the
  campaign tags of the link a visitor arrived with and the domain of the site that sent them, it is
  stored once on the new account (columns `admins.signup_*`) so we can see which channel brings
  customers. It is optional, has no effect on the account, cannot be edited afterwards, and is listed
  in the Privacy Policy (section 1). If someone asks: "It only tells us how you found us, so we know
  where to spend our time; you can leave it blank."

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
  looks up admins), which looks like "the reset email never arrives". Check this FIRST (a clinic customer's
  employee, Oct 16-20, took three rounds because it was missed). Since 2026-10-20 the admin
  sign-in card, its error message and its forgot-password page link to the employee portal.
- Employee wants a new password: in the portal, tap "Change password" at the bottom of the page (or the
  circle with their initial, top right); it needs the current password. If they forgot it, "Forgot your
  password?" on the portal sign-in page emails a 6-digit code (15 minutes). If that cannot work, ask the
  owner to set a temporary password (the procedure is in the owner's private notes, not here) and tell
  the employee to change it at once. Emails are matched case-insensitively. Portal account emails are
  stored in lowercase.

- "Nothing works: punches, login and reports all fail for everyone" with HTTP 402 "service restricted":
  that is the database provider's plan quota, not a bug. It happened once, on 2026-10-22 for about two and
  a half hours (Free plan over its data and function quota); the project is now on a paid plan and the
  kiosks were made about 95% lighter. Punches attempted during an outage were never recorded: ask the
  customer who was clocked in and out during that window and add the missing punches from Activity
  (Add punch). Check the provider's Billing > Usage page before anything else.

## Style of a good reply

State what happened in plain words, say what was fixed and for whom, say what changes from now on,
and give one concrete step the customer can take themselves, using the exact on-screen names (they
are in the app's French and English dictionaries). Do not blame the employee unless it was their action.

## Season and the customer's kind of business (owner's direction, 2026-11-19)

- Keep the time of year in mind in every reply. From late November to early January customers are hiring seasonal
  staff, adding shifts, closing for the holidays and doing year-end payroll: where it fits the question, mention the
  one feature that helps with that (adding employees within the plan limit, the Québec statutory holidays button in
  Scheduling, the period summary for the accountant). In the weeks of Christmas and New Year a short seasonal wish at
  the end of a reply is welcome ("Joyeuses fêtes" / "Happy holidays"). One line, never a sales pitch.
- Do not assume a tablet at a fixed place. Ask or read how the team works. For teams on the road (technicians,
  installers, home-care nurses and aides, cleaning crews, snow removal, delivery), lead with phone clock-in: each
  person clocks in from their own phone, with the location shown on each punch (Starter and up), set up in one window
  from Employees. For a shop, a restaurant or a clinic, lead with the tablet and PINs.
- Never announce a promotion, discount, referral offer or price change unless it is written in this playbook.
