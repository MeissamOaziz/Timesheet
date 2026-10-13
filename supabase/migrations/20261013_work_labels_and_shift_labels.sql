-- Work labels: company-defined names (a task, a job, a project...) that a shift can be scheduled
-- under, and later that a punch can be recorded under. Deliberately generic so a business decides
-- what a label means. Distinct from employees.dept, which says who a person is, one value each.
create table public.work_labels (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  color text not null default '#4f8ef7' check (color ~ '^#[0-9a-fA-F]{6}$'),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
-- One label name per company, ignoring case, so "Snow removal" and "snow removal" can't both exist.
create unique index work_labels_company_name_uidx on public.work_labels (company_id, lower(btrim(name)));
create index work_labels_company_idx on public.work_labels (company_id, active, sort_order);

-- Same posture as every other table here: RLS on with no policies denies the public anon key
-- entirely; the app reaches this table only through secure-db (service role).
alter table public.work_labels enable row level security;

-- A shift can carry a label. Deleting a label keeps the shifts (they just lose the tag).
alter table public.shifts add column label_id uuid references public.work_labels(id) on delete set null;
create index shifts_label_idx on public.shifts (label_id) where label_id is not null;
