-- 0003: keep our own league names
--
-- HOW TO RUN: Supabase SQL Editor -> paste -> Run. Safe to re-run. Requires 0001.
--
-- The sync used to overwrite leagues.name with the API's name ("Primera
-- Division", "Primeira Liga"). Names are ours now; only the emblem is synced.

update public.leagues set name = case slug
    when 'premierleague' then 'Premier League'
    when 'laliga'        then 'La Liga'
    when 'bundesliga'    then 'Bundesliga'
    when 'seriea'        then 'Serie A'
    when 'ligue1'        then 'Ligue 1'
    when 'ligaportugal'  then 'Liga Portugal'
end;

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
    v_started int := coalesce(nullif(p_payload ->> 'started_matchweek', '')::int, 0);
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
        started_matchweek = greatest(started_matchweek, v_started),
        total_matchweeks = coalesce(nullif(p_payload ->> 'total_matchweeks', '')::int, total_matchweeks),
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
