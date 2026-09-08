-- Configurable overtime thresholds per company.
--
-- Until now the daily (>8h) and weekly (>40h) overtime split in reports, and the matching
-- "Daily overtime reached" alert email, were hardcoded across every company. A customer
-- (Bronzage Soleil des Antilles, 2026-09-08) asked to remove the split entirely and just
-- accumulate hours, which the existing track_overtime toggle already does — but a few
-- companies want overtime tracked at a different threshold than the 8h/40h default (e.g.
-- Quebec's general 40h/week rule vs sectors with a higher standard workweek), not tracking
-- turned off altogether. These columns let each company pick its own thresholds instead of
-- only being able to flip tracking on/off.
alter table companies
  add column if not exists ot_daily_hours integer not null default 8,
  add column if not exists ot_weekly_hours integer not null default 40;
