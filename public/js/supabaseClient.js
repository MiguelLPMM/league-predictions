// Loaded after /vendor/supabase.js, which exposes the global `supabase` UMD
// namespace. The URL and publishable key are meant to be public: security is
// enforced by Row Level Security in the database, not by hiding this key. The
// Supabase *secret* key must never appear in this repo's client code.
const SUPABASE_URL = 'https://ftlcqyobrjpndvrgkmnv.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_oonJ2pKgbhSZqT1VAstPrA_ffRmNG47';

export const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { flowType: 'pkce' },
});
