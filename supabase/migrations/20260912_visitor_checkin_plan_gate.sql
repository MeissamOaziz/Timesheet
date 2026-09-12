-- Visitor check-in becomes an admin-controlled per-company toggle (mirroring track_lunch_breaks)
-- so a Growth-plan-and-up gate has something to lock at the kiosk: the kiosk has no admin
-- session of its own to check a live plan against, so it trusts this cached company setting
-- instead, exactly like it already does for track_lunch_breaks. The app enforces that this can
-- only be turned on from the Growth plan and above (Meissam's 2026-09-12 pricing decision).
alter table companies
  add column if not exists visitor_checkin_enabled boolean not null default false;
