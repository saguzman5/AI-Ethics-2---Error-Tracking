-- =====================================================================
-- OPTIONAL demo data for the online version (Supabase).
-- Run AFTER supabase-setup.sql and AFTER you have created at least one
-- login. Adds 12 orders, 480 boxes and about 200 error reports from the
-- last 60 days, all reported by existing accounts.
--
-- Use it only to try the system. To remove the demo data later, see
-- Documentation/ONLINE_SETUP.md ("Removing demo data").
-- =====================================================================
do $$
declare
  v_people  uuid[];
  v_manager uuid;
  v_stages  bigint[];
  v_cats    bigint[];
  v_names   text[] := array['Control Cabinet CX-200', 'Pump Housing PH-40', 'Conveyor Frame CF-12', 'Sensor Enclosure SE-7'];
  v_cust    text[] := array['Northwind Industrial', 'Contoso Energy', 'Fabrikam Logistics', 'Tailspin Water'];
  v_descs   text[] := array['Deep scratch on front panel', 'Hole position out of tolerance by 0.8 mm', 'Rubber gasket missing',
                            'Porosity on corner weld', 'Paint runs on rear panel', 'Bracket mounted upside down',
                            'Wrong revision of PCB installed', 'Cracked plastic cover', 'Serial label does not match box',
                            'Box corner crushed', 'Oil residue inside enclosure', 'Fasteners not torqued to spec'];
  v_order   text;
  v_box     text;
  v_created timestamptz;
  v_prod    timestamptz;
  v_rep     timestamptz;
  v_t       timestamptz;
  v_seq     bigint;
  v_id      text;
  v_sev     text;
  v_status  text;
  v_rework  boolean;
  v_prog    int;
  v_n       int;
  v_age     float;
  v_reporter uuid;
  v_stage   bigint;
  v_note    text;
  i int; b int; k int;
begin
  select array_agg(id) into v_people from public.profiles where active;
  select id into v_manager from public.profiles where role = 'manager' and active order by created_at limit 1;
  if v_people is null or v_manager is null then
    raise exception 'Create your manager login first (Authentication > Users > Add user), then run this script.';
  end if;
  if exists (select 1 from public.production_orders where order_id = 'PO-DEMO-0101') then
    raise exception 'Demo data is already loaded.';
  end if;
  select array_agg(id order by sort_order) into v_stages from public.production_stages where active;
  select array_agg(id order by sort_order) into v_cats from public.error_categories where active;
  perform setseed(0.42);

  for i in 1..12 loop
    v_order := 'PO-DEMO-' || lpad((100 + i)::text, 4, '0');
    v_created := now() - make_interval(days => 60 - (i - 1) * 5);
    insert into public.production_orders(order_id, customer, product_name, quantity, created_at)
    values (v_order, v_cust[1 + floor(random() * 4)::int], v_names[1 + floor(random() * 4)::int], 40, v_created);
    for b in 1..40 loop
      v_box := 'BOX-D' || lpad(i::text, 2, '0') || lpad(b::text, 3, '0');
      v_prod := v_created + random() * interval '5 days';
      insert into public.products(box_id, order_id, produced_at, created_at) values (v_box, v_order, v_prod, v_prod);
      continue when random() > 0.32;
      v_n := case when random() < 0.7 then 1 when random() < 0.66 then 2 else 3 end;
      for k in 1..v_n loop
        v_rep := v_prod + random() * interval '3 days';
        if v_rep > now() - interval '1 hour' then v_rep := now() - (1 + random() * 30) * interval '1 hour'; end if;
        v_sev := case when random() < 0.37 then 'Low' when random() < 0.6 then 'Medium' when random() < 0.7 then 'High' else 'Critical' end;
        v_stage := v_stages[1 + floor(random() * array_length(v_stages, 1))::int];
        v_reporter := v_people[1 + floor(random() * array_length(v_people, 1))::int];
        v_age := extract(epoch from now() - v_rep) / 86400;
        v_prog := case when v_age > 6 then (case when random() < 0.8 then 4 when random() < 0.5 then 3 else 2 end)
                       when v_age > 2 then 1 + floor(random() * 4)::int
                       else (case when random() < 0.6 then 1 when random() < 0.75 then 2 else 3 end) end;
        v_rework := random() < 0.65;
        v_seq := nextval('public.error_report_seq');
        v_id := 'ERR-' || lpad(v_seq::text, 6, '0');
        insert into public.error_reports(seq, error_id, client_submission_id, box_id, order_id, stage_id, category_id,
            severity, description, status, reported_by, reported_at, status_changed_at, updated_at)
        values (v_seq, v_id, gen_random_uuid()::text, v_box, v_order, v_stage, v_cats[1 + floor(random() * array_length(v_cats, 1))::int],
            v_sev, v_descs[1 + floor(random() * 12)::int], 'Open', v_reporter, v_rep, v_rep, v_rep);
        insert into public.error_status_history(error_id, from_status, to_status, note, changed_by, changed_at)
        values (v_id, null, 'Open', 'Report submitted', v_reporter, v_rep);
        v_status := 'Open';
        v_t := v_rep;
        if v_prog >= 2 then
          v_t := least(now() - interval '1 minute', v_t + (1 + random() * 10) * interval '1 hour');
          insert into public.error_status_history(error_id, from_status, to_status, note, changed_by, changed_at)
          values (v_id, v_status, 'Under Review', 'Investigating with shift lead', v_manager, v_t);
          v_status := 'Under Review';
        end if;
        if v_prog >= 3 and v_rework then
          v_t := least(now() - interval '1 minute', v_t + (1 + random() * 12) * interval '1 hour');
          insert into public.error_status_history(error_id, from_status, to_status, note, changed_by, changed_at)
          values (v_id, v_status, 'In Rework', 'Sent back for correction', v_manager, v_t);
          v_status := 'In Rework';
        end if;
        if v_prog >= 4 then
          v_t := least(now() - interval '1 minute', v_t + (2 + random() * 30) * interval '1 hour');
          v_note := case when v_rework then 'Rework completed and re-inspected OK' else 'Within tolerance after review; no rework needed' end;
          insert into public.error_status_history(error_id, from_status, to_status, note, changed_by, changed_at)
          values (v_id, v_status, 'Resolved', v_note, v_manager, v_t);
          v_status := 'Resolved';
        end if;
        if v_status <> 'Open' then
          update public.error_reports set
            status = v_status,
            requires_rework = (v_status = 'In Rework' or (v_status = 'Resolved' and v_rework and v_prog >= 3)),
            resolution_notes = (select h.note from public.error_status_history h where h.error_id = v_id order by h.changed_at desc, h.id desc limit 1),
            status_changed_at = v_t,
            resolved_at = case when v_status = 'Resolved' then v_t end,
            updated_at = v_t
          where error_id = v_id;
        end if;
      end loop;
    end loop;
  end loop;
end $$;

select count(*) as demo_error_reports from public.error_reports;
