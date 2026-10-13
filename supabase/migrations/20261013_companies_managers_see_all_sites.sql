-- Schedule scoping for site managers. By default a manager only sees (and can schedule) staff at
-- the sites they manage, which is how Activity, Reports and Employees already behave. A business
-- whose locations share staff can switch this on to let managers see everyone in the company.
alter table public.companies
  add column if not exists managers_see_all_sites boolean not null default false;
