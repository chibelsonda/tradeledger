grant select (retainage_release_id)
on public.payment_transfers
to authenticated;

comment on column public.payment_transfers.retainage_release_id is
    'Optional retainage release relationship, readable by financial roles through the table RLS policy.';
