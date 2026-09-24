-- 0008: favorites
--
-- HOW TO RUN: Supabase SQL Editor -> paste -> Run. Safe to re-run. Requires 0001-0007.
--
-- A user can favorite other accounts AND still-unclaimed guests (by guest_key).
-- Favorites are plain self-managed rows (RLS: you only ever see/insert/delete your
-- own), signed-in only. When a favorited guest is merged into an account, the
-- favorite carries over to that account (dropped, not erroring, if it would
-- duplicate an existing favorite or become a self-favorite).

create table if not exists public.favorites (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    favorite_user_id uuid references auth.users (id) on delete cascade,
    favorite_guest_key text,
    created_at timestamptz not null default now(),
    constraint favorites_target_check check ((favorite_user_id is not null) <> (favorite_guest_key is not null)),
    constraint favorites_no_self_favorite check (favorite_user_id is null or favorite_user_id <> user_id)
);

create unique index if not exists favorites_user_favorite_user_unique
    on public.favorites (user_id, favorite_user_id) where favorite_user_id is not null;
create unique index if not exists favorites_user_favorite_guest_unique
    on public.favorites (user_id, favorite_guest_key) where favorite_guest_key is not null;

alter table public.favorites enable row level security;

drop policy if exists "favorites: self-managed" on public.favorites;
create policy "favorites: self-managed" on public.favorites
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, delete on public.favorites to authenticated;
grant all on public.favorites to service_role;

-- A rejected request must not block asking again later: uniqueness now only applies to
-- PENDING requests (one pending per user already exists from 0007).
alter table public.guest_claim_requests drop constraint if exists guest_claim_requests_guest_key_requested_by_user_id_key;
create unique index if not exists guest_claim_pending_unique
    on public.guest_claim_requests (guest_key, requested_by_user_id) where status = 'pending';

-- core_merge_guest_key, now also carrying favorites over
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

revoke execute on function public.core_merge_guest_key(text, uuid) from public, anon, authenticated;
grant execute on function public.core_merge_guest_key(text, uuid) to service_role;
