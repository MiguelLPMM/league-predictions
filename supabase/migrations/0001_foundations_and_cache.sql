-- 0001: foundations + football-data.org cache
--
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query, paste this whole
-- file, click Run. Safe to re-run (idempotent).
--
-- Contents: profiles, leagues, seasons, league_seasons (status / reveal /
-- kickoff / matchweek), teams, season_teams, standings, league_sync_state
-- (throttle), and apply_league_sync() - the only way cached football data is
-- ever written. It is callable ONLY by the server-side service role, never by
-- browsers.
--
-- The project has "auto-expose new tables" OFF, so every grant is explicit.

create extension if not exists pgcrypto;

-- ============================================================================
-- profiles: 1:1 mirror of auth.users so names/avatars are readable by others.
-- name = real Google name (set once); display_name = what is shown everywhere.
-- ============================================================================

create table if not exists public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    name text,
    display_name text,
    avatar_url text,
    created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles are publicly readable" on public.profiles;
create policy "profiles are publicly readable" on public.profiles
    for select using (true);

grant select on public.profiles to anon, authenticated;
grant all on public.profiles to service_role;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_name text := coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', new.email);
begin
    insert into public.profiles (id, name, display_name, avatar_url)
    values (new.id, v_name, v_name, new.raw_user_meta_data ->> 'avatar_url')
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- ============================================================================
-- leagues
-- ============================================================================

create table if not exists public.leagues (
    slug text primary key,
    fd_code text not null unique,
    name text not null,
    emblem text,
    sort_order int not null
);

alter table public.leagues enable row level security;

drop policy if exists "leagues are publicly readable" on public.leagues;
create policy "leagues are publicly readable" on public.leagues
    for select using (true);

grant select on public.leagues to anon, authenticated;
grant all on public.leagues to service_role;

insert into public.leagues (slug, fd_code, name, sort_order) values
    ('premierleague', 'PL',  'Premier League', 1),
    ('laliga',        'PD',  'La Liga',        2),
    ('bundesliga',    'BL1', 'Bundesliga',     3),
    ('seriea',        'SA',  'Serie A',        4),
    ('ligue1',        'FL1', 'Ligue 1',        5),
    ('ligaportugal',  'PPL', 'Liga Portugal',  6)
on conflict (slug) do nothing;

-- ============================================================================
-- seasons: season_year = start year (2025 = 2025/26). is_current = the season
-- the app opens on; at most one row.
-- ============================================================================

create table if not exists public.seasons (
    season_year int primary key,
    label text not null,
    is_current boolean not null default false
);

create unique index if not exists seasons_one_current on public.seasons (is_current) where is_current;

alter table public.seasons enable row level security;

drop policy if exists "seasons are publicly readable" on public.seasons;
create policy "seasons are publicly readable" on public.seasons
    for select using (true);

grant select on public.seasons to anon, authenticated;
grant all on public.seasons to service_role;

insert into public.seasons (season_year, label)
select y, y || '/' || right((y + 1)::text, 2)
from generate_series(2020, 2026) as y
on conflict (season_year) do nothing;

-- 2026/27 is what the API reports today; the sync moves this forward later.
update public.seasons set is_current = true
where season_year = 2026
    and not exists (select 1 from public.seasons where is_current);

-- ============================================================================
-- league_seasons: one row per league + season.
--   status: upcoming -> live -> concluded (never goes backwards)
--   reveal_unlocked: one-way; other people's entries become visible
--   first_kickoff_at: lock time for on-time entries
--   started_matchweek: highest matchday with at least one match kicked off
--   is_manual: final table entered by admin (pre-23/24, not on the free API)
-- ============================================================================

create table if not exists public.league_seasons (
    id uuid primary key default gen_random_uuid(),
    league text not null references public.leagues (slug),
    season_year int not null references public.seasons (season_year),
    status text not null default 'upcoming' check (status in ('upcoming', 'live', 'concluded')),
    reveal_unlocked boolean not null default false,
    first_kickoff_at timestamptz,
    started_matchweek int not null default 0,
    total_matchweeks int,
    is_manual boolean not null default false,
    synced_at timestamptz,
    unique (league, season_year)
);

alter table public.league_seasons enable row level security;

drop policy if exists "league_seasons are publicly readable" on public.league_seasons;
create policy "league_seasons are publicly readable" on public.league_seasons
    for select using (true);

grant select on public.league_seasons to anon, authenticated;
grant all on public.league_seasons to service_role;

-- PL history goes back to 20/21, the other leagues to 21/22. Everything before
-- 23/24 is manual (the free API has no access) and already revealed.
insert into public.league_seasons (league, season_year, is_manual, reveal_unlocked)
select l.slug, s.season_year, s.season_year < 2023, s.season_year < 2023
from public.leagues l
join public.seasons s
    on (l.slug = 'premierleague' and s.season_year >= 2020)
    or (l.slug <> 'premierleague' and s.season_year >= 2021)
on conflict (league, season_year) do nothing;

-- Revealed = flag set by the sync OR kickoff already passed (covers the gap
-- between kickoff and the next sync). Used by later RLS policies.
create or replace function public.is_revealed(p_league_season_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(
        (select ls.reveal_unlocked or (ls.first_kickoff_at is not null and ls.first_kickoff_at <= now())
         from public.league_seasons ls where ls.id = p_league_season_id),
        false
    );
$$;

grant execute on function public.is_revealed(uuid) to anon, authenticated, service_role;

-- ============================================================================
-- teams (global; fd_team_id is null for manually created teams) and the
-- per-season membership. Promotion/relegation just changes membership.
-- ============================================================================

create table if not exists public.teams (
    id uuid primary key default gen_random_uuid(),
    fd_team_id int unique,
    name text not null,
    crest text
);

create table if not exists public.season_teams (
    league_season_id uuid not null references public.league_seasons (id) on delete cascade,
    team_id uuid not null references public.teams (id),
    primary key (league_season_id, team_id)
);

alter table public.teams enable row level security;
alter table public.season_teams enable row level security;

drop policy if exists "teams are publicly readable" on public.teams;
create policy "teams are publicly readable" on public.teams for select using (true);
drop policy if exists "season_teams are publicly readable" on public.season_teams;
create policy "season_teams are publicly readable" on public.season_teams for select using (true);

grant select on public.teams, public.season_teams to anon, authenticated;
grant all on public.teams, public.season_teams to service_role;

-- ============================================================================
-- standings: current partial (live) or final table for a league season.
-- ============================================================================

create table if not exists public.standings (
    league_season_id uuid not null references public.league_seasons (id) on delete cascade,
    team_id uuid not null references public.teams (id),
    position int not null,
    played int not null default 0,
    won int not null default 0,
    draw int not null default 0,
    lost int not null default 0,
    points int not null default 0,
    goals_for int not null default 0,
    goals_against int not null default 0,
    primary key (league_season_id, team_id),
    unique (league_season_id, position)
);

alter table public.standings enable row level security;

drop policy if exists "standings are publicly readable" on public.standings;
create policy "standings are publicly readable" on public.standings for select using (true);

grant select on public.standings to anon, authenticated;
grant all on public.standings to service_role;

-- ============================================================================
-- league_sync_state: throttle. Server-only (no anon/authenticated access).
-- ============================================================================

create table if not exists public.league_sync_state (
    league text primary key references public.leagues (slug),
    last_attempt_at timestamptz,
    last_success_at timestamptz,
    last_error text
);

alter table public.league_sync_state enable row level security;
grant all on public.league_sync_state to service_role;

insert into public.league_sync_state (league)
select slug from public.leagues
on conflict (league) do nothing;

-- Atomically claim the right to sync a league: true only if the last attempt
-- was at least p_min_interval ago. Keeps cron, manual refresh and
-- sync-on-submit from ever calling the API more often than once per interval.
create or replace function public.claim_league_sync(p_league text, p_min_interval interval)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rows int;
begin
    update public.league_sync_state
    set last_attempt_at = now()
    where league = p_league
        and (last_attempt_at is null or last_attempt_at <= now() - p_min_interval);
    get diagnostics v_rows = row_count;
    return v_rows > 0;
end;
$$;

revoke execute on function public.claim_league_sync(text, interval) from public, anon, authenticated;
grant execute on function public.claim_league_sync(text, interval) to service_role;

-- ============================================================================
-- apply_league_sync: one transaction that mirrors a fetched league season.
--
-- p_payload (jsonb) shape:
--   league_name, league_emblem,
--   season_year, first_kickoff_at, started_matchweek, total_matchweeks,
--   all_finished (bool),
--   teams:     [ {fd_team_id, name, crest} ],
--   standings: [ {position, fd_team_id, played, won, draw, lost, points,
--                 goals_for, goals_against} ]
-- ============================================================================

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

    update public.leagues
    set name = coalesce(nullif(p_payload ->> 'league_name', ''), name),
        emblem = coalesce(nullif(p_payload ->> 'league_emblem', ''), emblem)
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

revoke execute on function public.apply_league_sync(text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_league_sync(text, jsonb) to service_role;

-- record the outcome of a sync attempt (server-only)
create or replace function public.record_league_sync_result(p_league text, p_error text)
returns void
language sql
security definer
set search_path = public
as $$
    update public.league_sync_state
    set last_success_at = case when p_error is null then now() else last_success_at end,
        last_error = p_error
    where league = p_league;
$$;

revoke execute on function public.record_league_sync_result(text, text) from public, anon, authenticated;
grant execute on function public.record_league_sync_result(text, text) to service_role;
