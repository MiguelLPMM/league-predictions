-- 0006: "matchweek" becomes "gameweek"
--
-- HOW TO RUN: Supabase SQL Editor -> paste -> Run. Safe to re-run. Requires 0001-0005.
--
-- Renames league_seasons.started_matchweek / total_matchweeks and
-- entries.late_matchweek, and redefines the two functions that use them
-- (apply_league_sync now reads started_gameweek / total_gameweeks from the
-- sync payload; save_entry returns late_gameweek).

do $$
begin
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'league_seasons' and column_name = 'started_matchweek') then
        alter table public.league_seasons rename column started_matchweek to started_gameweek;
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'league_seasons' and column_name = 'total_matchweeks') then
        alter table public.league_seasons rename column total_matchweeks to total_gameweeks;
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'entries' and column_name = 'late_matchweek') then
        alter table public.entries rename column late_matchweek to late_gameweek;
    end if;
end
$$;

create or replace function public.apply_league_sync(p_league text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_year int := (p_payload ->> 'season_year')::int;
    v_ls public.league_seasons;
    v_kickoff timestamptz := nullif(p_payload ->> 'first_kickoff_at', '')::timestamptz;
    v_started int := coalesce(nullif(p_payload ->> 'started_gameweek', '')::int, 0);
    v_finished boolean := coalesce((p_payload ->> 'all_finished')::boolean, false);
    v_status text;
    t jsonb;
    s jsonb;
    v_team_id uuid;
begin
    if not exists (select 1 from public.leagues where slug = p_league) or v_year is null then
        raise exception 'unknown league or season';
    end if;

    -- The display name is ours (seeded in 0001/0003); only the emblem comes from the API.
    update public.leagues
    set emblem = coalesce(nullif(p_payload ->> 'league_emblem', ''), emblem)
    where slug = p_league;

    insert into public.seasons (season_year, label)
    values (v_year, v_year || '/' || right((v_year + 1)::text, 2))
    on conflict (season_year) do nothing;

    -- The newest season the API knows about becomes the current one.
    if v_year > coalesce((select max(season_year) from public.seasons where is_current), 0) then
        update public.seasons set is_current = false where is_current;
        update public.seasons set is_current = true where season_year = v_year;
    end if;

    insert into public.league_seasons (league, season_year)
    values (p_league, v_year)
    on conflict (league, season_year) do nothing;

    select * into v_ls from public.league_seasons where league = p_league and season_year = v_year for update;

    -- Manual seasons are owned by the admin; the sync never overwrites them.
    if v_ls.is_manual then
        return;
    end if;

    -- Finished seasons are final: never re-fetched, never rewritten.
    if v_ls.status = 'concluded' and exists (select 1 from public.standings where league_season_id = v_ls.id) then
        update public.league_seasons set synced_at = now() where id = v_ls.id;
        return;
    end if;

    v_status := case
        when v_finished then 'concluded'
        when v_started > 0 or (v_kickoff is not null and v_kickoff <= now()) then 'live'
        else 'upcoming'
    end;

    update public.league_seasons
    set first_kickoff_at = coalesce(v_kickoff, first_kickoff_at),
        started_gameweek = greatest(started_gameweek, v_started),
        total_gameweeks = coalesce(nullif(p_payload ->> 'total_gameweeks', '')::int, total_gameweeks),
        status = case when status = 'concluded' then status else v_status end,
        -- one-way reveal: once kickoff has passed it never flips back
        reveal_unlocked = reveal_unlocked or (v_kickoff is not null and v_kickoff <= now()) or v_started > 0,
        synced_at = now()
    where id = v_ls.id;

    for t in select * from jsonb_array_elements(coalesce(p_payload -> 'teams', '[]'::jsonb))
    loop
        insert into public.teams (fd_team_id, name, crest)
        values ((t ->> 'fd_team_id')::int, t ->> 'name', t ->> 'crest')
        on conflict (fd_team_id) do update set name = excluded.name, crest = excluded.crest
        returning id into v_team_id;

        insert into public.season_teams (league_season_id, team_id)
        values (v_ls.id, v_team_id)
        on conflict do nothing;
    end loop;

    if jsonb_array_length(coalesce(p_payload -> 'standings', '[]'::jsonb)) > 0 then
        delete from public.standings where league_season_id = v_ls.id;
        for s in select * from jsonb_array_elements(p_payload -> 'standings')
        loop
            select id into v_team_id from public.teams where fd_team_id = (s ->> 'fd_team_id')::int;
            continue when v_team_id is null;
            insert into public.standings (
                league_season_id, team_id, position, played, won, draw, lost, points, goals_for, goals_against
            ) values (
                v_ls.id, v_team_id, (s ->> 'position')::int,
                coalesce((s ->> 'played')::int, 0), coalesce((s ->> 'won')::int, 0),
                coalesce((s ->> 'draw')::int, 0), coalesce((s ->> 'lost')::int, 0),
                coalesce((s ->> 'points')::int, 0),
                coalesce((s ->> 'goals_for')::int, 0), coalesce((s ->> 'goals_against')::int, 0)
            );
        end loop;
    end if;
end;
$$;

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
        -- Kickoff has passed, so at least gameweek 1 has started even if the
        -- last sync hasn't recorded it yet.
        if not v_on_time then
            v_badge := greatest(v_ls.started_gameweek, 1);
        end if;

        insert into public.entries (league_season_id, user_id, late_gameweek)
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
        'late_gameweek', v_entry.late_gameweek
    );
end;
$$;
