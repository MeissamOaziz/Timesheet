-- Evening hours: an optional per-company window (start time, optional end time, weekdays) used by the
-- admin Reports and exports to show the hours worked inside that window as their own column, for
-- evening / night premiums. It is informational only: regular and overtime totals do not change.
--   evening_start  'HH:MM'  null = feature off for the company
--   evening_end    'HH:MM'  null = until the end of the day
--   evening_days   weekday numbers, 0 = Sunday ... 6 = Saturday; null = every day
alter table public.companies
  add column if not exists evening_start text check (evening_start is null or evening_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column if not exists evening_end   text check (evening_end   is null or evening_end   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column if not exists evening_days  smallint[] check (evening_days is null or evening_days <@ array[0,1,2,3,4,5,6]::smallint[]);
