-- Removes ONLY the demo data (orders PO-DEMO-*, boxes BOX-D*), including
-- their error reports and history. Real data is not touched.
-- Run in Supabase: SQL Editor -> New query -> paste -> Run.
begin;
alter table public.error_status_history disable trigger append_only;
alter table public.error_report_revisions disable trigger append_only;
alter table public.error_reports disable trigger no_delete;

delete from public.error_status_history where error_id in (select error_id from public.error_reports where order_id like 'PO-DEMO-%');
delete from public.error_report_revisions where error_id in (select error_id from public.error_reports where order_id like 'PO-DEMO-%');
delete from public.error_reports where order_id like 'PO-DEMO-%';
delete from public.products where order_id like 'PO-DEMO-%';
delete from public.production_orders where order_id like 'PO-DEMO-%';

alter table public.error_status_history enable trigger append_only;
alter table public.error_report_revisions enable trigger append_only;
alter table public.error_reports enable trigger no_delete;
commit;

select 'Demo data removed' as result;
