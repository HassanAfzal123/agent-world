-- Enable Realtime for the live city map (run in SQL editor if MCP blocked)
alter publication supabase_realtime add table public.agents;
alter publication supabase_realtime add table public.city_log;
alter publication supabase_realtime add table public.city_meta;
