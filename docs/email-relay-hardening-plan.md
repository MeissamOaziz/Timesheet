# Closing the open email relay (scoped 2026-10-19, not started)

## The problem
`send-verification` has JWT verification off and checks nothing about its caller. The public anon key
(visible in `index.html`) is enough to make it send an email from `noreply@punchclock.ca` to any
address, and the caller chooses the name, the code and, for invite types, the button link. Possible
harm: phishing from our own domain, and spam that damages the domain's reputation or gets the Resend
account suspended, which would also stop real reset codes and schedule emails.

Not affected the same way: `send-support-reply` needs a secret. `send-contact` is public by design
(the contact form), but its acknowledgement goes to whatever address is typed, with fixed text and a
visitor-chosen name. Lower risk; add rate limiting later (see step 6).

## Who calls it today
Server to server, with the service key (already fine): password reset for admins, password reset for
portal employees, registration code (three calls in `secure-db`).

From the browser with the anon key (these are the ones to move):

| Email | Where in `index.html` | Signed-in sender? |
|---|---|---|
| Manager / co-admin invitation (`invitation`) | three places (~9468, 9547, 9734) | admin |
| Join request approved / denied | ~10286, ~10323 | admin |
| Employee portal invitation (`employee_invite`) | ~10758 | admin |
| Schedule email (`schedule`) | `sendScheduleEmailCore` | admin |
| New account notice to the owner | ~7061 | right after sign-up |

Dead code in the function (no caller found): `join_request`, `co_admin_invite`,
`co_admin_invite_v2`, `co_admin_invite_accepted`. Remove them.

## Design
Every email is tied to a real database row, so holding the anon key (or even an admin session) cannot
send arbitrary mail.

1. **New `secure-db` action `send_email`**, requires a valid admin session. Per type, the server
   checks the recipient against the database and builds any link itself:
   - schedule: recipient is an employee of the caller's company with that email; shift list capped.
   - employee_invite: recipient and token come from the caller's `employee_portal` row (status
     invited); the server builds the portal URL.
   - invitation: recipient and token match a pending invitation created by the caller.
   - join approved / denied: recipient is the requester on a join request for the caller's company.
2. **Sign-up notice to the owner** moves into the server-side registration step (it only goes to us).
3. **HTML-escape every interpolated field** in the templates (names, company, notes, labels,
   weekLabel). Today raw text is placed in the HTML, so an employee name or a shift note containing
   markup lands in the email as markup.
4. **Lock `send-verification`:** require `Authorization: Bearer <service key>` and reject everything
   else with 401 (constant-time compare against the env service key). Remove the dead types.
5. **Dry-run mode:** when called with the service key and `x-dry-run: 1`, build and return the email
   without sending. This is how to test templates and routing, because test sends are not allowed.
6. **Rate limit** per admin and per hour on `send_email` (small counter table, row level security on,
   no policies, run the security advisor after). Later: the same for the `send-contact` auto-reply.

## Rollout order (so nothing breaks for live customers)
1. Deploy `secure-db` with `send_email` (nothing calls it yet).
2. Ship the `index.html` change that uses it; wait for the Pages deploy. Old tabs and the service
   worker cache refresh themselves on reload, but allow a few days.
3. Confirm there are no more anon-key calls to `send-verification` (Resend sent list shows the
   senders; add a log line for rejected calls first).
4. Deploy the locked `send-verification`.

## Tests (no real emails)
- Anon key to `send-verification`: 401 after step 4, and 200 before it (proves the gap and the fix).
- `send_email` with no session, wrong tenant, wrong recipient, wrong type: all refused.
- Dry run of each type: output renders, escapes hostile input, link host is `punchclock.ca`.
- Existing flows on a demo company: invite, schedule, join approve/deny render correctly (dry run).

## Effort and risk
About one focused day. The risk is breaking invites or schedule emails for paying customers, which
the rollout order and dry run address. Do not do this during a customer's payroll morning.
