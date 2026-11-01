-- Read-only exposure snapshot used by tools/secure-db-regression/anon-exposure-check.mjs.
-- Reports (names only, never data): public relations that anon/authenticated/PUBLIC hold any privilege on, public tables
-- without RLS, public functions executable by anon / authenticated, default privileges that would hand future objects to
-- anon/authenticated/PUBLIC, SELECT policies on storage.objects, installed extensions.
-- service_role only (new-function rule in docs/new-table-checklist.md). SECURITY INVOKER: it reads catalogs only.
--
-- ROLLBACK:  drop function public.security_audit_snapshot();

create or replace function public.security_audit_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $fn$
  select jsonb_build_object(
    'relations_with_anon_authenticated_or_public_privileges', coalesce((
      select jsonb_agg(c.relname order by c.relname)
      from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p','f','S')
        and exists (
          select 1 from aclexplode(coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end, c.relowner))) a
          where a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated')))
    ), '[]'::jsonb),
    'tables_without_rls', coalesce((
      select jsonb_agg(c.relname order by c.relname)
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and not c.relrowsecurity
    ), '[]'::jsonb),
    'anon_executable_functions', coalesce((
      select jsonb_agg(distinct p.proname)
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and has_function_privilege('anon', p.oid, 'EXECUTE')
    ), '[]'::jsonb),
    'authenticated_executable_functions', coalesce((
      select jsonb_agg(distinct p.proname)
      from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ), '[]'::jsonb),
    'default_privileges_open_to_anon_authenticated_or_public', coalesce((
      select jsonb_agg(distinct pg_get_userbyid(d.defaclrole) || ':' || coalesce(n.nspname, '*') || ':' || d.defaclobjtype::text)
      from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) a
      where d.defaclrole = (select oid from pg_roles where rolname = 'postgres')
        and (n.nspname = 'public' or d.defaclnamespace = 0)
        and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated')))
    ), '[]'::jsonb),
    'storage_select_policies', coalesce((
      select jsonb_agg(policyname order by policyname) from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd in ('SELECT','ALL')
    ), '[]'::jsonb),
    'extensions', coalesce((select jsonb_agg(extname order by extname) from pg_extension), '[]'::jsonb)
  );
$fn$;

revoke all on function public.security_audit_snapshot() from public, anon, authenticated;
grant execute on function public.security_audit_snapshot() to service_role, postgres;
