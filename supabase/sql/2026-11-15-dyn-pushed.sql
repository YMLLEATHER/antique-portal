-- 15/11: what the sync last sent to each Dyntechs card. Edits send only fields the customer changed; office edits on the card are kept.
alter table public.books add column if not exists dyn_pushed jsonb;
create or replace function public.books_before_write() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and coalesce(current_setting('yml.prio', true), '') = '1' then
    new.updated_at := now(); return new;                     -- priority flag only, nothing goes to Dyntechs
  end if;
  if new.origin = 'sheet' then
    new.dyn_state := 'none'; new.locked := true;
  elsif tg_op = 'INSERT' then
    if new.sent then new.dyn_state := 'pending'; new.sent_at := now(); else new.dyn_state := 'none'; end if;
    if auth.role() = 'authenticated' then new.dyn_pushed := null; end if;
  elsif auth.role() = 'authenticated' then
    new.sent := old.sent or new.sent;                       -- can't un-send
    if new.sent and not old.sent then new.sent_at := now(); end if;
    new.dyn_state := case when new.sent then 'pending' else 'none' end;
    new.dyn_error := null;
    new.locked := old.locked; new.dyn_id := old.dyn_id; new.origin := old.origin;
    if coalesce(current_setting('yml.move', true), '') <> '1' then new.profile_id := old.profile_id; end if;
    new.priority := old.priority; new.priority_at := old.priority_at;   -- only set_priority() changes it
    new.dyn_pushed := old.dyn_pushed;                                    -- only the sync changes it
    new.created_by := old.created_by; new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;
select 'ok';
