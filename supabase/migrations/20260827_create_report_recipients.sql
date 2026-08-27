-- Who, besides the employees themselves, should automatically receive the hours summary when a
-- payroll period closes — typically an accountant or bookkeeper who needs the numbers to run
-- payroll, and who should NOT need a PunchClock login to get them.
--
-- site_id NULL means "every site in this company", which is the common case for a single-site
-- shop and for a company accountant who wants the whole picture in one email.
create table if not exists public.report_recipients (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  site_id     uuid references public.sites(id) on delete cascade,
  email       text not null,
  label       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.admins(id) on delete set null
);

-- One row per address per scope. COALESCE keeps the company-wide (site_id NULL) row distinct
-- from a per-site row for the same address, since a plain UNIQUE treats NULLs as never equal.
create unique index if not exists report_recipients_scope_email_uniq
  on public.report_recipients (company_id, coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(email));

create index if not exists report_recipients_company_idx on public.report_recipients (company_id);

-- Matches every other tenant table here: RLS on with no policies, so anon/authenticated get
-- nothing and all access goes through the secure-db edge function under the service role.
alter table public.report_recipients enable row level security;
