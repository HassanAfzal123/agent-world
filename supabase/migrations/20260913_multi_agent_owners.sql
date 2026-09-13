-- Allow one human to connect multiple existing agents.
alter table public.agents drop constraint if exists agents_one_per_owner;
drop index if exists agents_one_per_owner;
