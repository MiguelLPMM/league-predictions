-- 0009: a stable colour per person for the history charts
--
-- HOW TO RUN: Supabase SQL Editor -> paste -> Run. Safe to re-run. Requires 0001-0008.
--
-- The 12 chart colours are a fixed palette (in public/js/historyChart.js); this only stores
-- WHICH one each identity has, so a person keeps the same colour in every league and chart:
--   * an account: profiles.chart_color, assigned when the profile is created
--   * an unclaimed guest: entries.guest_color, shared by all rows of that guest_key
-- next_chart_color() picks the least-used palette index (lowest index on ties), so nobody
-- repeats a colour until more than 12 people exist. When a guest is merged into an account,
-- the account takes over the guest's colour (just as it takes over the display name).
-- Existing accounts and guests are given colours below, oldest first.

alter table public.profiles add column if not exists chart_color smallint;
alter table public.entries add column if not exists guest_color smallint;

alter table public.profiles drop constraint if exists profiles_chart_color_range;
alter table public.profiles add constraint profiles_chart_color_range check (chart_color is null or chart_color between 0 and 11);
alter table public.entries drop constraint if exists entries_guest_color_range;
alter table public.entries add constraint entries_guest_color_range check (guest_color is null or guest_color between 0 and 11);

create or replace function public.next_chart_color()
returns smallint
language sql
stable
set search_path = public
as $$
    with used as (
        select chart_color as c from public.profiles where chart_color is not null
        union all
        select guest_color as c from (
            select distinct on (guest_key) guest_key, guest_color
            from public.entries
            where user_id is null and guest_color is not null
            order by guest_key
        ) g
    ),
    palette as (select generate_series(0, 11) as c)
    select p.c::smallint
    from palette p
    left join (select c, count(*) as n from used group by c) u on u.c = p.c
    order by coalesce(u.n, 0), p.c
    limit 1;
$$;

grant execute on function public.next_chart_color() to service_role;

-- give everyone who exists already a colour, oldest first (each pick sees the earlier ones)
do $$
declare
    r record;
begin
    for r in select id from public.profiles where chart_color is null order by created_at, id
    loop
        update public.profiles set chart_color = public.next_chart_color() where id = r.id;
    end loop;

    for r in
        select guest_key from public.entries
        where user_id is null and guest_key is not null
        group by guest_key
        having bool_or(guest_color is null)
        order by min(created_at), guest_key
    loop
        update public.entries
        set guest_color = coalesce(
            (select e2.guest_color from public.entries e2 where e2.guest_key = r.guest_key and e2.user_id is null and e2.guest_color is not null limit 1),
            public.next_chart_color())
        where user_id is null and guest_key = r.guest_key and guest_color is null;
    end loop;
end
$$;

-- new accounts get a colour
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_name text := coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', new.email);
begin
    insert into public.profiles (id, name, display_name, avatar_url, chart_color)
    values (new.id, v_name, v_name, new.raw_user_meta_data ->> 'avatar_url', public.next_chart_color())
    on conflict (id) do nothing;
    return new;
end;
$$;

-- a guest's first entry picks a colour; later entries reuse it
create or replace function public.core_import_guest_entry(
    p_guest_key text,
    p_display_name text,
    p_league_season_id uuid,
    p_team_ids uuid[],
    p_late_gameweek int
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_entry_id uuid;
    v_expected int;
    v_name text := btrim(coalesce(p_display_name, ''));
    v_color smallint;
begin
    if p_guest_key is null or p_guest_key !~ '^[a-z0-9_-]+$' then raise exception 'invalid_guest_key'; end if;
    if v_name = '' then raise exception 'name_required'; end if;
    if coalesce(p_late_gameweek, 0) < 0 or coalesce(p_late_gameweek, 0) > 100 then raise exception 'invalid_weeks'; end if;
    if not exists (select 1 from public.league_seasons where id = p_league_season_id) then raise exception 'not_found'; end if;

    select count(*) into v_expected from public.season_teams where league_season_id = p_league_season_id;
    if v_expected = 0
        or coalesce(array_length(p_team_ids, 1), 0) <> v_expected
        or (select count(distinct t) from unnest(p_team_ids) t) <> v_expected
        or exists (
            select 1 from unnest(p_team_ids) t
            where t not in (select team_id from public.season_teams where league_season_id = p_league_season_id)
        ) then
        raise exception 'invalid_teams';
    end if;

    select id into v_entry_id from public.entries
    where user_id is null and guest_key = p_guest_key and league_season_id = p_league_season_id;

    if v_entry_id is null then
        -- one colour per guest identity: reuse the one this guest already has, else assign the next free one
        select guest_color into v_color from public.entries
        where user_id is null and guest_key = p_guest_key and guest_color is not null limit 1;
        v_color := coalesce(v_color, public.next_chart_color());

        insert into public.entries (league_season_id, user_id, guest_key, guest_display_name, entry_mode, late_gameweek, guest_color)
        values (p_league_season_id, null, p_guest_key, v_name, 'fixed_rank', coalesce(p_late_gameweek, 0), v_color)
        returning id into v_entry_id;
    else
        update public.entries
        set late_gameweek = coalesce(p_late_gameweek, 0), updated_at = now()
        where id = v_entry_id;
        delete from public.entry_picks where entry_id = v_entry_id;
    end if;

    update public.entries set guest_display_name = v_name where user_id is null and guest_key = p_guest_key;

    for i in 1 .. v_expected loop
        insert into public.entry_picks (entry_id, position, team_id) values (v_entry_id, i, p_team_ids[i]);
    end loop;

    return v_entry_id;
end;
$$;

-- a merge hands the guest's colour to the account
create or replace function public.core_merge_guest_key(p_guest_key text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_entry record;
    v_merged int := 0;
    v_overwritten jsonb := '[]'::jsonb;
    v_guest_name text;
    v_guest_color smallint;
begin
    if not exists (select 1 from public.profiles where id = p_user_id) then raise exception 'user_not_found'; end if;

    -- read before the loop reassigns user_id (which would hide these rows)
    select guest_display_name, guest_color into v_guest_name, v_guest_color
    from public.entries where guest_key = p_guest_key and user_id is null limit 1;

    for v_entry in
        select e.id, e.league_season_id, ls.league, ls.season_year
        from public.entries e join public.league_seasons ls on ls.id = e.league_season_id
        where e.guest_key = p_guest_key and e.user_id is null
    loop
        if exists (select 1 from public.entries where user_id = p_user_id and league_season_id = v_entry.league_season_id) then
            delete from public.entries where user_id = p_user_id and league_season_id = v_entry.league_season_id;
            v_overwritten := v_overwritten || jsonb_build_object('league', v_entry.league, 'season_year', v_entry.season_year);
        end if;
        update public.entries set user_id = p_user_id where id = v_entry.id;
        v_merged := v_merged + 1;
    end loop;

    if v_merged = 0 then raise exception 'no_guest_entries'; end if;

    if v_guest_name is not null then
        update public.profiles set display_name = v_guest_name where id = p_user_id;
    end if;
    -- the person keeps the colour everyone already knew them by
    if v_guest_color is not null then
        update public.profiles set chart_color = v_guest_color where id = p_user_id;
    end if;

    update public.guest_claim_requests
    set status = 'rejected', resolved_at = now()
    where guest_key = p_guest_key and status = 'pending';

    -- Carry over favorites of the guest identity to the now-real account, unless the
    -- favoriter already favorited that account separately, or the favoriter IS the
    -- account being merged (you can't favorite yourself). Those cases are just dropped.
    update public.favorites
    set favorite_user_id = p_user_id, favorite_guest_key = null
    where favorite_guest_key = p_guest_key
        and user_id <> p_user_id
        and not exists (
            select 1 from public.favorites f2
            where f2.user_id = favorites.user_id and f2.favorite_user_id = p_user_id
        );
    delete from public.favorites where favorite_guest_key = p_guest_key;

    return jsonb_build_object('merged', v_merged, 'overwritten', v_overwritten);
end;
$$;

revoke execute on function public.core_import_guest_entry(text, text, uuid, uuid[], int) from public, anon, authenticated;
grant execute on function public.core_import_guest_entry(text, text, uuid, uuid[], int) to service_role;
revoke execute on function public.core_merge_guest_key(text, uuid) from public, anon, authenticated;
grant execute on function public.core_merge_guest_key(text, uuid) to service_role;
