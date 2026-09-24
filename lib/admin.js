const { supabaseAdmin } = require('./supabaseAdmin');

// The single admin account (Supabase user id, not email). Public information;
// what matters is that every admin action re-checks it on the server.
const ADMIN_USER_ID = '91efe307-6226-4d22-889e-8a2a0b6b4ad6';

// Verify a Bearer token and require it to belong to the admin.
async function requireAdmin(token) {
  const { data, error } = await supabaseAdmin().auth.getUser(token || '');
  if (error || !data?.user) {
    const e = new Error('unauthorized'); e.status = 401; e.code = 'unauthorized'; throw e;
  }
  if (data.user.id !== ADMIN_USER_ID) {
    const e = new Error('forbidden'); e.status = 403; e.code = 'forbidden'; throw e;
  }
  return data.user;
}

module.exports = { ADMIN_USER_ID, requireAdmin };
