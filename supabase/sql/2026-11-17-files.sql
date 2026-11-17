-- 17/11: files (PDF, photos…) attached to a book. Private bucket; the customer of that list and YML staff only.
insert into storage.buckets (id, name, public, file_size_limit)
values ('book-files', 'book-files', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;

create table if not exists public.book_files (
  id          bigint generated always as identity primary key,
  book_id     bigint not null references public.books(id) on delete cascade,
  profile_id  uuid   not null references public.profiles(id) on delete cascade,
  path        text   not null,              -- object path in bucket book-files
  name        text   not null,              -- original file name
  mime        text,
  size        bigint,
  dyn_att_id  integer,                      -- ir.attachment id on the Dyntechs card (set by the sync)
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists book_files_book_idx on public.book_files(book_id);
alter table public.book_files enable row level security;

-- may this login add/remove files on this book? (own list; until measurements; staff always)
create or replace function public.can_attach(p_book bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from books b where b.id = p_book and b.profile_id in (select public.my_profiles())
                 and (public.am_i_staff() or (not b.locked and coalesce(b.hist_status,'') <> 'done')))
$$;

drop policy if exists bf_read on public.book_files;
create policy bf_read on public.book_files for select to authenticated using (profile_id in (select public.my_profiles()));
drop policy if exists bf_insert on public.book_files;
create policy bf_insert on public.book_files for insert to authenticated
  with check (profile_id in (select public.my_profiles()) and public.can_attach(book_id) and dyn_att_id is null
              and exists (select 1 from public.books b where b.id = book_id and b.profile_id = book_files.profile_id));
drop policy if exists bf_delete on public.book_files;
create policy bf_delete on public.book_files for delete to authenticated using (profile_id in (select public.my_profiles()) and public.can_attach(book_id));
revoke all on public.book_files from anon;

-- storage: upload into <profile_id>/<book_id>/… of an own book; read / delete only files listed in book_files
drop policy if exists bfo_insert on storage.objects;
create policy bfo_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'book-files'
              and (storage.foldername(name))[1] in (select p::text from public.my_profiles() p)
              and (storage.foldername(name))[2] ~ '^[0-9]+$'
              and public.can_attach(((storage.foldername(name))[2])::bigint));
drop policy if exists bfo_read on storage.objects;
create policy bfo_read on storage.objects for select to authenticated
  using (bucket_id = 'book-files'
         and ((storage.foldername(name))[1] in (select p::text from public.my_profiles() p)
              or exists (select 1 from public.book_files f where f.path = storage.objects.name and f.profile_id in (select public.my_profiles()))));
drop policy if exists bfo_delete on storage.objects;
create policy bfo_delete on storage.objects for delete to authenticated
  using (bucket_id = 'book-files'
         and (storage.foldername(name))[1] in (select p::text from public.my_profiles() p)
         and (storage.foldername(name))[2] ~ '^[0-9]+$'
         and public.can_attach(((storage.foldername(name))[2])::bigint));

-- moving a book to another list moves its files too
create or replace function public.move_books(p_ids bigint[], p_to uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer; staff boolean := public.am_i_staff();
begin
  if not (staff or p_to in (select public.my_profiles())) then raise exception 'Not allowed'; end if;
  if exists (select 1 from books where id = any(p_ids) and (
       profile_id not in (select public.my_profiles()) and not staff
       or origin <> 'portal' or locked or hist_status = 'done')) then
    raise exception 'To make changes, please call the office';
  end if;
  perform set_config('yml.move', '1', true);
  update books set profile_id = p_to where id = any(p_ids) and profile_id <> p_to;
  get diagnostics n = row_count;
  perform set_config('yml.move', '', true);
  update fix_requests set profile_id = p_to where book_id = any(p_ids);
  update book_files set profile_id = p_to where book_id = any(p_ids);
  return n;
end $$;
select 'ok';
