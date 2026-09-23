require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Server-side client using the Supabase SECRET key (bypasses RLS). Never
// import this from anything served to the browser.
let client;
function supabaseAdmin() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY are not set');
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}

module.exports = { supabaseAdmin };
