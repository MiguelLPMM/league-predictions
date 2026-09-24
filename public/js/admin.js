// Admin page (the account is checked server-side in Postgres and on the API;
// the check here only decides what to show). Sections: refresh a league's
// cached data, and set the final table of a manual (pre-23/24) season.
import { supabaseClient as sb } from './supabaseClient.js';
import { onUser, getAccessToken } from './auth.js';
import { initShell, lastLeague, LEAGUE_SLUGS } from './shell.js';
import { toast } from './notify.js';
import { isAdminUser } from './adminConfig.js';
import { matchTeams } from './teamMatch.js';

const requested = new URLSearchParams(location.search).get('league');
const LEAGUE = LEAGUE_SLUGS.includes(requested) ? requested : lastLeague();

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
    seasons: [],       // manual league_seasons of this league, newest first
    candidates: [],    // teams known for this league (any season)
    matches: [],       // current matching result rows
};

initShell({ league: LEAGUE, page: 'admin' });

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => console.error('sw register', err));
    });
}

onUser((user) => {
    const gate = $('admin-gate');
    if (!user) {
        gate.textContent = 'Sign in from the menu to continue.';
        gate.hidden = false;
        $('admin-content').hidden = true;
    } else if (!isAdminUser(user)) {
        gate.textContent = 'This page is for the admin only.';
        gate.hidden = false;
        $('admin-content').hidden = true;
    } else {
        gate.hidden = true;
        $('admin-content').hidden = false;
        start();
    }
});

let started = false;
async function start() {
    if (started) return;
    started = true;

    const { data: league } = await sb.from('leagues').select('name').eq('slug', LEAGUE).maybeSingle();
    $('league-name').textContent = league?.name || LEAGUE;
    $('league-name-2').textContent = league?.name || LEAGUE;

    $('refresh-btn').addEventListener('click', refreshLeague);
    $('season-pick').addEventListener('change', loadSeason);
    $('match-btn').addEventListener('click', runMatch);
    $('save-table-btn').addEventListener('click', saveTable);
    $('conclude-btn').addEventListener('click', toggleConcluded);

    await loadSeasons();
    await loadMissingIds();
}

/* -------- refresh league data -------- */

async function refreshLeague() {
    const btn = $('refresh-btn');
    btn.disabled = true;
    try {
        const r = await fetch('/api/admin/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getAccessToken()}` },
            body: JSON.stringify({ league: LEAGUE }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        toast(body.synced ? `Refreshed (${body.teams} teams, season ${body.season})` : 'Refreshed less than a minute ago, try again shortly');
    } catch (e) {
        console.error('refresh', e);
        toast('Refresh failed');
    } finally {
        btn.disabled = false;
    }
}

/* -------- manual season table -------- */

async function loadSeasons() {
    const { data, error } = await sb.from('league_seasons')
        .select('id, season_year, status, seasons(label)')
        .eq('league', LEAGUE).eq('is_manual', true)
        .order('season_year', { ascending: false });
    if (error) { toast('Could not load seasons'); console.error(error); return; }
    state.seasons = data;

    const pick = $('season-pick');
    pick.innerHTML = data.map((s) => `<option value="${s.id}">${esc(s.seasons?.label || s.season_year)}</option>`).join('');

    // every team ever seen in this league: the candidates for matching
    const { data: all } = await sb.from('league_seasons').select('id').eq('league', LEAGUE);
    const { data: rows } = await sb.from('season_teams')
        .select('teams(id, name)').in('league_season_id', (all || []).map((x) => x.id));
    state.candidates = [...new Map((rows || []).map((r) => [r.teams.id, r.teams])).values()]
        .sort((a, b) => a.name.localeCompare(b.name));

    if (data.length) await loadSeason();
}

const currentSeason = () => state.seasons.find((s) => s.id === $('season-pick').value);

// Show the season's saved table (if any) in the textarea and its status.
async function loadSeason() {
    const ls = currentSeason();
    if (!ls) return;
    $('match-result').hidden = true;
    renderStatus(ls);

    const { data } = await sb.from('standings')
        .select('position, teams(name)').eq('league_season_id', ls.id).order('position');
    $('table-input').value = (data || []).map((r) => r.teams.name).join('\n');
}

function renderStatus(ls) {
    const concluded = ls.status === 'concluded';
    $('season-status').textContent = concluded ? 'Concluded' : 'Not concluded';
    $('season-status').classList.toggle('done', concluded);
    $('conclude-btn').textContent = concluded ? 'Reopen season' : 'Mark concluded';
}

function typedNames() {
    return $('table-input').value.split('\n').map((l) => l.replace(/^\s*\d+[.)]?\s+/, '').trim()).filter(Boolean);
}

function runMatch() {
    const names = typedNames();
    if (names.length < 2) { toast('Paste at least two teams'); return; }
    state.matches = matchTeams(names, state.candidates);
    renderMatches();
    $('match-result').hidden = false;
}

const NEW = '__new__';

function renderMatches() {
    $('match-rows').innerHTML = state.matches.map((m, i) => `
        <tr data-i="${i}">
            <td>${i + 1}</td>
            <td>${esc(m.input)}</td>
            <td><select data-i="${i}">
                <option value="${NEW}"${m.match ? '' : ' selected'}>＋ New team: ${esc(m.input)}</option>
                ${m.options.map((c) => `<option value="${c.id}"${m.match?.id === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select></td>
        </tr>`).join('');
    $('match-rows').querySelectorAll('select').forEach((sel) => sel.addEventListener('change', flagRows));
    flagRows();
}

// Highlight rows that will create a new team, and rows picking the same team twice.
function flagRows() {
    const chosen = [...$('match-rows').querySelectorAll('select')].map((s) => s.value);
    const counts = chosen.reduce((acc, v) => (v === NEW ? acc : acc.set(v, (acc.get(v) || 0) + 1)), new Map());
    $('match-rows').querySelectorAll('tr').forEach((tr, i) => {
        tr.classList.toggle('is-new', chosen[i] === NEW);
        tr.classList.toggle('is-dup', chosen[i] !== NEW && counts.get(chosen[i]) > 1);
    });
}

async function saveTable() {
    const ls = currentSeason();
    if (!ls) return;
    flagRows();
    if ($('match-rows').querySelector('.is-dup')) { toast('The same team is picked twice'); return; }

    const rows = [...$('match-rows').querySelectorAll('select')].map((sel, i) => (
        sel.value === NEW
            ? { position: i + 1, new_team_name: state.matches[i].input }
            : { position: i + 1, team_id: sel.value }
    ));
    const newCount = rows.filter((r) => r.new_team_name).length;

    const btn = $('save-table-btn');
    btn.disabled = true;
    const { error } = await sb.rpc('admin_set_actual_standings', { p_league_season_id: ls.id, p_rows: rows });
    btn.disabled = false;
    if (error) {
        console.error('save table', error);
        toast(errorMessage(error));
        return;
    }
    toast(`Table saved, season concluded${newCount ? ` (${newCount} new team${newCount === 1 ? '' : 's'} created)` : ''}`);
    await loadSeasons();
    $('season-pick').value = ls.id;
    await loadSeason();
    await loadMissingIds();
}

async function toggleConcluded() {
    const ls = currentSeason();
    if (!ls) return;
    const concluded = ls.status !== 'concluded';
    const { error } = await sb.rpc('admin_set_season_concluded', { p_league_season_id: ls.id, p_concluded: concluded });
    if (error) { console.error('conclude', error); toast(errorMessage(error)); return; }
    ls.status = concluded ? 'concluded' : 'upcoming';
    renderStatus(ls);
    toast(concluded ? 'Season marked concluded' : 'Season reopened');
}

/* -------- hand-made teams: football-data ids -------- */

const crestUrl = (id) => `https://crests.football-data.org/${id}.png`;

async function loadMissingIds() {
    const { data, error } = await sb.from('teams')
        .select('id, name, season_teams(league_seasons(league, season_year))')
        .is('fd_team_id', null)
        .order('name');
    if (error) { console.error('missing ids', error); return; }

    // only teams that appear in this league's seasons
    const rows = (data || [])
        .map((t) => ({
            id: t.id,
            name: t.name,
            years: t.season_teams.map((st) => st.league_seasons).filter((ls) => ls && ls.league === LEAGUE).map((ls) => ls.season_year),
        }))
        .filter((t) => t.years.length);

    $('missing-empty').hidden = rows.length > 0;
    $('missing-table').hidden = rows.length === 0;
    $('missing-rows').innerHTML = rows.map((t) => `
        <tr data-id="${t.id}">
            <td class="crest-cell"><img class="crest-preview" alt="" hidden></td>
            <td>${esc(t.name)}<br><span class="hint-inline">${t.years.sort().map((y) => `${y}/${String(y + 1).slice(-2)}`).join(', ')}</span></td>
            <td><input type="text" inputmode="numeric" class="fd-id-input" placeholder="e.g. 346" maxlength="6"></td>
            <td><button class="btn small fd-id-save" disabled>Save</button></td>
        </tr>`).join('');

    $('missing-rows').querySelectorAll('tr').forEach((tr) => {
        const input = tr.querySelector('input');
        const img = tr.querySelector('img');
        const btn = tr.querySelector('button');
        input.addEventListener('input', () => {
            const valid = /^\d{1,6}$/.test(input.value.trim());
            btn.disabled = !valid;
            img.hidden = !valid;
            if (valid) img.src = crestUrl(input.value.trim());
        });
        // no crest at that address: warn instead of saving a broken image
        img.addEventListener('error', () => { img.hidden = true; btn.disabled = true; toast('No crest found for that id'); });
        btn.addEventListener('click', () => saveFdId(tr.dataset.id, Number(input.value.trim()), btn));
    });
}

async function saveFdId(teamId, fdId, btn) {
    btn.disabled = true;
    const { error } = await sb.rpc('admin_set_team_fd_id', { p_team_id: teamId, p_fd_team_id: fdId });
    if (error) {
        console.error('set fd id', error);
        toast(errorMessage(error));
        btn.disabled = false;
        return;
    }
    toast('Saved, crest updated');
    await loadMissingIds();
}

function errorMessage(error) {
    const text = String(error.message || '');
    const known = {
        forbidden: 'Not allowed',
        no_standings: 'Save the table first',
        duplicate_team: 'The same team is used twice',
        invalid_rows: 'The table is not valid',
        not_manual: 'This season is managed by the API',
        fd_id_taken: 'Another team already has that id',
        already_set: 'That team already has an id',
        invalid_id: 'That is not a valid id',
    };
    const key = Object.keys(known).find((k) => text.includes(k));
    return key ? known[key] : 'Something went wrong';
}
