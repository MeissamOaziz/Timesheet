-- No policies defined on purpose: RLS enabled + zero policies means anon/authenticated get
-- zero rows via PostgREST, while service_role (what edge functions authenticate as) bypasses
-- RLS entirely by design. This is the only table in the project using RLS — every other table
-- is scoped by the secure-db edge function instead — because this one holds machine secrets
-- that must never be reachable through the public anon key baked into index.html.
alter table internal_secrets enable row level security;
