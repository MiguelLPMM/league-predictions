// Favorites: signed-in only. A favorite targets either a real account
// (favorite_user_id) or a still-unclaimed guest (favorite_guest_key); rows are
// self-managed through RLS. When a favorited guest is merged into an account
// the database carries the favorite over.
import { supabaseClient as sb } from '../supabaseClient.js';

// { userIds: Set<uuid>, guestKeys: Set<string> } - empty for a signed-out caller.
export async function getFavorites(userId) {
    if (!userId) return { userIds: new Set(), guestKeys: new Set() };
    const { data, error } = await sb.from('favorites')
        .select('favorite_user_id, favorite_guest_key').eq('user_id', userId);
    if (error) throw error;

    const userIds = new Set();
    const guestKeys = new Set();
    (data || []).forEach((row) => {
        if (row.favorite_user_id) userIds.add(row.favorite_user_id);
        if (row.favorite_guest_key) guestKeys.add(row.favorite_guest_key);
    });
    return { userIds, guestKeys };
}

const ALREADY_THERE = '23505'; // unique violation: already a favorite, fine

export async function addFavoriteUser(userId, favoriteUserId) {
    const { error } = await sb.from('favorites').insert({ user_id: userId, favorite_user_id: favoriteUserId });
    if (error && error.code !== ALREADY_THERE) throw error;
}

export async function removeFavoriteUser(userId, favoriteUserId) {
    const { error } = await sb.from('favorites').delete().eq('user_id', userId).eq('favorite_user_id', favoriteUserId);
    if (error) throw error;
}

export async function addFavoriteGuest(userId, guestKey) {
    const { error } = await sb.from('favorites').insert({ user_id: userId, favorite_guest_key: guestKey });
    if (error && error.code !== ALREADY_THERE) throw error;
}

export async function removeFavoriteGuest(userId, guestKey) {
    const { error } = await sb.from('favorites').delete().eq('user_id', userId).eq('favorite_guest_key', guestKey);
    if (error) throw error;
}
