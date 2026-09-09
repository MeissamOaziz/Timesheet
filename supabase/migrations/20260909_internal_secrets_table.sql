-- Generic key/value store for internal machine-to-machine secrets (e.g. the shared secret
-- send-support-reply checks before sending mail from our verified domain on a caller's behalf).
-- Not exposed through secure-db, not queried by the client app — edge functions only, via the
-- service role key they already hold.
create table internal_secrets (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now()
);
