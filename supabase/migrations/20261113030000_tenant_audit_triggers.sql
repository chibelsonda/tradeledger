create or replace function public.record_tenant_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    row_data jsonb := case
        when tg_op = 'DELETE' then to_jsonb(old)
        else to_jsonb(new)
    end;
    tenant_id uuid := (row_data ->> 'organization_id')::uuid;
    record_id uuid := coalesce(
        nullif(row_data ->> 'id', '')::uuid,
        nullif(row_data ->> 'project_id', '')::uuid
    );
    safe_metadata jsonb;
begin
    safe_metadata := case tg_table_name
        when 'projects' then jsonb_build_object(
            'name', row_data ->> 'name',
            'code', row_data ->> 'code',
            'status', row_data ->> 'status'
        )
        when 'subcontractors' then jsonb_build_object(
            'company_name', row_data ->> 'company_name',
            'status', row_data ->> 'status'
        )
        when 'project_subcontractors' then jsonb_build_object(
            'project_id', row_data ->> 'project_id',
            'subcontractor_id', row_data ->> 'subcontractor_id'
        )
        else '{}'::jsonb
    end;

    insert into public.audit_events (
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        metadata
    ) values (
        tenant_id,
        auth.uid(),
        tg_table_name || '.' || lower(tg_op),
        tg_table_name,
        record_id,
        safe_metadata
    );

    return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists projects_record_tenant_change on public.projects;
create trigger projects_record_tenant_change
after insert or update or delete on public.projects
for each row execute function public.record_tenant_change();

drop trigger if exists subcontractors_record_tenant_change on public.subcontractors;
create trigger subcontractors_record_tenant_change
after insert or update or delete on public.subcontractors
for each row execute function public.record_tenant_change();

drop trigger if exists project_subcontractors_record_tenant_change
    on public.project_subcontractors;
create trigger project_subcontractors_record_tenant_change
after insert or delete on public.project_subcontractors
for each row execute function public.record_tenant_change();

revoke all on function public.record_tenant_change() from public, anon, authenticated;
grant execute on function public.record_tenant_change() to service_role;
