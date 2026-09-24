-- 0007: guest (no-account) entries, self-serve claiming, admin merge/rename
--
-- HOW TO RUN: Supabase SQL Editor -> paste -> Run. Safe to re-run. Requires 0001-0006.
--
-- A GUEST is a past participant with no account: their entry has user_id = null
-- plus guest_key (stable slug, one per real person, shared across every league
-- and season they have entries in) and guest_display_name. Guest entries are
-- always entry_mode = 'fixed_rank' (never editable through the normal save).
--
-- Claiming: a signed-in user can propose "that guest is me" (guest_claim_requests);
-- the admin approves or rejects. The admin can also merge any account into any
-- guest identity directly. Merging assigns user_id, is authoritative over any
-- entry the account already had for the same league season, and overwrites the
-- account's display_name with the guest's (profiles.name, the real login name,
-- is never touched).
--
-- Admin RPCs follow the 0004 pattern: a service-role-only core_* function holds
-- the logic, and a thin admin_* wrapper checks is_admin() in Postgres.

-- ============================================================================
-- entries: guest columns
-- ============================================================================

alter table public.entries add column if not exists guest_key text;
alter table public.entries add column if not exists guest_display_name text;

alter table public.entries drop constraint if exists entries_user_or_guest;
alter table public.entries add constraint entries_user_or_guest
    check (user_id is not null or (guest_display_name is not null and guest_key is not null));

alter table public.entries drop constraint if exists entries_guest_key_format;
alter table public.entries add constraint entries_guest_key_format
    check (guest_key is null or guest_key ~ '^[a-z0-9_-]+$');

-- one unclaimed entry per guest per league season (real users are already
-- covered by unique (league_season_id, user_id); nulls never collide there)
create unique index if not exists entries_guest_key_unique
    on public.entries (league_season_id, guest_key) where user_id is null;

-- Unclaimed guest rows are just a name + league/season, safe to show to anyone
-- so the claim prompt can list them (their picks stay behind the reveal gate,
-- see the entry_picks policy below).
drop policy if exists "entries: unclaimed guests discoverable" on public.entries;
create policy "entries: unclaimed guests discoverable" on public.entries
    for select using (user_id is null);

-- Picks must no longer simply "follow" entry visibility: guest rows are visible
-- to everyone, their picks are not until the reveal.
drop policy if exists "entry_picks: follow entry" on public.entry_picks;
drop policy if exists "entry_picks: own or revealed" on public.entry_picks;
create policy "entry_picks: own or revealed" on public.entry_picks
    for select using (
        exists (
            select 1 from public.entries e
            where e.id = entry_picks.entry_id
                and (e.user_id = auth.uid() or public.is_revealed(e.league_season_id))
        )
    );

-- ============================================================================
-- claim requests + dismissals
-- ============================================================================

create table if not exists public.guest_claim_requests (
    id uuid primary key default gen_random_uuid(),
    guest_key text not null,
    requested_by_user_id uuid not null references auth.users (id) on delete cascade,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    created_at timestamptz not null default now(),
    resolved_at timestamptz,
    unique (guest_key, requested_by_user_id)
);

-- one active (pending) proposal per user
create unique index if not exists guest_claim_one_pending_per_user
    on public.guest_claim_requests (requested_by_user_id) where status = 'pending';

alter table public.guest_claim_requests enable row level security;

drop policy if exists "claims: requester or admin can read" on public.guest_claim_requests;
create policy "claims: requester or admin can read" on public.guest_claim_requests
    for select using (auth.uid() = requested_by_user_id or public.is_admin());

-- Self-serve is limited to ONE merge per account, ever: someone who already owns
-- a fixed_rank entry (only possible through a merge) can't request another, since a
-- careless approval would overwrite an already-correct entry. Further merges go
-- through the admin's direct tool.
drop policy if exists "claims: request your own" on public.guest_claim_requests;
create policy "claims: request your own" on public.guest_claim_requests
    for insert with check (
        auth.uid() = requested_by_user_id
        and status = 'pending'
        and not exists (
            select 1 from public.entries e
            where e.user_id = requested_by_user_id and e.entry_mode = 'fixed_rank'
        )
    );

drop policy if exists "claims: cancel your own pending" on public.guest_claim_requests;
create policy "claims: cancel your own pending" on public.guest_claim_requests
    for delete using (auth.uid() = requested_by_user_id and status = 'pending');

grant select, insert, delete on public.guest_claim_requests to authenticated;
grant all on public.guest_claim_requests to service_role;

create table if not exists public.guest_claim_dismissals (
    user_id uuid primary key references auth.users (id) on delete cascade,
    dismissed_at timestamptz not null default now()
);

alter table public.guest_claim_dismissals enable row level security;

drop policy if exists "dismissals: self-managed" on public.guest_claim_dismissals;
create policy "dismissals: self-managed" on public.guest_claim_dismissals
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert on public.guest_claim_dismissals to authenticated;
grant all on public.guest_claim_dismissals to service_role;

-- ============================================================================
-- core_import_guest_entry: create or replace a guest's entry for one league season.
--   p_team_ids: the predicted table, position 1 first; must be exactly the
--   season's teams. p_late_gameweek: 0 = on time, otherwise the "weeks late"
--   badge (gameweeks already started when it was submitted outside the app).
-- Re-importing the same (guest_key, season) replaces it. The display name is
-- shared by every unclaimed row of that guest_key.
-- Errors: not_found, invalid_guest_key, name_required, invalid_teams, invalid_weeks.
-- ============================================================================

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
        insert into public.entries (league_season_id, user_id, guest_key, guest_display_name, entry_mode, late_gameweek)
        values (p_league_season_id, null, p_guest_key, v_name, 'fixed_rank', coalesce(p_late_gameweek, 0))
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

-- ============================================================================
-- core_merge_guest_key: link every unclaimed entry of a guest_key to an account.
-- Overwrites the account's own entry for a league season the guest also has (the
-- guest record is authoritative), inherits the guest's display name, and rejects
-- any other pending claims for that key.
-- Errors: user_not_found, no_guest_entries.
-- ============================================================================

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
begin
    if not exists (select 1 from public.profiles where id = p_user_id) then raise exception 'user_not_found'; end if;

    -- read before the loop reassigns user_id (which would hide these rows)
    select guest_display_name into v_guest_name
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

    update public.guest_claim_requests
    set status = 'rejected', resolved_at = now()
    where guest_key = p_guest_key and status = 'pending';

    return jsonb_build_object('merged', v_merged, 'overwritten', v_overwritten);
end;
$$;

-- Approve or reject a claim request (approval performs the merge).
-- Errors: not_found, not_pending (+ the merge errors).
create or replace function public.core_review_guest_claim(p_request_id uuid, p_approve boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_req public.guest_claim_requests;
    v_result jsonb := '{}'::jsonb;
begin
    select * into v_req from public.guest_claim_requests where id = p_request_id for update;
    if not found then raise exception 'not_found'; end if;
    if v_req.status <> 'pending' then raise exception 'not_pending'; end if;

    if p_approve then
        v_result := public.core_merge_guest_key(v_req.guest_key, v_req.requested_by_user_id);
        update public.guest_claim_requests set status = 'approved', resolved_at = now() where id = p_request_id;
    else
        update public.guest_claim_requests set status = 'rejected', resolved_at = now() where id = p_request_id;
    end if;
    return v_result;
end;
$$;

create or replace function public.core_rename_profile(p_user_id uuid, p_display_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if btrim(coalesce(p_display_name, '')) = '' then raise exception 'name_required'; end if;
    update public.profiles set display_name = btrim(p_display_name) where id = p_user_id;
    if not found then raise exception 'not_found'; end if;
end;
$$;

create or replace function public.core_rename_guest(p_guest_key text, p_display_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if btrim(coalesce(p_display_name, '')) = '' then raise exception 'name_required'; end if;
    update public.entries set guest_display_name = btrim(p_display_name)
    where guest_key = p_guest_key and user_id is null;
    if not found then raise exception 'not_found'; end if;
end;
$$;

create or replace function public.core_find_user_by_email(p_email text)
returns table (user_id uuid, name text, display_name text, avatar_url text)
language sql
security definer
set search_path = public
as $$
    select u.id, p.name, p.display_name, p.avatar_url
    from auth.users u join public.profiles p on p.id = u.id
    where lower(u.email) = lower(btrim(p_email));
$$;

revoke execute on function public.core_import_guest_entry(text, text, uuid, uuid[], int) from public, anon, authenticated;
revoke execute on function public.core_merge_guest_key(text, uuid) from public, anon, authenticated;
revoke execute on function public.core_review_guest_claim(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.core_rename_profile(uuid, text) from public, anon, authenticated;
revoke execute on function public.core_rename_guest(text, text) from public, anon, authenticated;
revoke execute on function public.core_find_user_by_email(text) from public, anon, authenticated;
grant execute on function public.core_import_guest_entry(text, text, uuid, uuid[], int) to service_role;
grant execute on function public.core_merge_guest_key(text, uuid) to service_role;
grant execute on function public.core_review_guest_claim(uuid, boolean) to service_role;
grant execute on function public.core_rename_profile(uuid, text) to service_role;
grant execute on function public.core_rename_guest(text, text) to service_role;
grant execute on function public.core_find_user_by_email(text) to service_role;

-- ============================================================================
-- admin wrappers (the only entry points from the browser)
-- ============================================================================

create or replace function public.admin_import_guest_entry(
    p_guest_key text, p_display_name text, p_league_season_id uuid, p_team_ids uuid[], p_late_gameweek int)
returns uuid language plpgsql security definer set search_path = public as $$
begin
    if not public.is_admin() then raise exception 'forbidden'; end if;
    return public.core_import_guest_entry(p_guest_key, p_display_name, p_league_season_id, p_team_ids, p_late_gameweek);
end; $$;

create or replace function public.admin_merge_guest_key(p_guest_key text, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
    if not public.is_admin() then raise exception 'forbidden'; end if;
    return public.core_merge_guest_key(p_guest_key, p_user_id);
end; $$;

create or replace function public.admin_review_guest_claim(p_request_id uuid, p_approve boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
    if not public.is_admin() then raise exception 'forbidden'; end if;
    return public.core_review_guest_claim(p_request_id, p_approve);
end; $$;

create or replace function public.admin_rename_profile(p_user_id uuid, p_display_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
    if not public.is_admin() then raise exception 'forbidden'; end if;
    perform public.core_rename_profile(p_user_id, p_display_name);
end; $$;

create or replace function public.admin_rename_guest(p_guest_key text, p_display_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
    if not public.is_admin() then raise exception 'forbidden'; end if;
    perform public.core_rename_guest(p_guest_key, p_display_name);
end; $$;

create or replace function public.admin_find_user_by_email(p_email text)
returns table (user_id uuid, name text, display_name text, avatar_url text)
language plpgsql security definer set search_path = public as $$
begin
    if not public.is_admin() then raise exception 'forbidden'; end if;
    return query select * from public.core_find_user_by_email(p_email);
end; $$;

revoke execute on function public.admin_import_guest_entry(text, text, uuid, uuid[], int) from public, anon;
revoke execute on function public.admin_merge_guest_key(text, uuid) from public, anon;
revoke execute on function public.admin_review_guest_claim(uuid, boolean) from public, anon;
revoke execute on function public.admin_rename_profile(uuid, text) from public, anon;
revoke execute on function public.admin_rename_guest(text, text) from public, anon;
revoke execute on function public.admin_find_user_by_email(text) from public, anon;
grant execute on function public.admin_import_guest_entry(text, text, uuid, uuid[], int) to authenticated, service_role;
grant execute on function public.admin_merge_guest_key(text, uuid) to authenticated, service_role;
grant execute on function public.admin_review_guest_claim(uuid, boolean) to authenticated, service_role;
grant execute on function public.admin_rename_profile(uuid, text) to authenticated, service_role;
grant execute on function public.admin_rename_guest(text, text) to authenticated, service_role;
grant execute on function public.admin_find_user_by_email(text) to authenticated, service_role;
