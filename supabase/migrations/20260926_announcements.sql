-- Message centre: lets Meissam push product-update notices to every admin instead of emailing
-- each paying customer individually. A single global feed (not per-tenant) -- every admin sees
-- the same list, same as a changelog. Read-tracking reuses the admins table (last_seen_announcement_at)
-- instead of a second table, since "have I opened the panel since this was posted" is the only
-- state needed -- no per-item read/unread required.
create table announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);

alter table admins add column last_seen_announcement_at timestamptz;
