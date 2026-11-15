-- 15/11: YML note per book – staff only, never sent to Dyntechs, never overwritten by the sync.
create table if not exists public.staff_notes (
  book_id bigint primary key references public.books(id) on delete cascade,
  note text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.staff_notes enable row level security;
drop policy if exists sn_staff on public.staff_notes;
create policy sn_staff on public.staff_notes for all to authenticated using (public.am_i_staff()) with check (public.am_i_staff());
revoke all on public.staff_notes from anon;
-- (the notes themselves are data, entered in the portal – not in this file)
