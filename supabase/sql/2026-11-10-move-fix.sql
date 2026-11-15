-- 10/11: move books between a user's own lists (e.g. two lists of the same customer), and YML fix-requests screen.
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
    if coalesce(current_setting('yml.move', true), '') <> '1' then new.profile_id := old.profile_id; end if;  -- only move_books() may change the list
    new.created_by := old.created_by; new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function public.move_books(p_ids bigint[], p_to uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer; staff boolean := public.am_i_staff();
begin
  if not (staff or p_to in (select public.my_profiles())) then raise exception 'Not allowed'; end if;
  if exists (select 1 from books where id = any(p_ids) and (
       profile_id not in (select public.my_profiles()) and not staff
       or origin <> 'portal' or locked or (book_no is not null and not staff))) then
    raise exception 'To make changes, please call the office';
  end if;
  perform set_config('yml.move', '1', true);
  update books set profile_id = p_to where id = any(p_ids) and profile_id <> p_to;
  get diagnostics n = row_count;
  perform set_config('yml.move', '', true);
  update fix_requests set profile_id = p_to where book_id = any(p_ids);
  return n;
end $$;
revoke all on function public.move_books(bigint[], uuid) from public, anon;
grant execute on function public.move_books(bigint[], uuid) to authenticated;
