-- Admin sign-up (verify_code_and_register) and accepting a co-admin/manager invitation (accept_invitation)
-- now need 8-character passwords, like reset, portal and admin-created accounts (were 6).
-- Only the length check changes: each function's live definition is re-created with that one line replaced,
-- and the block aborts unless the line is found exactly once. CREATE OR REPLACE keeps the grants.
do $$
declare
  r record; d text; n int;
begin
  for r in
    select p.oid, p.proname, x.old_line, x.new_line
      from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      join (values
        ('verify_code_and_register', 'p_newpass IS NULL OR length(p_newpass) < 6', 'p_newpass IS NULL OR length(p_newpass) < 8'),
        ('accept_invitation',        'p_pass IS NULL OR length(p_pass) < 6',       'p_pass IS NULL OR length(p_pass) < 8')
      ) as x(fn, old_line, new_line) on x.fn = p.proname
     where s.nspname = 'public'
  loop
    d := pg_get_functiondef(r.oid);
    n := (length(d) - length(replace(d, r.old_line, ''))) / length(r.old_line);
    if n <> 1 then raise exception '%: expected the 6-character check once, found % times', r.proname, n; end if;
    execute replace(d, r.old_line, r.new_line);
  end loop;
  if (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace
       where s.nspname = 'public' and p.proname in ('verify_code_and_register', 'accept_invitation')
         and pg_get_functiondef(p.oid) ~ 'length\(p_(newpass|pass)\) < 8') <> 2 then
    raise exception 'not both functions were updated';
  end if;
end $$;
