-- Referral program ("Refer a business"), December 2026 promotion. NOT APPLIED: needs the owner's go.
-- Design, open questions and the go-live order: docs/referral-program.md.
--
-- An account owner has a referral code. A new account created inside the promotion window may enter one code,
-- before its first payment. It gets 10% off its first paid month (a Stripe coupon, added by stripe-handler at
-- checkout). The referrer earns the reward (one month of Starter, 1949 cents) in two halves, as credits on their
-- Stripe customer balance: half 1 when the referred account pays its first month, half 2 when it pays its second.
--
-- Who may do what
--   * Browser roles (anon, authenticated): nothing on any of these tables, and no function. Pages reach them only
--     through three secure-db actions (referral_check, referral_apply, referral_info), which use the service key.
--     The tables are deliberately NOT in secure-db's APP_TABLES.
--   * service_role: the tables (secure-db and stripe-handler).
--
-- This migration alters nothing that exists. With referral_promotions.enabled = false (the seeded value) no code
-- is accepted and no discount is given, whatever is deployed.
--
-- Rollback:
--   drop table if exists public.referral_rewards, public.referrals, public.referral_codes, public.referral_promotions;

-- ── The promotion: its window, its amounts and its switch ────────────────────────────────────────────────────
create table public.referral_promotions (
  id                        text primary key check (id ~ '^[a-z0-9_-]{1,40}$'),
  enabled                   boolean not null default false,          -- the server-side switch
  starts_at                 timestamptz not null,                    -- accounts created from this instant...
  ends_at                   timestamptz not null,                    -- ...and before this one may use a code
  discount_percent          integer not null default 10 check (discount_percent between 1 and 100),  -- informative: the real discount is the Stripe coupon
  reward_cents              integer not null default 1949 check (reward_cents between 2 and 100000),
  currency                  text not null default 'cad' check (currency ~ '^[a-z]{3}$'),
  first_payment_days        integer not null default 90 check (first_payment_days between 1 and 730),   -- first paid month within N days of sign-up
  second_payment_min_days   integer not null default 25 check (second_payment_min_days between 0 and 365), -- a "second month" is at least N days after the first payment
  second_payment_max_days   integer not null default 75 check (second_payment_max_days between 1 and 730), -- and at most N days after it
  max_rewards_per_referrer  integer check (max_rewards_per_referrer is null or max_rewards_per_referrer > 0), -- null = no cap
  created_at                timestamptz not null default now(),
  check (ends_at > starts_at),
  check (second_payment_max_days > second_payment_min_days)
);

alter table public.referral_promotions enable row level security;   -- no policies: closed to every browser role
revoke all on public.referral_promotions from public, anon, authenticated;
grant select, insert, update, delete on public.referral_promotions to service_role;

-- 1 to 31 December 2026, Toronto time, at most 10 rewarded referrals per referrer (owner, 2026-11-19).
-- Seeded OFF: switching it on is a go-live step.
insert into public.referral_promotions (id, enabled, starts_at, ends_at, max_rewards_per_referrer)
values ('dec2026', false,
        timestamptz '2026-12-01 00:00:00 America/Toronto',
        timestamptz '2027-01-01 00:00:00 America/Toronto',
        10);

-- ── One code per account owner ───────────────────────────────────────────────────────────────────────────────
create table public.referral_codes (
  admin_id    uuid primary key references public.admins(id) on delete cascade,
  code        text not null unique check (code ~ '^[A-HJKMNP-Z2-9]{8}$'),   -- no 0/O/1/I/L: read aloud and typed without mistakes
  created_at  timestamptz not null default now()
);

alter table public.referral_codes enable row level security;
revoke all on public.referral_codes from public, anon, authenticated;
grant select, insert, update, delete on public.referral_codes to service_role;

-- ── One row per referred account ─────────────────────────────────────────────────────────────────────────────
create table public.referrals (
  id                  uuid primary key default gen_random_uuid(),
  promotion_id        text not null references public.referral_promotions(id),
  referrer_admin_id   uuid not null references public.admins(id) on delete cascade,
  referred_admin_id   uuid not null unique references public.admins(id) on delete cascade,   -- one code per new account, for ever
  code                text not null,
  status              text not null default 'pending' check (status in ('pending', 'first_paid', 'completed', 'void')),
  void_reason         text check (void_reason is null or void_reason ~ '^[a-z_]{1,40}$'),
  discount_used_at    timestamptz,          -- the checkout that carried the 10% coupon completed
  first_invoice_id    text,
  first_paid_at       timestamptz,
  second_invoice_id   text,
  second_paid_at      timestamptz,
  referred_cards      text[] not null default '{}',   -- Stripe card fingerprints of the referred account at its first payment (not card numbers)
  created_at          timestamptz not null default now(),
  check (referrer_admin_id <> referred_admin_id),
  check (status <> 'void' or void_reason is not null)
);
create index referrals_referrer_idx on public.referrals (referrer_admin_id);

alter table public.referrals enable row level security;
revoke all on public.referrals from public, anon, authenticated;
grant select, insert, update, delete on public.referrals to service_role;

-- ── One row per half of a reward ─────────────────────────────────────────────────────────────────────────────
-- unique (referral_id, half) is what makes a grant idempotent: the same payment can never create a second row.
create table public.referral_rewards (
  id                  uuid primary key default gen_random_uuid(),
  referral_id         uuid not null references public.referrals(id) on delete cascade,
  referrer_admin_id   uuid not null references public.admins(id) on delete cascade,
  half                smallint not null check (half in (1, 2)),
  amount_cents        integer not null check (amount_cents > 0),
  currency            text not null default 'cad' check (currency ~ '^[a-z]{3}$'),
  status              text not null default 'waiting' check (status in ('waiting', 'delivered', 'void')),
  void_reason         text check (void_reason is null or void_reason ~ '^[a-z_]{1,40}$'),
  stripe_txn_id       text,                 -- the customer balance transaction, once delivered
  earned_at           timestamptz not null default now(),
  delivered_at        timestamptz,
  unique (referral_id, half)
);
create index referral_rewards_referrer_idx on public.referral_rewards (referrer_admin_id, status);

alter table public.referral_rewards enable row level security;
revoke all on public.referral_rewards from public, anon, authenticated;
grant select, insert, update, delete on public.referral_rewards to service_role;

notify pgrst, 'reload schema';
