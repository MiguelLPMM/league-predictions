// set by each page: window.LEAGUE_PAGE = 'premierleague' | 'laliga' | ...
const LEAGUE = (window.LEAGUE_PAGE || 'premierleague').toLowerCase();

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => console.error('sw register', err));
    });
}

const navLinks = [
    ['premierleague', 'Premier League'],
    ['laliga', 'La Liga'],
    ['bundesliga', 'Bundesliga'],
    ['seriea', 'Serie A'],
    ['ligue1', 'Ligue 1'],
    ['ligaportugal', 'Liga Portugal'],
];

const list = document.getElementById('list');
const header = document.getElementById('header');

// build navbar
const nav = document.getElementById('nav');
if (nav) {
    nav.innerHTML = navLinks.map(([slug, label]) =>
        `<a href="/${slug}.html" class="${slug === LEAGUE ? 'active' : ''}">${label}</a>`
    ).join('');
}

window.addEventListener('DOMContentLoaded', init);

async function init() {
    const info = await loadLeagueInfo(LEAGUE);
    if (info) {
        document.title = `${info.name} Prediction`;
        ensureFavicon(info.emblem);

        header.innerHTML = `
        <div class="title">
            <img class="league-logo" src="${esc(info.emblem || '')}" alt="">
            <h1>${esc(info.name)}</h1>
        </div>
        <div class="actions">
            <button id="copy-standings" class="copy-btn" aria-label="Copy standings">
            <span class="material-icons">content_copy</span>
            </button>
        </div>
        `;

        document.getElementById('copy-standings')
            .addEventListener('click', copyStandings);
    }

    await loadTeams(LEAGUE);
}

async function loadLeagueInfo(slug) {
    try {
        const r = await fetch(`/api/league/${slug}`);
        if (!r.ok) throw new Error(`league ${r.status}`);
        return await r.json();
    } catch (e) {
        console.error('league info', e);
        return null;
    }
}

async function loadTeams(slug) {
    try {
        const r = await fetch(`/api/teams/${slug}`);
        if (!r.ok) throw new Error(`teams ${r.status}`);
        const raw = await r.json();
        const teams = (raw || []).map(t => ({ id: t.id ?? '', name: t.name ?? 'Unknown', badge: t.badge ?? '' }));
        render(teams);
    } catch (e) {
        console.error('teams error', e);
        list.innerHTML = `<li class="item"><span class="pos">–</span><div class="card"><span class="name">Error loading teams</span></div></li>`;
    }
}

function render(teams) {
    list.innerHTML = teams.map((t, i) => `
    <li class="item" data-id="${esc(t.id)}">
      <span class="pos">${i + 1}</span>
      <div class="card">
        ${t.badge ? `<img class="badge" src="${esc(t.badge)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
        <span class="name">${esc(t.name)}</span>
      </div>
    </li>
  `).join('');
    renumber();
    enableSortable(list, renumber);
}

function renumber() {
    let n = 1;
    for (const li of list.children) {
        if (li.style.display === 'none') continue; // hidden dragged row
        const pos = li.querySelector('.pos');
        if (pos) pos.textContent = n++;
    }
}

async function copyStandings() {
    const names = [...list.querySelectorAll('.name')].map(el => el.textContent.trim());
    try {
        await navigator.clipboard.writeText(names.join('\n'));
        toast('Copied!');
    } catch { toast('Copy failed'); }
}

function ensureFavicon(url) {
    if (!url) return;
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
    }
    // best guess type (many emblems are SVG)
    if (url.endsWith('.svg')) link.type = 'image/svg+xml';
    link.href = url;
}

// tiny toast
function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        el.className = 'toast';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 1200);
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* -------- Drop-only sortable (Pointer Events) -------- */
function enableSortable(listEl, onChange) {
    let target = null, dragging = null, ghost, placeholder, itemH;
    let startX = 0, startY = 0, fixedX = 0, offsetY = 0, listRect;
    const THRESHOLD = 8, clamp = (v, min, max) => v < min ? min : v > max ? max : v;

    function nextBefore(y) {
        const items = [...listEl.querySelectorAll('li:not(.placeholder)')].filter(el => el !== dragging);
        for (const el of items) { const r = el.getBoundingClientRect(); if (y < r.top + r.height / 2) return el; }
        return null;
    }

    function beginDrag(e) {
        dragging = target; listRect = listEl.getBoundingClientRect();
        placeholder = document.createElement('li');
        placeholder.className = 'item placeholder';
        placeholder.innerHTML = `<span class="pos"></span><div class="card"></div>`;
        itemH = dragging.offsetHeight;
        placeholder.style.height = itemH + 'px';
        dragging.after(placeholder);

        const card = dragging.querySelector('.card');
        const r = card.getBoundingClientRect();
        ghost = card.cloneNode(true);
        ghost.className = (ghost.className + ' drag-ghost').trim();
        ghost.style.width = r.width + 'px';
        document.body.appendChild(ghost);

        fixedX = r.left;
        offsetY = itemH / 2;
        dragging.style.display = 'none';
    }

    function moveDrag(e) {
        listRect = listEl.getBoundingClientRect();
        const top = clamp(e.clientY - offsetY, listRect.top, listRect.bottom - itemH);
        ghost.style.transform = `translate(${fixedX}px, ${top}px)`;
        const y = clamp(e.clientY, listRect.top + 1, listRect.bottom - 1);
        const before = nextBefore(y);
        if (before) listEl.insertBefore(placeholder, before);
        else listEl.appendChild(placeholder);
        onChange && onChange();
    }

    function endDrag() {
        if (!dragging) { target = null; return; }
        listEl.insertBefore(dragging, placeholder);
        dragging.style.display = '';
        placeholder.remove(); ghost.remove();
        dragging = ghost = placeholder = target = null;
        onChange && onChange();
    }

    listEl.addEventListener('pointerdown', e => {
        const li = e.target.closest('li'); if (!li) return;
        e.preventDefault();
        target = li; startX = e.clientX; startY = e.clientY;
        listRect = listEl.getBoundingClientRect();
        li.setPointerCapture(e.pointerId);
    });

    window.addEventListener('pointermove', e => {
        if (!target) return;
        if (!dragging) {
            const dx = e.clientX - startX, dy = e.clientY - startY;
            if (Math.hypot(dx, dy) >= THRESHOLD) beginDrag(e); else return;
        }
        moveDrag(e);
    }, { passive: false });

    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
}
