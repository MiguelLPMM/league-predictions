// Leaderboard page: season selector plus the three views - per-user breakdown,
// actual table (users scroll sideways) and the ranked leaderboard - and a
// drill-down with one user's full predicted table. Scoring lives in scoring.js;
// who can see what is enforced by RLS (entries stay hidden until the reveal).
import { onUser } from './auth.js';
import { initShell, lastLeague, LEAGUE_SLUGS, setNavSeason } from './shell.js';
import { leagueLogo } from './leagues.js';
import { mountHistoryChart } from './historyChart.js';
import { loadLeagueHistory } from './api/history.js';
import { computeOffsets, formatOff } from './scoring.js';
import { getFavorites, addFavoriteUser, removeFavoriteUser, addFavoriteGuest, removeFavoriteGuest } from './api/favorites.js';
import {
    getLeague, getCurrentSeasonYear, listLeagueSeasons, getStandings,
    getSeasonTeams, getEntries, getProfiles,
} from './api/leaderboard.js';

// The page is exactly as tall as the visible screen. In the installed app 100dvh can be taller than
// what is visible (system bars), which hid the bottom of the table until something resized the
// window, so measure the real height and follow every change of it.
const fitScreen = () => document.documentElement.style.setProperty('--app-h', window.innerHeight + 'px');
fitScreen();
window.addEventListener('resize', fitScreen);
window.addEventListener('orientationchange', () => setTimeout(fitScreen, 200));
window.visualViewport?.addEventListener('resize', fitScreen);
window.addEventListener('load', () => { fitScreen(); setTimeout(fitScreen, 300); });
window.addEventListener('pageshow', fitScreen);

const params = new URLSearchParams(location.search);
const requested = params.get('league');
const LEAGUE = LEAGUE_SLUGS.includes(requested) ? requested : lastLeague();

let currentView = null; // the view on screen (a re-render must not fall back to ?view=)
const VIEW_KEY = 'leaderboardView';
const VIEWS = ['breakdown', 'table', 'live', 'history'];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
    user: null,
    seasons: [],       // league_seasons rows, newest first
    seasonYear: null,  // selected
    data: null,        // loaded leaderboard for the selected season
    history: null,     // everyone's per-season scores in this league (History view)
    favUsers: new Set(),   // favorited accounts (signed-in only)
    favGuests: new Set(),  // favorited guest keys
};

initShell({ league: LEAGUE, page: 'leaderboard' });

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => console.error('sw register', err));
    });
}

/* -------- view switcher -------- */

function selectedView() {
    const fromUrl = params.get('view');
    if (VIEWS.includes(fromUrl)) return fromUrl;
    try {
        const v = localStorage.getItem(VIEW_KEY);
        if (VIEWS.includes(v)) return v;
    } catch { /* storage unavailable */ }
    return 'breakdown';
}

function setView(view) {
    currentView = view;
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* storage unavailable */ }
    for (const v of VIEWS) $(`lb-${v}`).hidden = v !== view || !state.data;
    document.querySelectorAll('.view-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
    if (view === 'history' && state.data) showHistory();
}

// History view: everyone's score per season in this league, the selected season highlighted.
// Loaded on first use and kept until the signed-in user changes.
let historyChart = null;
async function showHistory() {
    const box = $('lb-history');
    if (!state.history) {
        box.innerHTML = '<p class="lb-gate">Loading…</p>';
        try {
            state.history = await loadLeagueHistory(LEAGUE, state.user?.id);
        } catch (e) {
            console.error('history', e);
            box.innerHTML = '<p class="lb-gate">Could not load the history.</p>';
            return;
        }
        historyChart = null;
    }
    if (currentView !== 'history') return; // the user moved on while it loaded
    if (!historyChart) {
        box.innerHTML = '';
        historyChart = mountHistoryChart(box, state.history, { selectedYear: state.seasonYear, height: 340 });
    } else {
        historyChart.setSelectedYear(state.seasonYear);
    }
}

function showGate(message) {
    state.data = null;
    $('lb-tabs').hidden = true;
    for (const v of VIEWS) $(`lb-${v}`).hidden = true;
    $('lb-gate').textContent = message;
    $('lb-gate').hidden = false;
}

/* -------- loading -------- */

async function init() {
    const league = await getLeague(LEAGUE).catch(() => null);
    renderHeader(league);

    try {
        state.seasons = await listLeagueSeasons(LEAGUE);
    } catch (e) {
        console.error('seasons', e);
        showGate('Could not load the leaderboard, please try again later.');
        return;
    }

    const wanted = Number(params.get('season'));
    const current = await getCurrentSeasonYear().catch(() => null);
    const years = state.seasons.map((s) => s.season_year);
    state.seasonYear = years.includes(wanted) ? wanted : years.includes(current) ? current : years[0];
    renderSeasonSelect();
    announceSeason();

    document.querySelectorAll('.view-tab').forEach((tab) => tab.addEventListener('click', () => setView(tab.dataset.view)));

    let previous; // undefined = not known yet, null = signed out
    onUser((user) => {
        const id = user ? user.id : null;
        state.user = user;
        if (previous === undefined) {
            previous = id;
            load();
        } else if (id !== previous) {
            previous = id;
            state.history = null;
            load();
        }
    });
}

function renderHeader(league) {
    if (league) document.title = `${league.name} Leaderboard`;
    $('header').innerHTML = `
        <div class="title">
            <img class="league-logo" src="${leagueLogo(LEAGUE)}" alt="" onerror="this.style.display='none'">
            <h1>${esc(league?.name || 'Leaderboard')}</h1>
        </div>
        <div class="actions"><select id="season-select" class="season-select" aria-label="Season" hidden></select></div>`;
}

// The season on screen becomes the address (a season the league doesn't have was replaced by
// a default) and is carried by the league links, so switching league keeps it.
function announceSeason() {
    const url = new URL(location.href);
    url.searchParams.set('league', LEAGUE);
    url.searchParams.set('season', state.seasonYear);
    history.replaceState(null, '', url.search);
    setNavSeason(state.seasonYear);
}

function renderSeasonSelect() {
    const select = $('season-select');
    if (!select || !state.seasons.length) return;
    select.innerHTML = state.seasons.map((s) =>
        `<option value="${s.season_year}">${esc(s.seasons?.label || s.season_year)}</option>`).join('');
    select.value = String(state.seasonYear);
    select.hidden = false;
    select.addEventListener('change', () => {
        state.seasonYear = Number(select.value);
        announceSeason();
        load();
    });
}

async function load() {
    const ls = state.seasons.find((s) => s.season_year === state.seasonYear);
    $('lb-gate').hidden = true;
    if (!ls) { showGate('No data recorded for this season.'); return; }

    const revealed = ls.reveal_unlocked || ls.status === 'concluded'
        || (ls.first_kickoff_at && Date.parse(ls.first_kickoff_at) <= Date.now());
    if (!revealed) { showGate('The leaderboard unlocks once the first match kicks off.'); return; }

    let standings, teams, entries;
    try {
        [standings, teams, entries] = await Promise.all([
            getStandings(ls.id), getSeasonTeams(ls.id), getEntries(ls.id),
        ]);
    } catch (e) {
        console.error('leaderboard', e);
        showGate('Could not load the leaderboard, please try again later.');
        return;
    }
    if (!standings.length) { showGate('No standings recorded yet for this season.'); return; }
    if (!entries.length) { showGate('No one has a prediction recorded for this league yet.'); return; }

    const profiles = await getProfiles([...new Set(entries.map((e) => e.user_id).filter(Boolean))]).catch(() => new Map());
    const actualRank = new Map(standings.map((s) => [s.team_id, s.position]));
    try {
        const favs = await getFavorites(state.user?.id);
        state.favUsers = favs.userIds;
        state.favGuests = favs.guestKeys;
    } catch (e) {
        console.error('favorites', e);
    }

    const results = entries.map((entry) => {
        const picks = [...entry.entry_picks].sort((a, b) => a.position - b.position);
        const predictedRank = new Map(picks.map((p) => [p.team_id, p.position]));
        const profile = profiles.get(entry.user_id);
        return {
            entry,
            // guests (no account) carry their own name; real accounts use their display name
            name: (entry.user_id ? profile?.display_name : entry.guest_display_name) || 'Player',
            avatar: profile?.avatar_url || '',
            isSelf: Boolean(state.user && entry.user_id === state.user.id),
            picks,
            ...computeOffsets(predictedRank, standings),
        };
    });

    state.data = { ls, standings, teams, actualRank, results };
    $('lb-tabs').hidden = false;
    renderAll();
    setView(currentView || selectedView());
}

/* -------- rendering -------- */

const isFavorite = (r) => (r.entry.user_id ? state.favUsers.has(r.entry.user_id) : state.favGuests.has(r.entry.guest_key));

// You first, then your favorites, then everyone else. Each group stays in
// submission order (the query already returns entries that way).
function columnOrder(results) {
    const others = results.filter((r) => !r.isSelf);
    return [...results.filter((r) => r.isSelf), ...others.filter(isFavorite), ...others.filter((r) => !isFavorite(r))];
}

// the person's photo, or a plain circle of the same size when they have none
const avatarHtml = (url) => (url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer">` : '<span class="avatar-blank" aria-hidden="true"></span>');

function chipHtml(r, { avatar }) {
    const badge = r.entry.late_gameweek ? `<span class="lb-badge">GW ${r.entry.late_gameweek}</span>` : '';
    const img = avatar ? avatarHtml(r.avatar) : '';
    // favoriting needs an account, and you never favorite yourself
    const fav = isFavorite(r);
    const star = state.user && !r.isSelf
        ? `<button class="fav-star${fav ? ' active' : ''}" data-fav-entry="${r.entry.id}" aria-label="${fav ? 'Remove favorite' : 'Add favorite'}"><span class="material-icons">${fav ? 'star' : 'star_border'}</span></button>`
        : '';
    return `<span class="lb-chip" tabindex="0" data-entry="${r.entry.id}">${img}<span class="lb-name">${esc(r.name)}</span>${badge}${star}</span>`;
}

const crestHtml = (team) => (team?.crest ? `<img src="${esc(team.crest)}" alt="" loading="lazy">` : '');
const offHtml = (off) => (off == null ? '—' : off === 0 ? `<b class="bang">0</b>` : formatOff(off));

function renderAll() {
    const { results } = state.data;
    const ranked = [...results].sort((a, b) => (a.total - b.total) || (b.bangOn - a.bangOn));
    const cols = columnOrder(results);
    renderLive(ranked);
    renderTable(cols);
    renderBreakdown(cols);
    document.querySelectorAll('.lb-chip').forEach((chip) => {
        const open = () => openDrilldown(chip.dataset.entry);
        chip.addEventListener('click', open);
        chip.addEventListener('keydown', (e) => { if (e.target === chip && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } });
    });
    document.querySelectorAll('.fav-star').forEach((btn) => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(btn.dataset.favEntry);
    }));
}

async function toggleFavorite(entryId) {
    const r = state.data.results.find((x) => x.entry.id === entryId);
    if (!r || !state.user) return;
    const add = !isFavorite(r);
    try {
        if (r.entry.user_id) {
            if (add) { await addFavoriteUser(state.user.id, r.entry.user_id); state.favUsers.add(r.entry.user_id); }
            else { await removeFavoriteUser(state.user.id, r.entry.user_id); state.favUsers.delete(r.entry.user_id); }
        } else if (add) {
            await addFavoriteGuest(state.user.id, r.entry.guest_key);
            state.favGuests.add(r.entry.guest_key);
        } else {
            await removeFavoriteGuest(state.user.id, r.entry.guest_key);
            state.favGuests.delete(r.entry.guest_key);
        }
    } catch (e) {
        console.error('favorite', e);
        return;
    }
    renderAll();
    setView(currentView || selectedView());
}

function renderLive(ranked) {
    $('lb-live').innerHTML = ranked.map((r, i) => `
        <div class="lb-row${r.isSelf ? ' self' : ''}">
            <span class="lb-rank">${i + 1}</span>
            ${chipHtml(r, { avatar: true })}
            <span class="lb-score">${r.total}</span>
            <span class="lb-bangon">${r.bangOn} bang on</span>
        </div>`).join('');
}

// Rows = the real table; one column per user showing how far off they were.
function renderTable(cols) {
    const { standings, teams } = state.data;
    $('lb-table').innerHTML = `
        <table class="lb-grid lb-table-view">
            <thead><tr><th class="frozen"></th>${cols.map((r) => `<th class="user">${chipHtml(r, { avatar: false })}</th>`).join('')}</tr></thead>
            <tbody>${standings.map((row) => {
                const team = teams.get(row.team_id);
                return `<tr>
                    <td class="frozen"><span class="frozen-inner"><span class="frozen-rank">${row.position}</span>${crestHtml(team)}<span class="frozen-name">${esc(team?.name)}</span></span></td>
                    ${cols.map((r) => `<td class="user">${offHtml(r.offsetByTeamId.get(row.team_id))}</td>`).join('')}
                </tr>`;
            }).join('')}</tbody>
        </table>`;
}

// Rows = each user's own predicted slots 1..N (not the real order); a closing
// Total row shows each user's score and bang-on count.
function renderBreakdown(cols) {
    const { teams, actualRank } = state.data;
    const slots = Math.max(...cols.map((r) => r.picks.length));
    let body = '';
    for (let pos = 1; pos <= slots; pos++) {
        body += `<tr><td class="frozen">${pos}</td>${cols.map((r) => {
            const pick = r.picks[pos - 1];
            if (!pick) return '<td class="user">—</td>';
            const team = teams.get(pick.team_id);
            const actual = actualRank.get(pick.team_id);
            return `<td class="user"><div class="bd-inner"><span class="bd-team">${crestHtml(team)}<span>${esc(team?.name)}</span></span><span class="bd-off">${offHtml(actual == null ? null : pos - actual)}</span></div></td>`;
        }).join('')}</tr>`;
    }
    $('lb-breakdown').innerHTML = `
        <table class="lb-grid lb-breakdown-view">
            <thead><tr><th class="frozen"></th>${cols.map((r) => `<th class="user">${chipHtml(r, { avatar: false })}</th>`).join('')}</tr></thead>
            <tbody>${body}
                <tr class="total"><td class="frozen">Total</td>${cols.map((r) => `<td class="user">${r.total} · ${r.bangOn} bang on</td>`).join('')}</tr>
            </tbody>
        </table>`;
}

/* -------- drill-down -------- */

function openDrilldown(entryId) {
    const r = state.data.results.find((x) => x.entry.id === entryId);
    if (!r) return;
    const { teams, actualRank } = state.data;
    $('drilldown-user').innerHTML = `${avatarHtml(r.avatar)}<span class="lb-name">${esc(r.name)}</span>${r.entry.late_gameweek ? `<span class="lb-badge">GW ${r.entry.late_gameweek}</span>` : ''}`;
    $('drilldown-body').innerHTML = r.picks.map((p) => {
        const team = teams.get(p.team_id);
        const actual = actualRank.get(p.team_id);
        return `<tr><td>${p.position}</td><td>${crestHtml(team)}</td><td class="left">${esc(team?.name)}</td><td>${offHtml(actual == null ? null : p.position - actual)}</td></tr>`;
    }).join('');
    $('drilldown').showModal();
    showDrilldownHistory(r);
}

// The same player's score in every season of this league, under their name.
let drilldownChart = null;
async function showDrilldownHistory(r) {
    const box = $('drilldown-history');
    drilldownChart?.destroy();
    drilldownChart = null;
    box.innerHTML = '';
    try {
        if (!state.history) state.history = await loadLeagueHistory(LEAGUE, state.user?.id);
    } catch (e) {
        console.error('drill-down history', e);
        return;
    }
    if (!$('drilldown').open) return; // closed while it loaded
    const key = r.entry.user_id ? `u:${r.entry.user_id}` : `g:${r.entry.guest_key}`;
    const mine = state.history.series.find((s) => s.key === key);
    if (!mine) return;
    const first = mine.points[0].year;
    drilldownChart = mountHistoryChart(box, {
        seasons: state.history.seasons.filter((s) => s.year >= first),
        series: [mine],
    }, { selectedYear: state.seasonYear, height: 210, legend: false, note: false });
}

$('drilldown-close').addEventListener('click', () => $('drilldown').close());
$('drilldown').addEventListener('close', () => { drilldownChart?.destroy(); drilldownChart = null; });
$('drilldown').addEventListener('click', (e) => { if (e.target === $('drilldown')) $('drilldown').close(); });

init();
