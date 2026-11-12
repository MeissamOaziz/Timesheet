-- AI connector (Claude / ChatGPT), step 2: tables only. 2026-11-12.
--
-- What this adds
--   admins.ai_apps_enabled  the account owner's switch "Allow AI apps". FALSE for everyone, existing and new.
--                           Only the owner's row counts (co-admins and managers follow the owner's).
--   mcp_auth_codes          one-time sign-in codes (60 seconds), made after a person approves on the consent page.
--   mcp_grants              one row per connection: this person allowed Claude or ChatGPT to read.
--   mcp_tokens              the access and refresh tokens of a connection. HASHES ONLY (sha-256, hex).
--   mcp_calls               one row per tool call: which tool, how it ended, how many rows, how long. This is both
--                           the log and the rate-limit counter (insert first, then count). Never the question or
--                           the answer.
--   cron job purge-mcp-connector, daily: removes expired codes and tokens, old call rows and dead connections.
--
-- Rules these tables follow
--   * Closed: row level security on, no policies, no privilege for anon / authenticated / PUBLIC. Only the service
--     key (edge functions) reads or writes them.
--   * NOT added to secure-db's PROTECTED_TABLES / APP_TABLES on purpose: nothing in a browser or app may read or
--     write them through the table path (secure-db answers 403 for any table it does not list). The pages reach
--     them only through named secure-db actions added in a later step.
--   * A raw token or code can never be stored by mistake: the hash columns only accept 64 hex characters.
--   * Everything hangs off admins(id) with ON DELETE CASCADE, so deleting an account (dormant-account cleanup,
--     account erasure) removes its connections, tokens, codes and call rows with it.
--   * admins.ai_apps_enabled cannot be changed from an app: secure-db's SELF_ADMIN_FIELDS / CHILD_ADMIN_FIELDS
--     allowlists do not include it. A later step adds an owner-only action for it.
--
-- Nothing reads these tables yet, so nothing customers see or do changes.
--
-- ROLLBACK
--   select cron.unschedule('purge-mcp-connector');
--   drop table if exists public.mcp_calls, public.mcp_tokens, public.mcp_auth_codes, public.mcp_grants;
--   alter table public.admins drop column if exists ai_apps_enabled;

-- ---- 1. the owner's switch ----
alter table public.admins
  add column if not exists ai_apps_enabled boolean not null default false;

comment on column public.admins.ai_apps_enabled is
  'Account owner''s switch: may people on this account connect Claude or ChatGPT (read-only connector). Off by default. Only the owner''s row is read. Not writable through the secure-db table path.';

-- ---- 2. connections ----
create table if not exists public.mcp_grants (
  id             uuid primary key default gen_random_uuid(),
  admin_id       uuid not null references public.admins(id) on delete cascade,
  client         text not null,
  scope          text not null default 'punchclock.read',
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  revoked_reason text,
  constraint mcp_grants_client_check check (client in ('claude', 'chatgpt')),
  constraint mcp_grants_scope_check check (scope in ('punchclock.read')),
  constraint mcp_grants_reason_check check (revoked_reason is null or revoked_reason in
    ('user', 'owner', 'password_change', 'deactivated', 'ai_apps_off', 'token_reuse', 'support')),
  constraint mcp_grants_revoked_pair check ((revoked_at is null) = (revoked_reason is null))
);
create index if not exists mcp_grants_admin_id_idx on public.mcp_grants (admin_id);

comment on table public.mcp_grants is
  'AI connector: one row per connection (a person allowed Claude or ChatGPT to read their PunchClock data). What the person may see is NOT stored here: role, sites, plan and the owner''s switch are checked live on every call. Private: service key only.';

-- ---- 3. tokens (hashes only) ----
create table if not exists public.mcp_tokens (
  token_hash text primary key,
  grant_id   uuid not null references public.mcp_grants(id) on delete cascade,
  kind       text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz,
  constraint mcp_tokens_hash_shape check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint mcp_tokens_kind_check check (kind in ('access', 'refresh')),
  constraint mcp_tokens_used_only_refresh check (used_at is null or kind = 'refresh')
);
create index if not exists mcp_tokens_grant_id_idx on public.mcp_tokens (grant_id);
create index if not exists mcp_tokens_expires_at_idx on public.mcp_tokens (expires_at);

comment on table public.mcp_tokens is
  'AI connector: sha-256 hashes of access and refresh tokens. The tokens themselves exist only at Claude / ChatGPT. used_at marks a refresh token that was exchanged for a new one; seeing it again later means theft. Private: service key only.';

-- ---- 4. one-time sign-in codes (hashes only) ----
create table if not exists public.mcp_auth_codes (
  code_hash      text primary key,
  admin_id       uuid not null references public.admins(id) on delete cascade,
  client         text not null,
  redirect_uri   text not null,
  code_challenge text not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  used_at        timestamptz,
  constraint mcp_auth_codes_hash_shape check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint mcp_auth_codes_client_check check (client in ('claude', 'chatgpt')),
  constraint mcp_auth_codes_redirect_len check (length(redirect_uri) between 1 and 400),
  constraint mcp_auth_codes_challenge_shape check (code_challenge ~ '^[A-Za-z0-9_-]{43}$')
);
create index if not exists mcp_auth_codes_admin_id_idx on public.mcp_auth_codes (admin_id);
create index if not exists mcp_auth_codes_expires_at_idx on public.mcp_auth_codes (expires_at);

comment on table public.mcp_auth_codes is
  'AI connector: sha-256 hashes of one-time sign-in codes, bound to the person who approved, the app, its callback address and its PKCE challenge. Single use: redeemed with UPDATE ... WHERE used_at IS NULL. Private: service key only.';

-- ---- 5. tool calls: the log and the rate-limit counter ----
create table if not exists public.mcp_calls (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  grant_id       uuid not null references public.mcp_grants(id) on delete cascade,
  owner_admin_id uuid not null references public.admins(id) on delete cascade,
  tool           text not null,
  outcome        text not null,
  row_count      integer,
  ms             integer,
  constraint mcp_calls_tool_shape check (tool ~ '^[a-z_]{1,60}$'),
  constraint mcp_calls_outcome_check check (outcome in ('ok', 'rate_limited', 'plan_locked', 'refused', 'error'))
);
create index if not exists mcp_calls_grant_at_idx on public.mcp_calls (grant_id, at desc);
create index if not exists mcp_calls_owner_at_idx on public.mcp_calls (owner_admin_id, at desc);
create index if not exists mcp_calls_at_idx on public.mcp_calls (at);

comment on table public.mcp_calls is
  'AI connector: one row per tool call (tool name, outcome, row count, duration). Counted for rate limits. Holds no question text, no answer and no employee data. Kept 90 days. Private: service key only.';

-- ---- 6. lock all four ----
alter table public.mcp_grants     enable row level security;
alter table public.mcp_tokens     enable row level security;
alter table public.mcp_auth_codes enable row level security;
alter table public.mcp_calls      enable row level security;

revoke all on public.mcp_grants, public.mcp_tokens, public.mcp_auth_codes, public.mcp_calls from public, anon, authenticated;
grant select, insert, update, delete on public.mcp_grants, public.mcp_tokens, public.mcp_auth_codes, public.mcp_calls to service_role;

revoke all on sequence public.mcp_calls_id_seq from public, anon, authenticated;
grant usage, select on sequence public.mcp_calls_id_seq to service_role;

-- ---- 7. daily clean-up (touches only the tables above) ----
select cron.unschedule('purge-mcp-connector') where exists (select 1 from cron.job where jobname = 'purge-mcp-connector');

select cron.schedule(
  'purge-mcp-connector',
  '50 3 * * *',
  $job$
    delete from public.mcp_auth_codes where expires_at < now() - interval '1 day';
    delete from public.mcp_tokens     where expires_at < now() - interval '7 days';
    delete from public.mcp_calls      where at < now() - interval '90 days';
    delete from public.mcp_grants g
     where (g.revoked_at is not null and g.revoked_at < now() - interval '90 days')
        or (g.created_at < now() - interval '31 days'
            and not exists (select 1 from public.mcp_tokens t where t.grant_id = g.id and t.expires_at > now()));
  $job$
);
