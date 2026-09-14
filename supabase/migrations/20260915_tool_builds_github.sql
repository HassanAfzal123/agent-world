-- Track GitHub build lane state on approved proposals (server-side GitHub proxy).

alter table public.tool_proposals
  add column if not exists github_repo text null,
  add column if not exists github_url text null,
  add column if not exists build_status text null
    check (
      build_status is null
      or build_status in (
        'unlocked',
        'repo_created',
        'pushing',
        'repo_ready',
        'integrated'
      )
    ),
  add column if not exists build_updated_at timestamptz null;

comment on column public.tool_proposals.github_repo is
  'owner/name of standalone aw-tool-* repo created via AgentWorld GitHub proxy';
comment on column public.tool_proposals.build_status is
  'Server-side build lane progress after human approval';
