-- 15/11: Dyntechs letters for Half leather / Stickers per list (was hard-coded in dyn-sync)
alter table public.profiles add column if not exists prefix_half text, add column if not exists prefix_labels text;
-- values are set per list in the dashboard
