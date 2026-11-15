-- Antique Books Portal — Supabase schema (YML Leather)
-- Run once in Supabase → SQL Editor.

-- 1. Profiles = a "customer book list" (one per customer list)
create table if not exists public.profiles (
  id            uuid primary key default gen_random_uuid(),
  code          text unique not null,          -- short code per list
  name          text not null,                 -- shown in the UI
  show_extras   boolean not null default false,-- Half leather + Stickers options
  dyn_partner_id integer,                      -- Dyntechs res.partner id
  dyn_source    text,                          -- Dyntechs x_source value
  created_at    timestamptz not null default now()
);

-- 2. Which login sees which profiles (a login can have several lists)
create table if not exists public.profile_members (
  user_id    uuid not null references auth.users(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  primary key (user_id, profile_id)
);

-- 3. Books (history from the sheet + new books from the portal)
create table if not exists public.books (
  id            bigint generated always as identity primary key,
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  origin        text not null default 'portal' check (origin in ('portal','sheet')),
  ref           text,
  spine_top     text,
  spine_mid     text,
  spine_bot     text,
  front_text    text,
  name_line     text,
  level         text,                 -- 'Level 1'..'Level 4'
  half_leather  boolean not null default false,
  stickers      boolean not null default false,
  set_name      text,
  vol           integer,
  vol_total     integer,
  is_folder     boolean not null default false,
  paper_w       numeric, paper_h numeric, sleeves integer,
  is_box        boolean not null default false,
  box_w numeric, box_h numeric, box_d numeric, box_note text,
  notes         text,
  sheet_ref     text,                 -- '<sheet> / <tab> / row 123' for history rows
  sheet_done    text,                 -- original "Done" column (history only)
  -- sync with Dyntechs (x_antique_book)
  dyn_id        integer,
  dyn_state     text not null default 'pending' check (dyn_state in ('pending','synced','error','none')),
  dyn_error     text,
  locked        boolean not null default false,  -- true once the job went to production
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists books_profile_idx on public.books(profile_id, created_at desc);
create index if not exists books_pending_idx on public.books(dyn_state) where dyn_state <> 'synced';

-- history rows never go to Dyntechs
create or replace function public.books_before_write() returns trigger
language plpgsql as $$
begin
  if new.origin = 'sheet' then
    new.dyn_state := 'none'; new.locked := true;
  elsif tg_op = 'UPDATE' and auth.role() = 'authenticated' then
    -- a customer edit: queue it for Dyntechs again
    new.dyn_state := 'pending'; new.dyn_error := null;
    new.locked := old.locked; new.dyn_id := old.dyn_id; new.origin := old.origin;
    new.profile_id := old.profile_id; new.created_by := old.created_by; new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists books_before_write on public.books;
create trigger books_before_write before insert or update on public.books
for each row execute function public.books_before_write();

-- 4. Row Level Security
alter table public.profiles        enable row level security;
alter table public.profile_members enable row level security;
alter table public.books           enable row level security;

create or replace function public.my_profiles() returns setof uuid
language sql stable security definer set search_path = public as $$
  select profile_id from public.profile_members where user_id = auth.uid()
$$;

drop policy if exists p_read on public.profiles;
create policy p_read on public.profiles for select to authenticated
  using (id in (select public.my_profiles()));

drop policy if exists pm_read on public.profile_members;
create policy pm_read on public.profile_members for select to authenticated
  using (user_id = auth.uid());

drop policy if exists b_read on public.books;
create policy b_read on public.books for select to authenticated
  using (profile_id in (select public.my_profiles()));

drop policy if exists b_insert on public.books;
create policy b_insert on public.books for insert to authenticated
  with check (profile_id in (select public.my_profiles()) and origin = 'portal' and locked = false);

drop policy if exists b_update on public.books;
create policy b_update on public.books for update to authenticated
  using (profile_id in (select public.my_profiles()) and origin = 'portal' and locked = false)
  with check (profile_id in (select public.my_profiles()));

drop policy if exists b_delete on public.books;
create policy b_delete on public.books for delete to authenticated
  using (profile_id in (select public.my_profiles()) and origin = 'portal' and locked = false and dyn_id is null);

-- 5. Profiles (customer lists) are added in the dashboard – no customer data in this file
