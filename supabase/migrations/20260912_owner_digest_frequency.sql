-- Admin-configurable delivery schedule for the owner recap email (send-owner-digest), replacing
-- its previously hardcoded "every Monday, rolling 7-day window, no time-of-day" cadence.
-- Per-company (not per-admin), matching every other behavior toggle in this app (track_overtime,
-- track_lunch_breaks, visitor_checkin_enabled, alerts_enabled) — a Growth+ admin with several
-- companies can put each on its own schedule. The existing admins.weekly_digest flag stays as
-- the one-click email-footer unsubscribe (kills all of that admin's companies' digests at once);
-- these columns control timing, not on/off.
alter table companies
  add column if not exists digest_frequency text not null default 'weekly'
    check (digest_frequency in ('daily','weekly','per_period','monthly')),
  add column if not exists digest_hour smallint not null default 8
    check (digest_hour between 0 and 23),
  add column if not exists digest_day_of_week smallint not null default 1
    check (digest_day_of_week between 0 and 6), -- 0=Sunday .. 6=Saturday, only used when frequency='weekly'
  add column if not exists digest_day_of_month smallint not null default 1
    check (digest_day_of_month between 1 and 28), -- capped at 28 to sidestep short-month edge cases
  add column if not exists digest_timezone text not null default 'America/Toronto',
  add column if not exists digest_last_sent_at timestamptz;
