// Cosmetic only: hides the Admin link and page from everyone else. The real
// enforcement is in Postgres (is_admin()) and on the server (lib/admin.js).
export const ADMIN_USER_ID = '91efe307-6226-4d22-889e-8a2a0b6b4ad6';

export const isAdminUser = (user) => Boolean(user && user.id === ADMIN_USER_ID);
