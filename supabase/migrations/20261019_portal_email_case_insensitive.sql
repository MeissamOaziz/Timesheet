-- Employee portal login failed for any account whose email was stored with a capital letter.
-- portal_login compared `ep.email = lower(p_email)`: the typed address is lowercased but the stored
-- one was not, so "Kennedy@thrivemedical.ca" could never match "kennedy@thrivemedical.ca" and the
-- employee saw "invalid credentials or account not verified" with the right password
-- (Thrive Medical, 2026-10-19). The invite path stores the address exactly as the admin typed it.
--
-- Three layers, so it cannot come back:
--   1. lowercase what is already stored (checked: no two rows collide once lowercased),
--   2. a trigger keeps every future insert/update lowercase whatever the client sends,
--   3. both login functions compare lower() on both sides.

update public.employee_portal set email = lower(email) where email <> lower(email);

create or replace function public.employee_portal_lowercase_email()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(btrim(new.email));
  return new;
end;
$$;

drop trigger if exists employee_portal_lowercase_email on public.employee_portal;
create trigger employee_portal_lowercase_email
  before insert or update of email on public.employee_portal
  for each row execute function public.employee_portal_lowercase_email();

do $mig$
declare
  fn text;
  v_def text;
begin
  foreach fn in array array['portal_login', 'verify_employee_login'] loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = fn;
    if v_def is null then
      raise exception '% not found', fn;
    end if;
    if position('ep.email = lower(p_email)' in v_def) > 0 then
      execute replace(v_def, 'ep.email = lower(p_email)', 'lower(ep.email) = lower(p_email)');
    elsif position('lower(ep.email) = lower(p_email)' in v_def) = 0 then
      raise exception '% is not in the expected shape', fn;
    end if;
  end loop;
end
$mig$;
