import { supabaseClient } from './supabaseClient.js';
import { notifyNext } from './notify.js';

export async function getUser() {
    const { data } = await supabaseClient.auth.getSession();
    return data.session?.user ?? null;
}

export async function getAccessToken() {
    const { data } = await supabaseClient.auth.getSession();
    return data.session?.access_token ?? null;
}

// cb(user | null) fires now and on every sign-in / sign-out.
export function onUser(cb) {
    getUser().then(cb);
    supabaseClient.auth.onAuthStateChange((_event, session) => cb(session?.user ?? null));
}

export async function signInWithGoogle() {
    notifyNext('Signed in');
    const { error } = await supabaseClient.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.href.split('#')[0].split('?')[0] },
    });
    if (error) console.error('sign in', error);
}

export async function signOut() {
    notifyNext('Signed out');
    await supabaseClient.auth.signOut();
    window.location.reload();
}

export const userName = (u) => u?.user_metadata?.full_name || u?.user_metadata?.name || u?.email || 'You';
export const userAvatar = (u) => u?.user_metadata?.avatar_url || u?.user_metadata?.picture || '';
