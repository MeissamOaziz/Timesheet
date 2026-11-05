-- Rolled-back simulation for supabase/migrations/20261105_admin_push_tokens.sql
--
-- Run it AFTER the migration is applied (SQL editor or execute_sql), as the postgres role. It creates throw-away
-- admins and sessions inside one DO block, exercises admin_register_push_token / admin_unregister_push_token,
-- and always ends with RAISE EXCEPTION, so nothing persists. Success is the exception text starting with
-- 'SIM OK (rolled back)'; any failed assertion raises 'SIM FAILED: ...' instead. Nothing is printed except
-- pass/fail lines and counts (no session tokens, no push tokens).
--
-- STATUS: run 2026-11-05 after the migration was applied: SIM OK (rolled back), every case passed.
--
-- Not covered here (an anon-role check, not a function-logic check): that the anon key can execute the two RPCs
-- and cannot select from admin_push_tokens. See the harmless probes in docs/admin-push-notes.md.

do $sim$
declare
  v_log   text := '';
  v_a     uuid;
  v_b     uuid;
  v_sus   uuid;
  v_sa    text;   -- admin A valid session
  v_sb    text;   -- admin B valid session
  v_sexp  text;   -- expired session (admin A)
  v_ssus  text;   -- session of a suspended admin
  v_t1    text;
  v_t2    text;
  v_first text;
  v_last  text;
  v_n     integer;
  v_ok    boolean;
  v_lbl   text;
  v_tok   text;
  i       integer;
begin
  -- ---- fixtures: three throw-away admins and their sessions ----
  insert into admins (name, email, password, verified, role, status)
  values ('Sim A', 'sim-a-' || gen_random_uuid() || '@example.invalid', 'x', true, 'admin', 'active') returning id into v_a;
  insert into admins (name, email, password, verified, role, status)
  values ('Sim B', 'sim-b-' || gen_random_uuid() || '@example.invalid', 'x', true, 'manager', 'active') returning id into v_b;
  insert into admins (name, email, password, verified, role, status)
  values ('Sim S', 'sim-s-' || gen_random_uuid() || '@example.invalid', 'x', true, 'admin', 'suspended') returning id into v_sus;

  v_sa   := encode(extensions.gen_random_bytes(32), 'hex');
  v_sb   := encode(extensions.gen_random_bytes(32), 'hex');
  v_sexp := encode(extensions.gen_random_bytes(32), 'hex');
  v_ssus := encode(extensions.gen_random_bytes(32), 'hex');
  insert into admin_sessions (token, admin_id, expires_at) values (v_sa,   v_a,   now() + interval '1 day');
  insert into admin_sessions (token, admin_id, expires_at) values (v_sb,   v_b,   now() + interval '1 day');
  insert into admin_sessions (token, admin_id, expires_at) values (v_sexp, v_a,   now() - interval '1 minute');
  insert into admin_sessions (token, admin_id, expires_at) values (v_ssus, v_sus, now() + interval '1 day');

  v_t1 := 'ExponentPushToken[' || substr(md5(random()::text || clock_timestamp()::text), 1, 22) || ']';
  v_t2 := 'ExpoPushToken['     || substr(md5(random()::text || clock_timestamp()::text), 1, 22) || ']';

  -- ---- 1. valid registration (both accepted token spellings) ----
  v_ok := public.admin_register_push_token(v_sa, v_t1, 'ios', 'Meissam''s iPhone');
  if v_ok is distinct from true then raise exception 'SIM FAILED: valid register returned %', v_ok; end if;
  select count(*) into v_n from admin_push_tokens where token = v_t1 and admin_id = v_a and platform = 'ios';
  if v_n <> 1 then raise exception 'SIM FAILED: valid register did not store the row for admin A'; end if;
  v_ok := public.admin_register_push_token(v_sa, v_t2, 'android', null);
  if v_ok is distinct from true then raise exception 'SIM FAILED: ExpoPushToken[...] spelling refused'; end if;
  v_log := v_log || 'valid register ok; ';

  -- ---- 2. refresh keeps one row ----
  v_ok := public.admin_register_push_token(v_sa, v_t1, 'ios', 'Renamed');
  select count(*) into v_n from admin_push_tokens where token = v_t1;
  if v_ok is distinct from true or v_n <> 1 then raise exception 'SIM FAILED: re-register duplicated or failed (n=%)', v_n; end if;
  select device_label into v_lbl from admin_push_tokens where token = v_t1;
  if v_lbl is distinct from 'Renamed' then raise exception 'SIM FAILED: label not refreshed'; end if;
  v_log := v_log || 're-register ok; ';

  -- ---- 3. invalid token shapes are refused and store nothing ----
  select count(*) into v_n from admin_push_tokens where admin_id = v_a;   -- baseline: 2
  foreach v_tok in array array[
    '', 'abc', 'ExponentPushToken[short]', 'ExponentPushToken[]', 'PushToken[abcdefghijklmnop]',
    'ExponentPushToken[abcdefghijklmnop', 'ExponentPushToken[abcdefghij klmnop]',
    'ExponentPushToken[abcdefghijklmnop];drop table admins', E'ExponentPushToken[abcdefghijklmnop]\n',
    'ExponentPushToken[' || repeat('a', 81) || ']', repeat('x', 500)
  ] loop
    v_ok := public.admin_register_push_token(v_sa, v_tok, 'ios', 'x');
    if v_ok is distinct from false then raise exception 'SIM FAILED: invalid token accepted: %', left(v_tok, 30); end if;
  end loop;
  if public.admin_register_push_token(v_sa, null, 'ios', 'x') is distinct from false then
    raise exception 'SIM FAILED: NULL token accepted'; end if;
  select count(*) into i from admin_push_tokens where admin_id = v_a;
  if i <> v_n then raise exception 'SIM FAILED: an invalid token changed the table (% -> %)', v_n, i; end if;
  v_log := v_log || 'invalid tokens refused; ';

  -- ---- 4. invalid platform ----
  foreach v_tok in array array['web', 'IOS', '', 'windows'] loop
    if public.admin_register_push_token(v_sa, v_t1, v_tok, 'x') is distinct from false then
      raise exception 'SIM FAILED: platform % accepted', v_tok; end if;
  end loop;
  if public.admin_register_push_token(v_sa, v_t1, null, 'x') is distinct from false then
    raise exception 'SIM FAILED: NULL platform accepted'; end if;
  v_log := v_log || 'platforms checked; ';

  -- ---- 5. bad sessions: NULL, empty, malformed, unknown, expired, suspended admin ----
  foreach v_tok in array array['', ' ', 'short', 'not a token!', repeat('a', 64), repeat('A', 200)] loop
    if public.admin_register_push_token(v_tok, v_t1, 'ios', 'x') is distinct from false then
      raise exception 'SIM FAILED: junk session accepted (%)', left(v_tok, 12); end if;
  end loop;
  if public.admin_register_push_token(null, v_t1, 'ios', 'x') is distinct from false then
    raise exception 'SIM FAILED: NULL session accepted'; end if;
  if public.admin_register_push_token(v_sexp, 'ExponentPushToken[expiredsession0001]', 'ios', 'x') is distinct from false then
    raise exception 'SIM FAILED: expired session accepted'; end if;
  if public.admin_register_push_token(v_ssus, 'ExponentPushToken[suspendedadmin0001]', 'ios', 'x') is distinct from false then
    raise exception 'SIM FAILED: suspended admin accepted'; end if;
  select count(*) into v_n from admin_push_tokens where token in ('ExponentPushToken[expiredsession0001]', 'ExponentPushToken[suspendedadmin0001]');
  if v_n <> 0 then raise exception 'SIM FAILED: a refused registration left a row'; end if;
  -- an admin whose own account has expired is refused too
  update admins set expires_at = now() - interval '1 day' where id = v_b;
  if public.admin_register_push_token(v_sb, 'ExponentPushToken[expiredaccount0001]', 'ios', 'x') is distinct from false then
    raise exception 'SIM FAILED: expired admin account accepted'; end if;
  update admins set expires_at = null where id = v_b;
  v_log := v_log || 'bad sessions refused; ';

  -- ---- 6. label sanitising ----
  v_ok := public.admin_register_push_token(v_sa, v_t2, 'android', E'<b>Evil</b>\t\n phone ' || repeat('z', 100));
  select device_label into v_lbl from admin_push_tokens where token = v_t2;
  if v_ok is distinct from true or v_lbl is null or length(v_lbl) > 60 or v_lbl ~ '[<>[:cntrl:]]' then
    raise exception 'SIM FAILED: label not sanitised (len=%)', length(coalesce(v_lbl, '')); end if;
  v_ok := public.admin_register_push_token(v_sa, v_t2, 'android', E'  \t ');
  select device_label into v_lbl from admin_push_tokens where token = v_t2;
  if v_lbl is not null then raise exception 'SIM FAILED: blank label not stored as NULL'; end if;
  v_log := v_log || 'label sanitised; ';

  -- ---- 7. last signer owns the token (shared phone) ----
  v_ok := public.admin_register_push_token(v_sb, v_t1, 'ios', 'B on the same phone');
  if v_ok is distinct from true then raise exception 'SIM FAILED: takeover refused'; end if;
  select count(*) into v_n from admin_push_tokens where token = v_t1 and admin_id = v_b;
  if v_n <> 1 then raise exception 'SIM FAILED: token not owned by B after takeover'; end if;
  select count(*) into v_n from admin_push_tokens where token = v_t1;
  if v_n <> 1 then raise exception 'SIM FAILED: token present % times after takeover', v_n; end if;
  -- A can no longer remove it (it is B's row now); B can.
  if public.admin_unregister_push_token(v_sa, v_t1) is distinct from false then
    raise exception 'SIM FAILED: A unregistered a token that now belongs to B'; end if;
  select count(*) into v_n from admin_push_tokens where token = v_t1 and admin_id = v_b;
  if v_n <> 1 then raise exception 'SIM FAILED: A removed B''s row'; end if;
  v_log := v_log || 'takeover ok; ';

  -- ---- 8. unregister ----
  if public.admin_unregister_push_token(v_sb, v_t1) is distinct from true then
    raise exception 'SIM FAILED: owner could not unregister'; end if;
  select count(*) into v_n from admin_push_tokens where token = v_t1;
  if v_n <> 0 then raise exception 'SIM FAILED: row still there after unregister'; end if;
  if public.admin_unregister_push_token(v_sb, v_t1) is distinct from false then
    raise exception 'SIM FAILED: second unregister returned true'; end if;
  if public.admin_unregister_push_token(null, v_t2) is distinct from false
     or public.admin_unregister_push_token(v_sa, null) is distinct from false
     or public.admin_unregister_push_token('', v_t2) is distinct from false
     or public.admin_unregister_push_token(v_sexp, v_t2) is distinct from false then
    raise exception 'SIM FAILED: unregister accepted NULL/empty/expired input'; end if;
  select count(*) into v_n from admin_push_tokens where token = v_t2 and admin_id = v_a;
  if v_n <> 1 then raise exception 'SIM FAILED: a refused unregister removed A''s row'; end if;
  v_log := v_log || 'unregister ok; ';

  -- ---- 9. cap: 11th device keeps 10, drops the oldest ----
  delete from admin_push_tokens where admin_id = v_a;
  for i in 1..11 loop
    v_tok := 'ExponentPushToken[simcap' || lpad(i::text, 10, '0') || ']';
    if i = 1 then v_first := v_tok; end if;
    v_last := v_tok;
    if public.admin_register_push_token(v_sa, v_tok, 'ios', 'cap ' || i) is distinct from true then
      raise exception 'SIM FAILED: cap registration % refused', i; end if;
  end loop;
  select count(*) into v_n from admin_push_tokens where admin_id = v_a;
  if v_n <> 10 then raise exception 'SIM FAILED: admin holds % tokens after 11 registrations (want 10)', v_n; end if;
  select count(*) into v_n from admin_push_tokens where token = v_first;
  if v_n <> 0 then raise exception 'SIM FAILED: oldest token was not dropped'; end if;
  select count(*) into v_n from admin_push_tokens where token = v_last and admin_id = v_a;
  if v_n <> 1 then raise exception 'SIM FAILED: newest token missing'; end if;
  -- the cap is per admin: B is unaffected
  select count(*) into v_n from admin_push_tokens where admin_id = v_b;
  if v_n <> 0 then raise exception 'SIM FAILED: cap touched another admin (% rows for B)', v_n; end if;
  v_log := v_log || 'cap ok; ';

  -- ---- 10. deleting an admin cascades ----
  delete from admins where id = v_a;
  select count(*) into v_n from admin_push_tokens where token like 'ExponentPushToken[simcap%';
  if v_n <> 0 then raise exception 'SIM FAILED: tokens survived deleting their admin (%)', v_n; end if;
  v_log := v_log || 'cascade ok; ';

  -- Always roll back: nothing above persists.
  raise exception 'SIM OK (rolled back). %', v_log;
end
$sim$;
