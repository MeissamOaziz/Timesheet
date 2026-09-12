-- Lunch/break tracking, off by default per company (same pattern as track_overtime) — a real
-- prospect (Lauren Ramos / Julia Natarelli, 2026-09-11 sales call) asked for a dedicated break
-- flow distinct from the existing "punch OUT for lunch, back IN after" workaround. The hours math
-- already excludes an OUT->IN gap from worked time either way; this is about giving that gap a
-- name — a distinct kiosk button and a visible marker on the punch, rather than an admin having to
-- infer "was this a lunch or did they actually leave" from the raw punch list.
alter table companies
  add column if not exists track_lunch_breaks boolean not null default false;

alter table punches
  add column if not exists is_break boolean not null default false;
