-- Per-admin email notification mutes (2026-09-12): an admin or manager who lives in the app
-- every day can turn off email channels individually, without touching what anyone else on the
-- same account/sites receives. Lives on `admins` (one row per login), not `companies` — muting
-- is personal, the same way `weekly_digest` already is.
--
-- track_overtime/alerts_enabled etc. on `companies` still control whether an alert condition is
-- even computed at all; these columns only control whether THIS person is in the recipient list
-- once it fires.
alter table admins
  add column if not exists mute_manager_alerts boolean not null default false,
  add column if not exists mute_approval_emails boolean not null default false;
