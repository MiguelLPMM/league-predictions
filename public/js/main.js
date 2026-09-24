// /predictions?league=premierleague | laliga | bundesliga | seriea | ligue1 | ligaportugal
import { supabaseClient as sb } from './supabaseClient.js';
import { onUser, getAccessToken } from './auth.js';
import { initShell, confirmDialog, lastLeague, LEAGUE_SLUGS } from './shell.js';
import { leagueLogo } from './leagues.js';
import { toast } from './notify.js';

const requested = new URLSearchParams(location.search).get('league');
const LEAGUE = LEAGUE_SLUGS.includes(requested) ? requested : lastLeague();

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => console.error('sw register', err));
    });
}

const list = document.getElementById('list');
const header = document.getElementById('header');

// page state
const state = {
    user: null,
    teams: [],       // default (API) order, used by reset
    ls: null,        // current league_season row (status, kickoff, gameweek)
    entry: null,     // the signed-in user's saved entry for this league season
    saving: false,
};

initShell({ league: LEAGUE });
init();

async function init() {
    const info = await loadLeagueInfo(LEAGUE);
    if (info) {
        document.title = `${info.name} Prediction`;
        ensureFavicon(leagueLogo(LEAGUE));

        header.innerHTML = `
        <div class="title">
            <img class="league-logo" src="${leagueLogo(LEAGUE)}" alt="" onerror="this.style.display='none'">
            <h1>${esc(info.name)}</h1>
        </div>
        <div class="actions">
            <button id="load-entry" class="copy-btn" title="Load my saved entry" aria-label="Load my saved entry" hidden>
            <span class="material-icons">restore</span>
            </button>
            <button id="save-entry" class="copy-btn" title="Save prediction" aria-label="Save prediction" hidden>
            <span class="material-icons">save</span>
            </button>
            <button id="reset-order" class="copy-btn" title="Reset order" aria-label="Reset order">
            <span class="material-icons">refresh</span>
            </button>
            <button id="copy-standings" class="copy-btn" title="Copy standings" aria-label="Copy standings">
            <span class="material-icons">content_copy</span>
            </button>
        </div>
        `;

        document.getElementById('copy-standings').addEventListener('click', copyStandings);
        document.getElementById('reset-order').addEventListener('click', resetOrder);
        document.getElementById('load-entry').addEventListener('click', loadSavedOrder);
        document.getElementById('save-entry').addEventListener('click', onSave);
    }

    await Promise.all([loadTeams(LEAGUE), loadSeason()]);
    updateActions();

    onUser(async (user) => {
        state.user = user;
        await loadEntry();
        updateActions();
    });
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
        state.teams = teams;
        render(teams);
    } catch (e) {
        console.error('teams error', e);
        list.innerHTML = `<li class="item"><span class="pos">–</span><div class="card"><span class="name">Error loading teams</span></div></li>`;
    }
}

/* -------- Season state + saved entry -------- */

async function loadSeason() {
    try {
        const { data: season } = await sb.from('seasons').select('season_year').eq('is_current', true).maybeSingle();
        if (!season) return;
        const { data } = await sb.from('league_seasons')
            .select('id, status, first_kickoff_at, started_gameweek, is_manual')
            .eq('league', LEAGUE).eq('season_year', season.season_year).maybeSingle();
        state.ls = data;
    } catch (e) {
        console.error('season', e);
    }
}

async function loadEntry() {
    state.entry = null;
    if (!state.user || !state.ls) return;
    const { data, error } = await sb.from('entries')
        .select('id, late_gameweek, created_at, updated_at')
        .eq('league_season_id', state.ls.id).eq('user_id', state.user.id).maybeSingle();
    if (error) console.error('entry', error);
    state.entry = data;
}

// 'open' = before first kickoff, 'late' = started but not finished, 'closed'
function phase() {
    const ls = state.ls;
    if (!ls || ls.is_manual || ls.status === 'concluded') return 'closed';
    const kickoff = ls.first_kickoff_at ? Date.parse(ls.first_kickoff_at) : null;
    return !kickoff || Date.now() < kickoff ? 'open' : 'late';
}

// Load/save only exist for signed-in users. Save keeps working as a button in
// every state; when it can't save it explains why instead of disappearing.
function updateActions() {
    const loadBtn = document.getElementById('load-entry');
    const saveBtn = document.getElementById('save-entry');
    if (!loadBtn || !saveBtn) return;

    const { user, entry } = state;
    loadBtn.hidden = !user;
    saveBtn.hidden = !user;
    loadBtn.classList.toggle('dim', !entry);

    const p = phase();
    const locked = p === 'closed' || (p === 'late' && entry);
    saveBtn.classList.toggle('dim', Boolean(locked) || state.saving);
    const label = p === 'closed' ? 'Season finished' : locked ? 'Entry locked' : p === 'late' ? 'Submit late entry' : 'Save prediction';
    saveBtn.title = label;
    saveBtn.setAttribute('aria-label', label);
}

function resetOrder() {
    if (!state.teams.length) return;
    render(state.teams);
    toast('Order reset');
}

async function loadSavedOrder() {
    if (!state.entry) { toast('You have no saved entry yet'); return; }
    const { data, error } = await sb.from('entry_picks')
        .select('team_id, position').eq('entry_id', state.entry.id).order('position');
    if (error || !data?.length) { toast('Could not load your entry'); return; }

    for (const { team_id } of data) {
        const li = list.querySelector(`li[data-id="${team_id}"]`);
        if (li) list.appendChild(li);
    }
    renumber();
    toast('Loaded your saved entry');
}

async function onSave() {
    if (state.saving) return;

    const p = phase();
    if (p === 'closed') { toast('Predictions are closed for this season'); return; }
    if (p === 'late' && state.entry) { toast('Your entry is locked; this list is scratch space'); return; }
    if (p === 'open' && state.entry) {
        const ok = await confirmDialog({
            title: 'Replace your saved prediction?',
            body: 'Your previous saved order will be lost and replaced by what is on screen.',
            confirmLabel: 'Replace',
        });
        if (!ok) return;
    } else if (p === 'late') {
        const gw = Math.max(state.ls.started_gameweek || 0, 1);
        const ok = await confirmDialog({
            title: 'Submit late entry?',
            body: `The season has already started (gameweek ${gw}). A late entry is final: you will not be able to edit it, and it will show a GW ${gw} badge.`,
            confirmLabel: 'Submit',
        });
        if (!ok) return;
    }

    const teamIds = [...list.children].map(li => li.dataset.id).filter(Boolean);
    state.saving = true;
    updateActions();
    try {
        const r = await fetch(`/api/entries/${LEAGUE}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getAccessToken()}` },
            body: JSON.stringify({ teamIds }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        toast(body.mode === 'late' ? `Late entry submitted (GW ${body.late_gameweek})` : 'Prediction saved');
    } catch (e) {
        const msgs = {
            entry_locked: 'Your entry is locked and can no longer be changed',
            season_closed: 'Predictions are closed for this season',
            unauthorized: 'Please sign in again',
        };
        toast(msgs[e.message] || 'Could not save, try again');
        console.error('save', e);
    } finally {
        state.saving = false;
        await loadSeason();
        await loadEntry();
        updateActions();
    }
}

let sortableReady = false;
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
    if (!sortableReady) { enableSortable(list, renumber); sortableReady = true; }
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
    link.type = 'image/png';
    link.href = url;
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
        // only the team box starts a drag: pressing the number (or the gap) must leave the
        // browser free to scroll, and must never move a team
        if (!e.target.closest('.card')) return;
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
