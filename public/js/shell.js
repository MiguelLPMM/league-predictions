// Shared page shell: top bar (hamburger + league selector), hamburger sidebar
// (page links + account) and a confirm dialog. Every page calls initShell() once.
// page = 'predictions' | 'leaderboard': which page this is, so the league
// selector keeps you on the same kind of page when you switch league.
import { onUser, signInWithGoogle, signOut, userName, userAvatar } from './auth.js';
import { showPendingToast } from './notify.js';
import { isAdminUser } from './adminConfig.js';
import { LEAGUES, LEAGUE_SLUGS, leagueLogo } from './leagues.js';
import { maybeShowGuestClaimPrompt } from './guestClaimPrompt.js';
import { getTheme, setTheme } from './theme.js';

export { LEAGUE_SLUGS };

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function rememberLeague(league) {
    try { localStorage.setItem('league', league); } catch { /* storage unavailable */ }
}

export function lastLeague() {
    try {
        const stored = localStorage.getItem('league');
        if (LEAGUE_SLUGS.includes(stored)) return stored;
    } catch { /* storage unavailable */ }
    return LEAGUE_SLUGS[0];
}

// Pages with a season selector call this so switching league keeps the season:
// the league links in the top bar get &season=<year> (the target page falls back to
// its own default if that league has no such season).
export function setNavSeason(year) {
    document.querySelectorAll('.nav-leagues a[data-base]').forEach((a) => {
        a.href = year ? `${a.dataset.base}&season=${year}` : a.dataset.base;
    });
}

export function initShell({ league, page = 'predictions' }) {
    rememberLeague(league);
    const pageHref = (slug) => `/${page === 'profile' ? 'predictions' : page}?league=${slug}`;
    const bar = document.getElementById('nav');
    if (!bar) return;

    bar.innerHTML = `
        <button class="copy-btn" id="hamburger-toggle" aria-expanded="false" aria-controls="sidebar" aria-label="Open menu">
            <span class="material-icons">menu</span>
        </button>
        <div class="nav-leagues">
            ${LEAGUES.map(([slug, label]) =>
                `<a href="${pageHref(slug)}" data-base="${pageHref(slug)}" class="${slug === league && page !== 'profile' ? 'active' : ''}" title="${label}" aria-label="${label}">` +
                `<img class="nav-logo" src="${leagueLogo(slug)}" alt="" onerror="this.closest('a').classList.add('no-logo')">` +
                `<span class="nav-name">${label}</span></a>`).join('')}
        </div>
        <div class="theme-switch" id="theme-switch"></div>`;

    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    overlay.hidden = true;

    const sidebar = document.createElement('aside');
    sidebar.className = 'sidebar';
    sidebar.id = 'sidebar';
    sidebar.setAttribute('aria-hidden', 'true');
    sidebar.innerHTML = `
        <button class="sidebar-close" id="sidebar-close" aria-label="Close menu">
            <span class="material-icons">close</span>
        </button>
        <div class="sidebar-links">
            <a href="/predictions?league=${league}" class="${page === 'predictions' ? 'active' : ''}">Predictions</a>
            <a href="/leaderboard?league=${league}" class="${page === 'leaderboard' ? 'active' : ''}">Leaderboard</a>
            <a href="/admin?league=${league}" id="nav-admin" class="${page === 'admin' ? 'active' : ''}" hidden>Admin</a>
        </div>
        <div class="sidebar-account" id="sidebar-account"></div>`;
    document.body.append(overlay, sidebar);

    const toggle = document.getElementById('hamburger-toggle');
    const setOpen = (open) => {
        sidebar.classList.toggle('open', open);
        sidebar.setAttribute('aria-hidden', String(!open));
        overlay.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => setOpen(true));
    document.getElementById('sidebar-close').addEventListener('click', () => setOpen(false));
    overlay.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

    renderThemeSwitch();

    onUser((user) => {
        document.getElementById('nav-admin').hidden = !isAdminUser(user);
        maybeShowGuestClaimPrompt(user);
        const account = document.getElementById('sidebar-account');
        if (user) {
            const avatar = userAvatar(user);
            account.innerHTML = `
                <div class="sidebar-user">
                    <a class="sidebar-user-row" href="/profile" title="Your profile">
                        ${avatar ? `<img src="${esc(avatar)}" alt="" referrerpolicy="no-referrer">` : ''}
                        <span>${esc(userName(user))}</span>
                    </a>
                    <button class="sidebar-account-btn" id="sidebar-signout">
                        <span class="material-icons">logout</span> Sign out
                    </button>
                </div>`;
            document.getElementById('sidebar-signout').addEventListener('click', signOut);
        } else {
            account.innerHTML = `
                <button class="sidebar-account-btn" id="sidebar-signin">
                    <span class="material-icons">login</span> Sign in with Google
                </button>`;
            document.getElementById('sidebar-signin').addEventListener('click', signInWithGoogle);
        }
    });

    showPendingToast();
}

// System / Light / Dark as three icon buttons in the top bar. System (the default)
// follows the device setting.
function renderThemeSwitch() {
    const box = document.getElementById('theme-switch');
    const options = [['system', 'brightness_auto', 'Match system'], ['light', 'light_mode', 'Light'], ['dark', 'dark_mode', 'Dark']];
    const draw = () => {
        const current = getTheme();
        box.innerHTML = `<div class="seg" role="group" aria-label="Appearance">${options.map(([value, icon, label]) =>
            `<button data-theme-choice="${value}" class="${value === current ? 'active' : ''}" aria-pressed="${value === current}" aria-label="${label}" title="${label}"><span class="material-icons">${icon}</span></button>`).join('')}</div>`;
        box.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => {
            setTheme(btn.dataset.themeChoice);
            draw();
        }));
    };
    draw();
}

// Promise-based confirm built on <dialog>. Resolves true when confirmed.
export function confirmDialog({ title, body, confirmLabel = 'Confirm' }) {
    return new Promise((resolve) => {
        const dlg = document.createElement('dialog');
        dlg.className = 'confirm';
        dlg.innerHTML = `
            <h2>${esc(title)}</h2>
            <p>${esc(body)}</p>
            <div class="confirm-actions">
                <button class="btn secondary" value="cancel">Cancel</button>
                <button class="btn" value="ok">${esc(confirmLabel)}</button>
            </div>`;
        dlg.addEventListener('click', (e) => {
            const v = e.target.closest('button')?.value;
            if (v) dlg.close(v);
        });
        dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
        document.body.appendChild(dlg);
        dlg.showModal();
    });
}
