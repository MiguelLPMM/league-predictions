-- 0005: auto-conclude past manual seasons + fill in football-data ids for hand-made teams
--
-- HOW TO RUN: Supabase SQL Editor -> paste -> Run. Safe to re-run. Requires 0004.

-- Saving the table of a manual season before the current one now concludes it
-- (no second step). "Reopen" still works from the admin page.
create or replace function public.core_set_manual_standings(p_league_season_id uuid, p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_ls public.league_seasons;
    v_n int;
    r jsonb;
    v_team uuid;
    v_name text;
    v_teams uuid[] := '{}';
    v_positions int[] := '{}';
    v_pos int;
begin
    select * into v_ls from public.league_seasons where id = p_league_season_id for update;
    if not found then raise exception 'not_found'; end if;
    if not v_ls.is_manual then raise exception 'not_manual'; end if;

    if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'invalid_rows'; end if;
    v_n := jsonb_array_length(p_rows);
    if v_n < 2 then raise exception 'invalid_rows'; end if;

    -- resolve every row to a team id first (nothing is written until all are valid)
    for r in select * from jsonb_array_elements(p_rows)
    loop
        v_pos := nullif(r ->> 'position', '')::int;
        if v_pos is null then raise exception 'invalid_rows'; end if;
        v_positions := v_positions || v_pos;

        v_team := nullif(r ->> 'team_id', '')::uuid;
        if v_team is not null then
            if not exists (select 1 from public.teams where id = v_team) then raise exception 'unknown_team'; end if;
        else
            v_name := btrim(coalesce(r ->> 'new_team_name', ''));
            if v_name = '' then raise exception 'invalid_rows'; end if;
            select id into v_team from public.teams where fd_team_id is null and lower(name) = lower(v_name) limit 1;
            if v_team is null then
                insert into public.teams (name) values (v_name) returning id into v_team;
            end if;
        end if;
        v_teams := v_teams || v_team;
    end loop;

    -- positions must be exactly 1..N, each team once
    if (select count(distinct p) from unnest(v_positions) p) <> v_n
        or (select min(p) from unnest(v_positions) p) <> 1
        or (select max(p) from unnest(v_positions) p) <> v_n then
        raise exception 'invalid_rows';
    end if;
    if (select count(distinct t) from unnest(v_teams) t) <> v_n then
        raise exception 'duplicate_team';
    end if;

    delete from public.standings where league_season_id = v_ls.id;
    delete from public.season_teams where league_season_id = v_ls.id;

    for i in 1 .. v_n loop
        insert into public.season_teams (league_season_id, team_id) values (v_ls.id, v_teams[i]);
        insert into public.standings (league_season_id, team_id, position)
        values (v_ls.id, v_teams[i], v_positions[i]);
    end loop;

    -- A saved table for a season before the current one is final: conclude it now.
    update public.league_seasons
    set status = 'concluded'
    where id = v_ls.id
        and season_year < coalesce((select season_year from public.seasons where is_current), 0);
end;
$$;

revoke execute on function public.core_set_manual_standings(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.core_set_manual_standings(uuid, jsonb) to service_role;

-- Seasons whose table was saved before this change
update public.league_seasons ls
set status = 'concluded'
where ls.is_manual
    and ls.status <> 'concluded'
    and ls.season_year < coalesce((select season_year from public.seasons where is_current), 0)
    and exists (select 1 from public.standings s where s.league_season_id = ls.id);

-- ============================================================================
-- Hand-made teams have no football-data id and no crest. Setting the id also
-- sets the crest (https://crests.football-data.org/<id>.png), so the later
-- API sync (which upserts on fd_team_id) lines up with the same row.
-- Errors: not_found, already_set, invalid_id, fd_id_taken.
-- ============================================================================

create or replace function public.core_set_team_fd_id(p_team_id uuid, p_fd_team_id int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_team public.teams;
begin
    if p_fd_team_id is null or p_fd_team_id <= 0 then raise exception 'invalid_id'; end if;

    select * into v_team from public.teams where id = p_team_id for update;
    if not found then raise exception 'not_found'; end if;
    if v_team.fd_team_id is not null then raise exception 'already_set'; end if;
    if exists (select 1 from public.teams where fd_team_id = p_fd_team_id) then raise exception 'fd_id_taken'; end if;

    update public.teams
    set fd_team_id = p_fd_team_id,
        crest = 'https://crests.football-data.org/' || p_fd_team_id || '.png'
    where id = p_team_id;
end;
$$;

revoke execute on function public.core_set_team_fd_id(uuid, int) from public, anon, authenticated;
grant execute on function public.core_set_team_fd_id(uuid, int) to service_role;

create or replace function public.admin_set_team_fd_id(p_team_id uuid, p_fd_team_id int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_admin() then raise exception 'forbidden'; end if;
    perform public.core_set_team_fd_id(p_team_id, p_fd_team_id);
end;
$$;

revoke execute on function public.admin_set_team_fd_id(uuid, int) from public, anon;
grant execute on function public.admin_set_team_fd_id(uuid, int) to authenticated, service_role;
