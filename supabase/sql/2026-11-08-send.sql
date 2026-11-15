-- 8/11: "To send" list — customer drafts reach YML only after Send
alter table public.books add column if not exists sent boolean not null default false;
alter table public.books add column if not exists sent_at timestamptz;
update public.books set sent = true where origin = 'portal';  -- anything already entered counts as sent

create or replace function public.books_before_write() returns trigger language plpgsql as $$
begin
  if new.origin = 'sheet' then
    new.dyn_state := 'none'; new.locked := true;
  elsif tg_op = 'INSERT' then
    if new.sent then new.dyn_state := 'pending'; new.sent_at := now(); else new.dyn_state := 'none'; end if;
  elsif auth.role() = 'authenticated' then
    new.sent := old.sent or new.sent;                       -- can't un-send
    if new.sent and not old.sent then new.sent_at := now(); end if;
    new.dyn_state := case when new.sent then 'pending' else 'none' end;
    new.dyn_error := null;
    new.locked := old.locked; new.dyn_id := old.dyn_id; new.origin := old.origin;
    new.profile_id := old.profile_id; new.created_by := old.created_by; new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;

-- customers delete only unsent drafts
drop policy if exists b_delete on public.books;
create policy b_delete on public.books for delete to authenticated
  using (profile_id in (select public.my_profiles()) and origin = 'portal' and not sent and locked = false);
select sent, count(*) from public.books where origin='portal' group by 1;

-- 8/11: fix requests ("Send back for fix"). Customer says WHAT is wrong; YML decides fault/charge.
create table if not exists public.fix_requests (
  id bigint generated always as identity primary key,
  book_id bigint not null references public.books(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  issue text not null check (issue in ('wrong_text','add_text','bound_together','damage','other')),
  where_parts text[] not null default '{}',
  note text,
  status text not null default 'open' check (status in ('open','accepted','done','rejected')),
  yml_charge boolean,          -- YML decides: true = customer pays, false = our mistake
  yml_note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.fix_requests enable row level security;
drop policy if exists fr_read on public.fix_requests;
create policy fr_read on public.fix_requests for select to authenticated using (profile_id in (select public.my_profiles()));
drop policy if exists fr_insert on public.fix_requests;
create policy fr_insert on public.fix_requests for insert to authenticated
  with check (profile_id in (select public.my_profiles()) and status = 'open' and yml_charge is null
              and exists (select 1 from public.books b where b.id = book_id and b.profile_id = fix_requests.profile_id));
drop policy if exists fr_staff on public.fix_requests;
create policy fr_staff on public.fix_requests for update to authenticated using (public.am_i_staff()) with check (public.am_i_staff());

-- 9/11: book number (Dyntechs x_name, e.g. B177; pre-Dyntechs history = BX### / AX###)
alter table public.books add column if not exists book_no text;
create index if not exists books_no_idx on public.books(book_no);
