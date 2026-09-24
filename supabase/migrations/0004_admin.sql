-- 0004: admin gate + manual season tables (pre-23/24)
--
-- HOW TO RUN: Supabase SQL Editor -> paste -> Run. Safe to re-run. Requires 0001.
--
-- Admin = one hardcoded Supabase user id (no role system). Every admin RPC
-- checks it here in Postgres via is_admin(); the client-side check is only
-- cosmetic. Each RPC is a thin wrapper (admin check) around a service-role-only
-- core function, so the logic can be exercised in tests without the admin's login.

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
    select coalesce(auth.uid() = '91efe307-6226-4d22-889e-8a2a0b6b4ad6'::uuid, false);
$$;

grant execute on function public.is_admin() to anon, authenticated, service_role;

-- ============================================================================
-- Set the final table of a MANUAL season (seasons the free API can't serve).
--   p_rows: [{position, team_id} | {position, new_team_name}]  (positions 1..N)
-- A new_team_name reuses an existing hand-made team with the same name (case
-- insensitive) or creates one (no football-data id). The season's team list
-- becomes exactly the teams in the table.
-- Errors: not_found, not_manual, invalid_rows, duplicate_team, unknown_team.
-- ============================================================================

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
end;
$$;

-- Mark a manual season concluded (needs a saved table) or reopen it.
create or replace function public.core_set_manual_concluded(p_league_season_id uuid, p_concluded boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_ls public.league_seasons;
begin
    select * into v_ls from public.league_seasons where id = p_league_season_id for update;
    if not found then raise exception 'not_found'; end if;
    if not v_ls.is_manual then raise exception 'not_manual'; end if;
    if p_concluded and not exists (select 1 from public.standings where league_season_id = v_ls.id) then
        raise exception 'no_standings';
    end if;
    update public.league_seasons
    set status = case when p_concluded then 'concluded' else 'upcoming' end
    where id = v_ls.id;
end;
$$;

revoke execute on function public.core_set_manual_standings(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.core_set_manual_concluded(uuid, boolean) from public, anon, authenticated;
grant execute on function public.core_set_manual_standings(uuid, jsonb) to service_role;
grant execute on function public.core_set_manual_concluded(uuid, boolean) to service_role;

-- Public entry points (called from the admin page with the admin's own login)
create or replace function public.admin_set_actual_standings(p_league_season_id uuid, p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_admin() then raise exception 'forbidden'; end if;
    perform public.core_set_manual_standings(p_league_season_id, p_rows);
end;
$$;

create or replace function public.admin_set_season_concluded(p_league_season_id uuid, p_concluded boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_admin() then raise exception 'forbidden'; end if;
    perform public.core_set_manual_concluded(p_league_season_id, p_concluded);
end;
$$;

revoke execute on function public.admin_set_actual_standings(uuid, jsonb) from public, anon;
revoke execute on function public.admin_set_season_concluded(uuid, boolean) from public, anon;
grant execute on function public.admin_set_actual_standings(uuid, jsonb) to authenticated, service_role;
grant execute on function public.admin_set_season_concluded(uuid, boolean) to authenticated, service_role;
