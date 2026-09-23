// Shared page shell: top bar (hamburger + league selector), hamburger sidebar
// (page links + account) and a confirm dialog. Every page calls initShell() once.
import { onUser, signInWithGoogle, signOut, userName, userAvatar } from './auth.js';
import { showPendingToast } from './notify.js';

const LEAGUES = [
    ['premierleague', 'Premier League'],
    ['laliga', 'La Liga'],
    ['bundesliga', 'Bundesliga'],
    ['seriea', 'Serie A'],
    ['ligue1', 'Ligue 1'],
    ['ligaportugal', 'Liga Portugal'],
];

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initShell({ league }) {
    const bar = document.getElementById('nav');
    if (!bar) return;

    bar.innerHTML = `
        <button class="copy-btn" id="hamburger-toggle" aria-expanded="false" aria-controls="sidebar" aria-label="Open menu">
            <span class="material-icons">menu</span>
        </button>
        <div class="nav-leagues">
            ${LEAGUES.map(([slug, label]) =>
                `<a href="/${slug}.html" class="${slug === league ? 'active' : ''}">${label}</a>`).join('')}
        </div>`;

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
            <a href="/${league}.html" class="active">Predictions</a>
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

    onUser((user) => {
        const account = document.getElementById('sidebar-account');
        if (user) {
            const avatar = userAvatar(user);
            account.innerHTML = `
                <div class="sidebar-user">
                    <div class="sidebar-user-row">
                        ${avatar ? `<img src="${esc(avatar)}" alt="" referrerpolicy="no-referrer">` : ''}
                        <span>${esc(userName(user))}</span>
                    </div>
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
