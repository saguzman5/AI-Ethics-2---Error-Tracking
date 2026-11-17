-- =====================================================================
-- Production Tracking & Error Reporting System - ONLINE VERSION
-- Supabase (PostgreSQL) setup script.
--
-- How to use: Supabase dashboard -> SQL Editor -> New query -> paste this
-- whole file -> Run. It is safe to run again (for example after an update).
--
-- What it creates: tables, integrity rules, a reporting view, row-level
-- security (who may see/change what), the functions the app calls, the
-- private "photos" storage bucket, and live-update (Realtime) settings.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique,
  full_name   text not null,
  role        text not null default 'worker' check (role in ('worker', 'manager')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.app_settings (
  key    text primary key,
  value  text not null
);
insert into public.app_settings(key, value) values
  ('timezone', 'UTC'),
  ('require_photo', 'false'),
  ('auto_register_products', 'true'),
  ('duplicate_window_minutes', '30'),
  ('app_url', '')
on conflict (key) do nothing;

-- Secrets readable only through functions (no access policies at all).
create table if not exists public.private_settings (
  key    text primary key,
  value  text not null
);
insert into public.private_settings(key, value)
  values ('feed_key', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

create table if not exists public.production_orders (
  order_id      text primary key,
  customer      text,
  product_name  text,
  quantity      integer check (quantity is null or quantity >= 0),
  created_at    timestamptz not null default now()
);

create table if not exists public.products (
  box_id        text primary key,
  order_id      text not null references public.production_orders(order_id),
  product_name  text,
  produced_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists products_order_idx on public.products(order_id);
create index if not exists products_produced_idx on public.products(produced_at);

create table if not exists public.production_stages (
  id          bigint generated always as identity primary key,
  name        text not null check (length(trim(name)) between 2 and 60),
  sort_order  integer not null default 0,
  active      boolean not null default true
);
create unique index if not exists production_stages_name_key on public.production_stages (lower(name));

create table if not exists public.error_categories (
  id          bigint generated always as identity primary key,
  name        text not null check (length(trim(name)) between 2 and 60),
  sort_order  integer not null default 0,
  active      boolean not null default true
);
create unique index if not exists error_categories_name_key on public.error_categories (lower(name));

create sequence if not exists public.error_report_seq;

create table if not exists public.error_reports (
  seq                   bigint primary key,
  error_id              text not null unique,
  client_submission_id  text not null unique,
  box_id                text not null references public.products(box_id),
  order_id              text not null references public.production_orders(order_id),
  stage_id              bigint not null references public.production_stages(id),
  category_id           bigint not null references public.error_categories(id),
  severity              text not null check (severity in ('Low', 'Medium', 'High', 'Critical')),
  description           text not null check (length(trim(description)) between 3 and 1000),
  photo_path            text,
  status                text not null default 'Open' check (status in ('Open', 'Under Review', 'In Rework', 'Resolved')),
  requires_rework       boolean not null default false,
  resolution_notes      text,
  reported_by           uuid not null references public.profiles(id),
  reported_at           timestamptz not null default now(),
  status_changed_at     timestamptz not null default now(),
  resolved_at           timestamptz,
  updated_at            timestamptz not null default now()
);
create index if not exists error_reports_reported_at_idx on public.error_reports(reported_at);
create index if not exists error_reports_status_idx on public.error_reports(status);
create index if not exists error_reports_box_idx on public.error_reports(box_id);
create index if not exists error_reports_order_idx on public.error_reports(order_id);
create index if not exists error_reports_reporter_idx on public.error_reports(reported_by);

create table if not exists public.error_status_history (
  id           bigint generated always as identity primary key,
  error_id     text not null references public.error_reports(error_id),
  from_status  text,
  to_status    text not null,
  note         text,
  changed_by   uuid not null references public.profiles(id),
  changed_at   timestamptz not null default now()
);
create index if not exists error_status_history_error_idx on public.error_status_history(error_id, changed_at);

create table if not exists public.error_report_revisions (
  id          bigint generated always as identity primary key,
  error_id    text not null references public.error_reports(error_id),
  field       text not null,
  old_value   text,
  new_value   text,
  changed_by  uuid not null references public.profiles(id),
  changed_at  timestamptz not null default now()
);
create index if not exists error_report_revisions_error_idx on public.error_report_revisions(error_id);

-- Default lists (only when empty)
insert into public.production_stages(name, sort_order)
select v.name, v.ord from (values
  ('Raw Material Inspection', 10), ('Cutting', 20), ('Machining', 30), ('Welding', 40), ('Assembly', 50),
  ('Painting / Finishing', 60), ('Quality Inspection', 70), ('Packaging', 80), ('Shipping', 90)) as v(name, ord)
where not exists (select 1 from public.production_stages);

insert into public.error_categories(name, sort_order)
select v.name, v.ord from (values
  ('Dimensional Error', 10), ('Surface Defect / Scratch', 20), ('Missing Part', 30), ('Wrong Part', 40),
  ('Assembly Error', 50), ('Weld Defect', 60), ('Paint / Coating Defect', 70), ('Damaged Component', 80),
  ('Labeling Error', 90), ('Packaging Damage', 100), ('Contamination', 110), ('Other', 120)) as v(name, ord)
where not exists (select 1 from public.error_categories);

-- ---------------------------------------------------------------------
-- 2. Integrity rules enforced by the database
-- ---------------------------------------------------------------------
create or replace function public.trg_block_delete() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception 'Records in % cannot be deleted', tg_table_name;
end $$;

create or replace function public.trg_append_only() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

create or replace function public.trg_report_immutable() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.error_id is distinct from old.error_id
     or new.client_submission_id is distinct from old.client_submission_id
     or new.box_id is distinct from old.box_id
     or new.order_id is distinct from old.order_id
     or new.description is distinct from old.description
     or new.photo_path is distinct from old.photo_path
     or new.reported_by is distinct from old.reported_by
     or new.reported_at is distinct from old.reported_at then
    raise exception 'Original error report fields are immutable';
  end if;
  return new;
end $$;

create or replace function public.trg_report_order_matches() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.order_id is distinct from (select p.order_id from public.products p where p.box_id = new.box_id) then
    raise exception 'order_id does not match the product box';
  end if;
  return new;
end $$;

drop trigger if exists no_delete on public.error_reports;
create trigger no_delete before delete on public.error_reports
  for each row execute function public.trg_block_delete();
drop trigger if exists original_immutable on public.error_reports;
create trigger original_immutable before update on public.error_reports
  for each row execute function public.trg_report_immutable();
drop trigger if exists order_matches on public.error_reports;
create trigger order_matches before insert on public.error_reports
  for each row execute function public.trg_report_order_matches();
drop trigger if exists append_only on public.error_status_history;
create trigger append_only before update or delete on public.error_status_history
  for each row execute function public.trg_append_only();
drop trigger if exists append_only on public.error_report_revisions;
create trigger append_only before update or delete on public.error_report_revisions
  for each row execute function public.trg_append_only();

-- ---------------------------------------------------------------------
-- 3. Accounts: every Supabase login gets a profile. The very first
--    account becomes a manager; all later accounts start as workers.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_base text;
  v_name text;
  v_n int := 0;
begin
  v_base := lower(regexp_replace(split_part(coalesce(new.email, 'user'), '@', 1), '[^a-zA-Z0-9._-]', '', 'g'));
  if v_base = '' then v_base := 'user'; end if;
  v_name := v_base;
  while exists (select 1 from public.profiles where username = v_name) loop
    v_n := v_n + 1;
    v_name := v_base || v_n;
  end loop;
  insert into public.profiles(id, username, full_name, role)
  values (new.id, v_name,
          coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), initcap(replace(replace(v_base, '.', ' '), '_', ' '))),
          case when exists (select 1 from public.profiles where role = 'manager') then 'worker' else 'manager' end)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Accounts created before this script ran also get a profile.
do $$
declare u record;
begin
  for u in select * from auth.users au where not exists (select 1 from public.profiles p where p.id = au.id) order by au.created_at loop
    insert into public.profiles(id, username, full_name, role)
    values (u.id,
            lower(regexp_replace(split_part(coalesce(u.email, 'user'), '@', 1), '[^a-zA-Z0-9._-]', '', 'g')) || '-' || left(u.id::text, 4),
            initcap(replace(split_part(coalesce(u.email, 'user'), '@', 1), '.', ' ')),
            case when exists (select 1 from public.profiles where role = 'manager') then 'worker' else 'manager' end)
    on conflict do nothing;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. Helper functions
-- ---------------------------------------------------------------------
create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'manager');
$$;

create or replace function public.setting(p_key text) returns text
language sql stable security definer set search_path = public as $$
  select value from public.app_settings where key = p_key;
$$;

create or replace function public.local_ts(p_ts timestamptz) returns text
language sql stable security definer set search_path = public as $$
  select case when p_ts is null then null
    else to_char(p_ts at time zone coalesce(nullif(public.setting('timezone'), ''), 'UTC'), 'YYYY-MM-DD HH24:MI:SS') end;
$$;

-- ---------------------------------------------------------------------
-- 5. Reporting view (exact spreadsheet column names). security_invoker
--    makes the caller's access rules apply.
-- ---------------------------------------------------------------------
drop view if exists public.v_error_reports;
create view public.v_error_reports with (security_invoker = true) as
select
  r.error_id,
  r.box_id,
  r.order_id,
  s.name                 as stage,
  c.name                 as error_type,
  r.severity,
  r.reported_at          as "timestamp",
  r.status,
  r.photo_path,
  r.description,
  r.requires_rework,
  r.resolution_notes,
  r.status_changed_at,
  r.resolved_at,
  r.updated_at,
  r.stage_id,
  r.category_id,
  r.reported_by,
  u.full_name            as reported_by_name,
  coalesce(p.product_name, o.product_name) as product_name,
  p.produced_at,
  case r.severity when 'Critical' then 4 when 'High' then 3 when 'Medium' then 2 else 1 end as severity_rank,
  case r.status when 'Open' then 1 when 'Under Review' then 2 when 'In Rework' then 3 else 4 end as status_rank
from public.error_reports r
join public.production_stages s on s.id = r.stage_id
join public.error_categories  c on c.id = r.category_id
join public.profiles          u on u.id = r.reported_by
join public.products          p on p.box_id = r.box_id
join public.production_orders o on o.order_id = p.order_id;

-- ---------------------------------------------------------------------
-- 6. Row-level security: who can read what. All changes to reports go
--    through the functions in section 7, never directly.
-- ---------------------------------------------------------------------
alter table public.profiles               enable row level security;
alter table public.app_settings           enable row level security;
alter table public.private_settings       enable row level security;
alter table public.production_orders      enable row level security;
alter table public.products               enable row level security;
alter table public.production_stages      enable row level security;
alter table public.error_categories       enable row level security;
alter table public.error_reports          enable row level security;
alter table public.error_status_history   enable row level security;
alter table public.error_report_revisions enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_manager());

drop policy if exists settings_read on public.app_settings;
create policy settings_read on public.app_settings for select to authenticated using (true);

drop policy if exists orders_read on public.production_orders;
create policy orders_read on public.production_orders for select to authenticated using (public.is_active_user());

drop policy if exists products_read on public.products;
create policy products_read on public.products for select to authenticated using (public.is_active_user());

drop policy if exists stages_read on public.production_stages;
create policy stages_read on public.production_stages for select to authenticated using (public.is_active_user());
drop policy if exists stages_insert on public.production_stages;
create policy stages_insert on public.production_stages for insert to authenticated with check (public.is_manager());
drop policy if exists stages_update on public.production_stages;
create policy stages_update on public.production_stages for update to authenticated
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists categories_read on public.error_categories;
create policy categories_read on public.error_categories for select to authenticated using (public.is_active_user());
drop policy if exists categories_insert on public.error_categories;
create policy categories_insert on public.error_categories for insert to authenticated with check (public.is_manager());
drop policy if exists categories_update on public.error_categories;
create policy categories_update on public.error_categories for update to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- Workers see only their own reports; managers see all.
drop policy if exists reports_read on public.error_reports;
create policy reports_read on public.error_reports for select to authenticated
  using (public.is_manager() or (reported_by = auth.uid() and public.is_active_user()));

drop policy if exists history_read on public.error_status_history;
create policy history_read on public.error_status_history for select to authenticated using (public.is_manager());

drop policy if exists revisions_read on public.error_report_revisions;
create policy revisions_read on public.error_report_revisions for select to authenticated using (public.is_manager());

-- Table privileges: read-only by default (plus list editing for managers,
-- still limited by the policies above). TRUNCATE is removed because it
-- would bypass row-level security.
grant usage on schema public to anon, authenticated;
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;
grant insert, update on public.production_stages, public.error_categories to authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ---------------------------------------------------------------------
-- 7. Functions called by the app
-- ---------------------------------------------------------------------

-- Product lookup after a QR scan (workers and managers).
create or replace function public.product_info(p_box text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_active_user() then raise exception 'Please sign in again' using errcode = '42501'; end if;
  select jsonb_build_object(
    'box_id', p.box_id,
    'order_id', p.order_id,
    'product_name', coalesce(p.product_name, o.product_name),
    'customer', o.customer,
    'registered', true,
    'open_errors', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.reported_at desc) from (
        select e.error_id, s.name as stage, c.name as error_type, e.severity, e.status, e.reported_at,
               public.local_ts(e.reported_at) as reported_at_local
          from public.error_reports e
          join public.production_stages s on s.id = e.stage_id
          join public.error_categories c on c.id = e.category_id
         where e.box_id = p.box_id and e.status <> 'Resolved'
         order by e.reported_at desc limit 5) x), '[]'::jsonb))
  into v
  from public.products p join public.production_orders o on o.order_id = p.order_id
  where p.box_id = p_box;
  return v;
end $$;

-- Short summary returned after submitting (own reports or manager).
create or replace function public.report_summary(p_error_id text, p_duplicate boolean) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'result', case when p_duplicate then 'existing' else 'created' end,
    'error_id', r.error_id, 'box_id', r.box_id, 'order_id', r.order_id, 'status', r.status,
    'timestamp', r.reported_at, 'timestamp_local', public.local_ts(r.reported_at))
  from public.error_reports r
  where r.error_id = p_error_id and (r.reported_by = auth.uid() or public.is_manager());
$$;

-- Submit an error report (workers and managers).
create or replace function public.submit_report(
  p_submission_id text,
  p_box_id text,
  p_order_id text,
  p_stage_id bigint,
  p_category_id bigint,
  p_severity text,
  p_description text,
  p_photo_path text default null,
  p_confirm_duplicate boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid      uuid := auth.uid();
  v_existing text;
  v_product  public.products;
  v_dup      record;
  v_seq      bigint;
  v_id       text;
  v_now      timestamptz := now();
  v_box      text := trim(coalesce(p_box_id, ''));
  v_order    text := nullif(trim(coalesce(p_order_id, '')), '');
  v_desc     text := trim(coalesce(p_description, ''));
  v_window   int := coalesce(nullif(public.setting('duplicate_window_minutes'), '')::int, 30);
  v_id_re    text := '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$';
begin
  if not public.is_active_user() then raise exception 'Please sign in again' using errcode = '42501'; end if;
  if p_submission_id is null or p_submission_id !~ '^[A-Za-z0-9-]{8,64}$' then
    raise exception 'client_submission_id is invalid';
  end if;

  -- Idempotency: a retried submission returns the original report.
  perform pg_advisory_xact_lock(hashtext('submit:' || p_submission_id));
  select error_id into v_existing from public.error_reports where client_submission_id = p_submission_id;
  if v_existing is not null then return public.report_summary(v_existing, true); end if;

  if v_box = '' then raise exception 'Box ID is required'; end if;
  if v_box !~ v_id_re then raise exception 'Box ID contains invalid characters'; end if;
  if v_order is not null and v_order !~ v_id_re then raise exception 'Order ID contains invalid characters'; end if;
  if p_stage_id is null or not exists (select 1 from public.production_stages where id = p_stage_id and active) then
    raise exception 'Select a valid production stage';
  end if;
  if p_category_id is null or not exists (select 1 from public.error_categories where id = p_category_id and active) then
    raise exception 'Select a valid error type';
  end if;
  if p_severity is null or p_severity not in ('Low', 'Medium', 'High', 'Critical') then
    raise exception 'Select a severity: Low, Medium, High or Critical';
  end if;
  if length(v_desc) < 3 then raise exception 'Description must be at least 3 characters'; end if;
  if length(v_desc) > 1000 then raise exception 'Description must be at most 1000 characters'; end if;

  if p_photo_path is null and public.setting('require_photo') = 'true' then
    raise exception 'A photo is required';
  end if;
  if p_photo_path is not null then
    if p_photo_path !~ ('^' || v_uid::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
      raise exception 'Invalid photo reference';
    end if;
    if not exists (select 1 from storage.objects where bucket_id = 'photos' and name = p_photo_path) then
      raise exception 'The photo upload did not complete. Please try again.';
    end if;
  end if;

  select * into v_product from public.products where box_id = v_box;
  if not found then
    if v_order is null or coalesce(public.setting('auto_register_products'), 'true') <> 'true' then
      raise exception 'Box % is not registered. Ask a manager to register it.', v_box;
    end if;
    insert into public.production_orders(order_id) values (v_order) on conflict do nothing;
    insert into public.products(box_id, order_id) values (v_box, v_order) on conflict do nothing;
    select * into v_product from public.products where box_id = v_box;
    if v_product.order_id <> v_order then
      raise exception 'Box % belongs to order %, not %', v_box, v_product.order_id, v_order;
    end if;
  elsif v_order is not null and v_order <> v_product.order_id then
    raise exception 'Box % belongs to order %, not %', v_box, v_product.order_id, v_order;
  end if;

  -- Probable duplicate: same box, stage and type still unresolved.
  if not coalesce(p_confirm_duplicate, false) then
    select e.error_id, e.reported_at into v_dup
      from public.error_reports e
     where e.box_id = v_box and e.stage_id = p_stage_id and e.category_id = p_category_id
       and e.status <> 'Resolved' and e.reported_at >= v_now - make_interval(mins => v_window)
     order by e.reported_at desc limit 1;
    if found then
      return jsonb_build_object('result', 'possible_duplicate', 'error_id', v_dup.error_id,
                                'reported_at_local', public.local_ts(v_dup.reported_at));
    end if;
  end if;

  v_seq := nextval('public.error_report_seq');
  v_id := 'ERR-' || case when v_seq < 1000000 then lpad(v_seq::text, 6, '0') else v_seq::text end;

  insert into public.error_reports(seq, error_id, client_submission_id, box_id, order_id, stage_id, category_id,
                                   severity, description, photo_path, status, reported_by, reported_at,
                                   status_changed_at, updated_at)
  values (v_seq, v_id, p_submission_id, v_product.box_id, v_product.order_id, p_stage_id, p_category_id,
          p_severity, v_desc, p_photo_path, 'Open', v_uid, v_now, v_now, v_now);
  insert into public.error_status_history(error_id, from_status, to_status, note, changed_by, changed_at)
  values (v_id, null, 'Open', 'Report submitted', v_uid, v_now);

  return public.report_summary(v_id, false);
end $$;

-- Manager: change status, add a note, set the rework flag.
create or replace function public.change_status(
  p_error_id text,
  p_status text,
  p_note text default null,
  p_requires_rework boolean default null,
  p_expected_updated_at timestamptz default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  cur       public.error_reports;
  v_note    text := nullif(trim(coalesce(p_note, '')), '');
  v_rework  boolean;
  v_changed boolean;
  v_now     timestamptz := now();
begin
  if not public.is_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('Open', 'Under Review', 'In Rework', 'Resolved') then
    raise exception 'Invalid status';
  end if;
  if length(coalesce(v_note, '')) > 2000 then raise exception 'Note must be at most 2000 characters'; end if;

  select * into cur from public.error_reports where error_id = p_error_id for update;
  if not found then raise exception 'Error report % not found', p_error_id; end if;
  if p_expected_updated_at is not null and p_expected_updated_at <> cur.updated_at then
    raise exception 'This report was changed by someone else. Reload it and try again.';
  end if;
  if cur.status = p_status and v_note is null then raise exception 'Report is already "%"', p_status; end if;
  if p_status = 'Resolved' and v_note is null then
    raise exception 'Add a resolution note describing the corrective action';
  end if;
  if cur.status = 'Resolved' and p_status <> 'Resolved' and v_note is null then
    raise exception 'Add a note explaining why the report is being reopened';
  end if;

  v_rework := cur.requires_rework;
  if p_status = 'In Rework' then v_rework := true; end if;
  if p_requires_rework is not null then v_rework := p_requires_rework; end if;
  if p_status = 'In Rework' and not v_rework then
    raise exception '"In Rework" always means rework is required';
  end if;
  if v_rework <> cur.requires_rework then
    insert into public.error_report_revisions(error_id, field, old_value, new_value, changed_by, changed_at)
    values (p_error_id, 'requires_rework', case when cur.requires_rework then 'Yes' else 'No' end,
            case when v_rework then 'Yes' else 'No' end, auth.uid(), v_now);
  end if;

  v_changed := cur.status <> p_status;
  update public.error_reports set
    status = p_status,
    requires_rework = v_rework,
    resolution_notes = coalesce(v_note, resolution_notes),
    status_changed_at = case when v_changed then v_now else status_changed_at end,
    resolved_at = case when p_status = 'Resolved' then (case when v_changed then v_now else resolved_at end) else null end,
    updated_at = v_now
  where error_id = p_error_id;

  insert into public.error_status_history(error_id, from_status, to_status, note, changed_by, changed_at)
  values (p_error_id, cur.status, p_status, v_note, auth.uid(), v_now);
end $$;

-- Manager: correct stage, error type, severity or rework flag (logged).
create or replace function public.correct_report(
  p_error_id text,
  p_stage_id bigint default null,
  p_category_id bigint default null,
  p_severity text default null,
  p_requires_rework boolean default null,
  p_expected_updated_at timestamptz default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  cur     public.error_reports;
  v_now   timestamptz := now();
  v_count int := 0;
  v_old   text;
  v_new   text;
begin
  if not public.is_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  select * into cur from public.error_reports where error_id = p_error_id for update;
  if not found then raise exception 'Error report % not found', p_error_id; end if;
  if p_expected_updated_at is not null and p_expected_updated_at <> cur.updated_at then
    raise exception 'This report was changed by someone else. Reload it and try again.';
  end if;

  if p_stage_id is not null and p_stage_id <> cur.stage_id then
    v_new := null;
    select name into v_new from public.production_stages where id = p_stage_id;
    if v_new is null then raise exception 'Invalid stage'; end if;
    select name into v_old from public.production_stages where id = cur.stage_id;
    insert into public.error_report_revisions(error_id, field, old_value, new_value, changed_by, changed_at)
    values (p_error_id, 'stage', v_old, v_new, auth.uid(), v_now);
    update public.error_reports set stage_id = p_stage_id where error_id = p_error_id;
    v_count := v_count + 1;
  end if;

  if p_category_id is not null and p_category_id <> cur.category_id then
    v_new := null;
    select name into v_new from public.error_categories where id = p_category_id;
    if v_new is null then raise exception 'Invalid error_type'; end if;
    select name into v_old from public.error_categories where id = cur.category_id;
    insert into public.error_report_revisions(error_id, field, old_value, new_value, changed_by, changed_at)
    values (p_error_id, 'error_type', v_old, v_new, auth.uid(), v_now);
    update public.error_reports set category_id = p_category_id where error_id = p_error_id;
    v_count := v_count + 1;
  end if;

  if p_severity is not null and p_severity <> cur.severity then
    if p_severity not in ('Low', 'Medium', 'High', 'Critical') then raise exception 'Invalid severity'; end if;
    insert into public.error_report_revisions(error_id, field, old_value, new_value, changed_by, changed_at)
    values (p_error_id, 'severity', cur.severity, p_severity, auth.uid(), v_now);
    update public.error_reports set severity = p_severity where error_id = p_error_id;
    v_count := v_count + 1;
  end if;

  if p_requires_rework is not null and p_requires_rework <> cur.requires_rework then
    if not p_requires_rework and cur.status = 'In Rework' then
      raise exception 'A report in rework always requires rework';
    end if;
    insert into public.error_report_revisions(error_id, field, old_value, new_value, changed_by, changed_at)
    values (p_error_id, 'requires_rework', case when cur.requires_rework then 'Yes' else 'No' end,
            case when p_requires_rework then 'Yes' else 'No' end, auth.uid(), v_now);
    update public.error_reports set requires_rework = p_requires_rework where error_id = p_error_id;
    v_count := v_count + 1;
  end if;

  if v_count = 0 then raise exception 'No changes to save'; end if;
  update public.error_reports set updated_at = v_now where error_id = p_error_id;
end $$;

-- Manager: status history and corrections for one report.
create or replace function public.report_history(p_error_id text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'history', coalesce((select jsonb_agg(jsonb_build_object(
        'from_status', h.from_status, 'to_status', h.to_status, 'note', h.note, 'changed_at', h.changed_at,
        'changed_at_local', public.local_ts(h.changed_at), 'changed_by', u.full_name) order by h.changed_at, h.id)
      from public.error_status_history h join public.profiles u on u.id = h.changed_by
      where h.error_id = p_error_id), '[]'::jsonb),
    'revisions', coalesce((select jsonb_agg(jsonb_build_object(
        'field', v.field, 'old_value', v.old_value, 'new_value', v.new_value, 'changed_at', v.changed_at,
        'changed_at_local', public.local_ts(v.changed_at), 'changed_by', u.full_name) order by v.changed_at, v.id)
      from public.error_report_revisions v join public.profiles u on u.id = v.changed_by
      where v.error_id = p_error_id), '[]'::jsonb));
end $$;

-- Manager: status history for many reports (Excel export).
create or replace function public.history_for_reports(p_error_ids text[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'error_id', h.error_id, 'from_status', h.from_status, 'to_status', h.to_status, 'note', h.note,
      'changed_at', h.changed_at, 'changed_by', u.full_name) order by h.error_id, h.changed_at, h.id)
    from public.error_status_history h join public.profiles u on u.id = h.changed_by
    where h.error_id = any(p_error_ids)), '[]'::jsonb);
end $$;

-- Manager: stages and error types including inactive ones and usage counts.
create or replace function public.admin_lists() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'stages', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'sort_order', s.sort_order,
        'active', case when s.active then 1 else 0 end,
        'used', (select count(*) from public.error_reports e where e.stage_id = s.id)) order by s.sort_order, s.name)
      from public.production_stages s), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'sort_order', c.sort_order,
        'active', case when c.active then 1 else 0 end,
        'used', (select count(*) from public.error_reports e where e.category_id = c.id)) order by c.sort_order, c.name)
      from public.error_categories c), '[]'::jsonb));
end $$;

-- Manager: orders with box and error counts.
create or replace function public.admin_orders() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select o.order_id, o.customer, o.product_name, o.quantity, o.created_at,
           (select count(*) from public.products p where p.order_id = o.order_id) as boxes,
           (select count(*) from public.error_reports e where e.order_id = o.order_id) as errors
      from public.production_orders o order by o.created_at desc limit 500) x), '[]'::jsonb);
end $$;

-- Manager: product search.
create or replace function public.admin_products(p_q text default null, p_order_id text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_q text := nullif(trim(coalesce(p_q, '')), '');
begin
  if not public.is_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by x.produced_at desc, x.box_id) from (
    select p.box_id, p.order_id, coalesce(p.product_name, o.product_name) as product_name, p.produced_at,
           public.local_ts(p.produced_at) as produced_at_local,
           (select count(*) from public.error_reports e where e.box_id = p.box_id) as errors
      from public.products p join public.production_orders o on o.order_id = p.order_id
     where (v_q is null or p.box_id ilike '%' || v_q || '%' or p.order_id ilike '%' || v_q || '%')
       and (p_order_id is null or p_order_id = '' or p.order_id = p_order_id)
     order by p.produced_at desc, p.box_id limit 1000) x), '[]'::jsonb);
end $$;

-- Manager: register an order and one box or a numbered batch of boxes.
create or replace function public.admin_register_products(
  p_order_id text,
  p_product_name text default null,
  p_customer text default null,
  p_box_id text default null,
  p_count int default null,
  p_box_prefix text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order  text := trim(coalesce(p_order_id, ''));
  v_name   text := nullif(left(trim(coalesce(p_product_name, '')), 100), '');
  v_cust   text := nullif(left(trim(coalesce(p_customer, '')), 100), '');
  v_prefix text;
  v_start  int;
  v_boxes  text[] := '{}';
  v_b      text;
  v_dup    text;
  v_id_re  text := '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$';
begin
  if not public.is_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  if v_order !~ v_id_re then raise exception 'Order ID is required (letters, numbers, . _ - /)'; end if;
  if nullif(trim(coalesce(p_box_id, '')), '') is not null then
    v_b := trim(p_box_id);
    if v_b !~ v_id_re then raise exception 'Box ID contains invalid characters'; end if;
    v_boxes := array[v_b];
  else
    if p_count is null or p_count < 1 or p_count > 1000 then
      raise exception 'Enter a Box ID or a quantity between 1 and 1000';
    end if;
    v_prefix := coalesce(nullif(trim(coalesce(p_box_prefix, '')), ''), 'BOX-' || v_order);
    if (v_prefix || '-0001') !~ v_id_re then raise exception 'Box prefix contains invalid characters'; end if;
    select count(*) + 1 into v_start from public.products where order_id = v_order;
    select array_agg(v_prefix || '-' || lpad((v_start + i)::text, 4, '0') order by i)
      into v_boxes from generate_series(0, p_count - 1) as i;
  end if;

  insert into public.production_orders(order_id, customer, product_name)
  values (v_order, v_cust, v_name)
  on conflict (order_id) do update set
    product_name = coalesce(public.production_orders.product_name, excluded.product_name),
    customer = coalesce(public.production_orders.customer, excluded.customer);

  foreach v_b in array v_boxes loop
    select order_id into v_dup from public.products where box_id = v_b;
    if v_dup is not null then raise exception 'Box % already exists (order %)', v_b, v_dup; end if;
    insert into public.products(box_id, order_id, product_name) values (v_b, v_order, v_name);
  end loop;
  return jsonb_build_object('order_id', v_order, 'box_ids', to_jsonb(v_boxes));
end $$;

-- Manager: users list.
create or replace function public.admin_users() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by x.role desc, x.full_name) from (
    select u.id, u.username, u.full_name, u.role, case when u.active then 1 else 0 end as active, u.created_at,
           au.email,
           (select count(*) from public.error_reports e where e.reported_by = u.id) as reports
      from public.profiles u left join auth.users au on au.id = u.id) x), '[]'::jsonb);
end $$;

-- Manager: change a user's name, username, role or active flag.
create or replace function public.admin_update_user(
  p_id uuid,
  p_full_name text default null,
  p_role text default null,
  p_active boolean default null,
  p_username text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  cur      public.profiles;
  v_role   text;
  v_active boolean;
  v_name   text;
  v_user   text;
begin
  if not public.is_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  select * into cur from public.profiles where id = p_id;
  if not found then raise exception 'User not found'; end if;
  v_role := coalesce(p_role, cur.role);
  v_active := coalesce(p_active, cur.active);
  v_name := coalesce(nullif(trim(coalesce(p_full_name, '')), ''), cur.full_name);
  v_user := coalesce(nullif(lower(trim(coalesce(p_username, ''))), ''), cur.username);
  if v_role not in ('worker', 'manager') then raise exception 'Role must be worker or manager'; end if;
  if length(v_name) < 2 or length(v_name) > 80 then raise exception 'Full name is required'; end if;
  if v_user !~ '^[a-z0-9._-]{2,40}$' then raise exception 'Username must be 2-40 letters, numbers, . _ or -'; end if;
  if v_user <> cur.username and exists (select 1 from public.profiles where username = v_user) then
    raise exception 'Username "%" is taken', v_user;
  end if;
  if cur.role = 'manager' and (v_role <> 'manager' or not v_active) then
    if p_id = auth.uid() then raise exception 'You cannot remove your own manager access'; end if;
    if not exists (select 1 from public.profiles where role = 'manager' and active and id <> p_id) then
      raise exception 'At least one active manager is required';
    end if;
  end if;
  update public.profiles set full_name = v_name, role = v_role, active = v_active, username = v_user where id = p_id;
end $$;

-- Manager: save system settings.
create or replace function public.admin_save_settings(p_settings jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text; v text;
begin
  if not public.is_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  for k, v in select key, value from jsonb_each_text(p_settings) loop
    if k not in ('timezone', 'require_photo', 'auto_register_products', 'duplicate_window_minutes', 'app_url') then
      raise exception 'Unknown setting %', k;
    end if;
    if k = 'timezone' and not exists (select 1 from pg_timezone_names where name = v) then
      raise exception 'Unknown time zone "%". Use a name such as America/Chicago or Europe/Madrid.', v;
    end if;
    if k in ('require_photo', 'auto_register_products') and v not in ('true', 'false') then
      raise exception '% must be true or false', k;
    end if;
    if k = 'duplicate_window_minutes' and (v !~ '^\d{1,5}$') then
      raise exception 'Duplicate window must be a number of minutes';
    end if;
    if k = 'app_url' and v <> '' and v !~ '^https?://' then raise exception 'App URL must start with https://'; end if;
    insert into public.app_settings(key, value) values (k, v) on conflict (key) do update set value = excluded.value;
  end loop;
end $$;

-- Manager: spreadsheet feed key.
create or replace function public.feed_key(p_rotate boolean default false) returns text
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_manager() then raise exception 'Manager access required' using errcode = '42501'; end if;
  if p_rotate then
    update public.private_settings
       set value = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
     where key = 'feed_key';
  end if;
  return (select value from public.private_settings where key = 'feed_key');
end $$;

-- Read-only spreadsheet feed for Google Sheets (needs the feed key).
-- Returns an array of rows; the first row is the header.
create or replace function public.sheet_feed(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_url text := coalesce(public.setting('app_url'), '');
begin
  if p_key is null or p_key <> (select value from public.private_settings where key = 'feed_key') then
    raise exception 'Invalid feed key' using errcode = '42501';
  end if;
  return jsonb_build_array(jsonb_build_array('error_ID', 'box_ID', 'order_ID', 'stage', 'error_type', 'severity',
           'timestamp', 'status', 'photo_image', 'description', 'requires_rework', 'resolved_at', 'resolution_notes', 'reported_by'))
      || coalesce((select jsonb_agg(jsonb_build_array(
           v.error_id, v.box_id, v.order_id, v.stage, v.error_type, v.severity, public.local_ts(v."timestamp"), v.status,
           case when v.photo_path is null or v_url = '' then '' else v_url || 'dashboard/?report=' || v.error_id end,
           v.description, case when v.requires_rework then 'Yes' else 'No' end, coalesce(public.local_ts(v.resolved_at), ''),
           coalesce(v.resolution_notes, ''), v.reported_by_name) order by v."timestamp", v.error_id)
         from public.v_error_reports v), '[]'::jsonb);
end $$;

-- Who may run which function.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.sheet_feed(text) to anon;

-- ---------------------------------------------------------------------
-- 8. Photo storage: private bucket. Workers upload into their own
--    folder; managers can view all photos; nobody can overwrite/delete.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "pts photos upload own folder" on storage.objects;
create policy "pts photos upload own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text and public.is_active_user());

drop policy if exists "pts photos read" on storage.objects;
create policy "pts photos read" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (public.is_manager() or (storage.foldername(name))[1] = auth.uid()::text));

-- ---------------------------------------------------------------------
-- 9. Live updates: dashboards are notified when reports change.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables)
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'error_reports') then
    alter publication supabase_realtime add table public.error_reports;
  end if;
end $$;

select 'Setup complete' as result;
