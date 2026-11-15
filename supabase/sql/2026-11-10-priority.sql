-- 10/11: "High priority" flag — only for lists with can_priority (set per list).
alter table public.profiles add column if not exists can_priority boolean not null default false;
-- can_priority is switched on per list in the dashboard
alter table public.books add column if not exists priority boolean not null default false;
alter table public.books add column if not exists priority_at timestamptz;

create or replace function public.books_before_write() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and coalesce(current_setting('yml.prio', true), '') = '1' then
    new.updated_at := now(); return new;                     -- priority flag only, nothing goes to Dyntechs
  end if;
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
    if coalesce(current_setting('yml.move', true), '') <> '1' then new.profile_id := old.profile_id; end if;
    new.priority := old.priority; new.priority_at := old.priority_at;   -- only set_priority() changes it
    new.created_by := old.created_by; new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function public.set_priority(p_ids bigint[], p_on boolean) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if exists (select 1 from books b join profiles p on p.id = b.profile_id where b.id = any(p_ids)
             and (not p.can_priority or (b.profile_id not in (select public.my_profiles()) and not public.am_i_staff())
                  or b.hist_status = 'done')) then
    raise exception 'Not allowed';
  end if;
  perform set_config('yml.prio', '1', true);
  update books set priority = p_on, priority_at = case when p_on then now() end where id = any(p_ids);
  get diagnostics n = row_count;
  perform set_config('yml.prio', '', true);
  return n;
end $$;
revoke all on function public.set_priority(bigint[], boolean) from public, anon;
grant execute on function public.set_priority(bigint[], boolean) to authenticated;
select code, can_priority from public.profiles where can_priority;
