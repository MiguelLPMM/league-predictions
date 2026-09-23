-- 0002: predictions (entries), lock rules, reveal gate
--
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> paste this file -> Run.
-- Safe to re-run. Requires 0001.
--
-- An entry is one user's predicted final table for one league season.
--   * On time (before the league's first kickoff): editable, each save
--     overwrites the previous one.
--   * Late (after kickoff, until the season concludes): one shot, never
--     editable; late_matchweek = matchweeks already started when submitted.
--   * entry_mode = 'fixed_rank' (used later by guest imports / merges) locks
--     an entry against the normal save path forever.
-- Browsers can only READ entries (own always; others once revealed). Every
-- write goes through save_entry(), callable only by the server (service role),
-- which the /api/entries endpoint calls after verifying the user's login.

create table if not exists public.entries (
    id uuid primary key default gen_random_uuid(),
    league_season_id uuid not null references public.league_seasons (id) on delete cascade,
    user_id uuid references auth.users (id) on delete cascade,
    late_matchweek int not null default 0,
    entry_mode text not null default 'live' check (entry_mode in ('live', 'fixed_rank')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (league_season_id, user_id)
);

create table if not exists public.entry_picks (
    entry_id uuid not null references public.entries (id) on delete cascade,
    position int not null,
    team_id uuid not null references public.teams (id),
    primary key (entry_id, position),
    unique (entry_id, team_id)
);

alter table public.entries enable row level security;
alter table public.entry_picks enable row level security;

-- Own entries are always visible; everyone else's only after the reveal.
drop policy if exists "entries: own or revealed" on public.entries;
create policy "entries: own or revealed" on public.entries
    for select using (user_id = auth.uid() or public.is_revealed(league_season_id));

-- Picks follow their entry (the subquery is itself filtered by the policy above).
drop policy if exists "entry_picks: follow entry" on public.entry_picks;
create policy "entry_picks: follow entry" on public.entry_picks
    for select using (exists (select 1 from public.entries e where e.id = entry_id));

grant select on public.entries, public.entry_picks to anon, authenticated;
grant all on public.entries, public.entry_picks to service_role;

-- ============================================================================
-- save_entry: the only write path. Errors are raised as short codes the API
-- maps to HTTP statuses: not_found, season_closed, invalid_teams, entry_locked.
-- Returns {mode: 'on_time'|'late', overwritten, late_matchweek}.
-- ============================================================================

create or replace function public.save_entry(p_user_id uuid, p_league_season_id uuid, p_team_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_ls public.league_seasons;
    v_entry public.entries;
    v_on_time boolean;
    v_expected int;
    v_badge int := 0;
    v_overwritten boolean := false;
    i int;
begin
    if p_user_id is null then
        raise exception 'not_found';
    end if;

    select * into v_ls from public.league_seasons where id = p_league_season_id;
    if not found then
        raise exception 'not_found';
    end if;

    if v_ls.is_manual or v_ls.status = 'concluded' then
        raise exception 'season_closed';
    end if;

    -- The submitted order must be exactly this season's teams, each once.
    select count(*) into v_expected from public.season_teams where league_season_id = v_ls.id;
    if v_expected = 0
        or coalesce(array_length(p_team_ids, 1), 0) <> v_expected
        or (select count(distinct t) from unnest(p_team_ids) t) <> v_expected
        or exists (
            select 1 from unnest(p_team_ids) t
            where t not in (select team_id from public.season_teams where league_season_id = v_ls.id)
        ) then
        raise exception 'invalid_teams';
    end if;

    v_on_time := v_ls.first_kickoff_at is null or now() < v_ls.first_kickoff_at;

    select * into v_entry from public.entries
    where league_season_id = v_ls.id and user_id = p_user_id
    for update;

    if found then
        -- Locked once kickoff passed (on-time entries freeze, late ones never
        -- edit) or when flagged fixed_rank.
        if v_entry.entry_mode = 'fixed_rank' or not v_on_time then
            raise exception 'entry_locked';
        end if;

        v_overwritten := true;
        delete from public.entry_picks where entry_id = v_entry.id;
        update public.entries set updated_at = now() where id = v_entry.id;
    else
        -- Kickoff has passed, so at least matchweek 1 has started even if the
        -- last sync hasn't recorded it yet.
        if not v_on_time then
            v_badge := greatest(v_ls.started_matchweek, 1);
        end if;

        insert into public.entries (league_season_id, user_id, late_matchweek)
        values (v_ls.id, p_user_id, v_badge)
        returning * into v_entry;
    end if;

    for i in 1 .. v_expected loop
        insert into public.entry_picks (entry_id, position, team_id)
        values (v_entry.id, i, p_team_ids[i]);
    end loop;

    return jsonb_build_object(
        'mode', case when v_on_time then 'on_time' else 'late' end,
        'overwritten', v_overwritten,
        'late_matchweek', v_entry.late_matchweek
    );
end;
$$;

revoke execute on function public.save_entry(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.save_entry(uuid, uuid, uuid[]) to service_role;
