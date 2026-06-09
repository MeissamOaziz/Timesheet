-- Idempotency table for Stripe webhook events
-- Prevents duplicate processing when Stripe retries delivery
create table if not exists public.processed_webhook_events (
  id           text primary key,          -- Stripe event ID (e.g. evt_1abc...)
  processed_at timestamptz not null default now()
);

-- Index on processed_at for cleanup queries
create index if not exists idx_processed_webhook_events_processed_at
  on public.processed_webhook_events (processed_at);

-- Allow the service role to read/write (edge functions use service role key)
alter table public.processed_webhook_events enable row level security;

create policy "Service role full access"
  on public.processed_webhook_events
  for all
  using (true)
  with check (true);

-- Optional: auto-cleanup events older than 30 days to keep the table small.
-- Run this as a Supabase cron job (pg_cron) or manually:
--   delete from public.processed_webhook_events
--   where processed_at < now() - interval '30 days';
