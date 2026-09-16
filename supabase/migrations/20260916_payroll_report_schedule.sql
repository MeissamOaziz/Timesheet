-- Admin-configurable delivery timing for the payroll closing report (send-period-summary): today
-- it fires immediately on the day the period boundary lands, with no room for a manager's
-- Monday-morning corrections before the accountant gets numbers. delay_days lets an admin push
-- delivery back up to a week (e.g. period closes Saturday, delay 3 days -> sent Tuesday) at a
-- chosen local hour. Reuses companies.digest_timezone (added for the now-retired owner-digest
-- feature) as the one per-company timezone field, rather than adding a duplicate column.
alter table companies
  add column if not exists payroll_report_delay_days smallint not null default 0
    check (payroll_report_delay_days between 0 and 6),
  add column if not exists payroll_report_hour smallint not null default 8
    check (payroll_report_hour between 0 and 23),
  add column if not exists payroll_report_last_sent_end date;
