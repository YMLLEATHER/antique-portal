-- 10/11 night: customers may move a book until measurements (locked), even after it got a number.
-- Dyntechs: the card gets the new customer's letter and "Sticker to reprint"; action 710 gives the new number.
alter table public.books add column if not exists dyn_priority boolean not null default false;  -- last value sent to Dyntechs
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
  return n;
end $$;
select 'ok';
