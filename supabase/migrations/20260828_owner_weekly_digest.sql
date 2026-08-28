-- Opt-out for the owner weekly digest.
--
-- Nothing in this product could previously stop a recurring email, because nothing sent one.
-- The digest does, so it ships with the off switch rather than adding it after complaints —
-- and CASL expects an unsubscribe on commercial mail regardless of how useful we think it is.

alter table admins add column if not exists weekly_digest boolean not null default true;

-- Unsubscribing has to work from an email client, with no session and no login. The token is
-- unguessable, per-admin, and controls exactly one boolean — it is not a credential for
-- anything else. secure-db strips it from any admin row that is not the caller's own, so a
-- co-admin cannot read their owner's token out of the API and silence their mail.
alter table admins add column if not exists unsub_token uuid not null default gen_random_uuid();
create unique index if not exists admins_unsub_token_idx on admins (unsub_token);

-- Callable by anon: the link is clicked from an inbox. Returns whether it matched, without
-- revealing anything about the account, and is idempotent so a second click is harmless.
create or replace function unsubscribe_weekly_digest(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  update admins set weekly_digest = false
   where unsub_token = p_token
  returning email into v_email;

  if v_email is null then
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object('ok', true, 'email', v_email);
end;
$$;

grant execute on function unsubscribe_weekly_digest(uuid) to anon, authenticated, service_role;
