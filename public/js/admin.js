// Admin page (the account is checked server-side in Postgres and on the API;
// the check here only decides what to show). Sections: refresh a league's
// cached data, set the final table of a manual (pre-23/24) season, import guest
// entries, review claim requests, link an account to a guest, rename, and fill
// in football-data ids for hand-made teams.
import { supabaseClient as sb } from './supabaseClient.js';
import { onUser, getAccessToken } from './auth.js';
import { initShell, confirmDialog, lastLeague, LEAGUE_SLUGS } from './shell.js';
import { toast } from './notify.js';
import { isAdminUser } from './adminConfig.js';
import { matchTeams } from './teamMatch.js';
import { seasonLabel } from './leagues.js';
import { listUnclaimedGuestIdentities } from './api/guestClaims.js';
import { describeSeasons } from './guestClaimPrompt.js';

const requested = new URLSearchParams(location.search).get('league');
const LEAGUE = LEAGUE_SLUGS.includes(requested) ? requested : lastLeague();

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
    seasons: [],        // manual league_seasons of this league, newest first
    candidates: [],     // teams known for this league (any season)
    matches: [],        // matching result for the season table
    importSeasons: [],  // every league_season of this league
    importTeams: [],    // teams of the season chosen for a guest import
    importMatches: [],
    identities: [],     // unclaimed guest identities
    foundUser: null,    // account found by email
    renameTargets: new Map(),
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
    document.querySelectorAll('.league-name').forEach((el) => { el.textContent = league?.name || LEAGUE; });

    $('refresh-btn').addEventListener('click', refreshLeague);
    $('season-pick').addEventListener('change', loadSeason);
    $('save-table-btn').addEventListener('click', startSaveTable);
    $('table-confirm-btn').addEventListener('click', confirmTable);
    $('conclude-btn').addEventListener('click', toggleConcluded);

    $('import-season').addEventListener('change', loadImportTeams);
    $('import-key').addEventListener('input', fillNameFromKey);
    $('import-btn').addEventListener('click', startImport);
    $('import-confirm-btn').addEventListener('click', confirmImport);

    $('link-find-btn').addEventListener('click', findUser);
    $('link-btn').addEventListener('click', linkAccount);
    $('rename-btn').addEventListener('click', renameTarget);

    $('import-weeks').innerHTML = Array.from({ length: 39 }, (_, n) =>
        `<option value="${n}">${n === 0 ? 'On time (before the season)' : `Late: ${n} gameweek${n === 1 ? '' : 's'} already started`}</option>`).join('');

    await loadSeasons();
    await loadImportSeasons();
    await loadIdentities();
    await loadClaims();
    await loadRenameTargets();
    await loadMissingIds();
}

/* -------- shared: name matching table -------- */

const NEW = '__new__';   // "create a new team from the typed name" (season table only)

const isOpen = (v) => v === NEW || v === '';

// Highlight rows still open (new team / nothing chosen) and rows picking a team twice.
function flagRows(tbody) {
    const chosen = [...tbody.querySelectorAll('select')].map((s) => s.value);
    const counts = chosen.reduce((acc, v) => (isOpen(v) ? acc : acc.set(v, (acc.get(v) || 0) + 1)), new Map());
    tbody.querySelectorAll('tr').forEach((tr, i) => {
        tr.classList.toggle('is-new', isOpen(chosen[i]));
        tr.classList.toggle('is-dup', !isOpen(chosen[i]) && counts.get(chosen[i]) > 1);
    });
}

function typedNames(textareaId) {
    return $(textareaId).value.split('\n').map((l) => l.replace(/^\s*\d+[.)]?\s+/, '').trim()).filter(Boolean);
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
        invalid_guest_key: 'The guest key can only use lowercase letters, numbers, - and _',
        name_required: 'A name is required',
        invalid_teams: 'The teams do not match this season',
        invalid_weeks: 'Invalid gameweek',
        user_not_found: 'That account was not found',
        no_guest_entries: 'That guest has no unclaimed entries',
        not_pending: 'That request was already handled',
        not_found: 'Not found',
    };
    const key = Object.keys(known).find((k) => text.includes(k));
    return key ? known[key] : 'Something went wrong';
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

    $('season-pick').innerHTML = data.map((s) => `<option value="${s.id}">${esc(s.seasons?.label || s.season_year)}</option>`).join('');

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

// One click: match the pasted names to known teams. If every one matched, save right
// away; otherwise show only the names that didn't match, each defaulting to a new team.
async function startSaveTable() {
    const ls = currentSeason();
    if (!ls) return;
    const names = typedNames('table-input');
    if (names.length < 2) { toast('Paste at least two teams'); return; }

    state.matches = matchTeams(names, state.candidates);
    if (state.matches.every((m) => m.match)) {
        await submitTable(ls, state.matches.map((m) => ({ team_id: m.match.id })));
        return;
    }
    renderTableRows();
    $('match-result').hidden = false;
}

// Only the rows that did not match; their dropdowns exclude teams already matched.
function renderTableRows() {
    const taken = new Set(state.matches.filter((m) => m.match).map((m) => m.match.id));
    const open = state.matches.map((m, i) => ({ m, i })).filter(({ m }) => !m.match);
    $('match-summary').textContent =
        `${state.matches.length - open.length} of ${state.matches.length} teams matched automatically. The rest will be created as new teams unless you pick an existing one.`;
    $('match-rows').innerHTML = open.map(({ m, i }) => `
        <tr data-i="${i}">
            <td>${i + 1}</td>
            <td>${esc(m.input)}</td>
            <td><select data-i="${i}">
                <option value="${NEW}" selected>＋ New team: ${esc(m.input)}</option>
                ${m.options.filter((c) => !taken.has(c.id)).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
            </select></td>
        </tr>`).join('');
    $('match-rows').querySelectorAll('select').forEach((sel) => sel.addEventListener('change', () => flagRows($('match-rows'))));
    flagRows($('match-rows'));
}

async function confirmTable() {
    const ls = currentSeason();
    if (!ls) return;
    flagRows($('match-rows'));
    if ($('match-rows').querySelector('.is-dup')) { toast('The same team is picked twice'); return; }

    const spec = state.matches.map((m) => (m.match ? { team_id: m.match.id } : null));
    $('match-rows').querySelectorAll('select').forEach((sel) => {
        const i = Number(sel.dataset.i);
        spec[i] = sel.value === NEW ? { new_team_name: state.matches[i].input } : { team_id: sel.value };
    });
    await submitTable(ls, spec);
}

async function submitTable(ls, spec) {
    const rows = spec.map((r, i) => ({ position: i + 1, ...r }));
    const newCount = rows.filter((r) => r.new_team_name).length;

    [$('save-table-btn'), $('table-confirm-btn')].forEach((b) => { b.disabled = true; });
    const { error } = await sb.rpc('admin_set_actual_standings', { p_league_season_id: ls.id, p_rows: rows });
    [$('save-table-btn'), $('table-confirm-btn')].forEach((b) => { b.disabled = false; });
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

/* -------- import a guest entry -------- */

async function loadImportSeasons() {
    const { data, error } = await sb.from('league_seasons')
        .select('id, season_year')
        .eq('league', LEAGUE).order('season_year', { ascending: false });
    if (error) { console.error('import seasons', error); return; }
    state.importSeasons = data;
    $('import-season').innerHTML = data.map((s) => `<option value="${s.id}">${esc(seasonLabel(s.season_year))}</option>`).join('');
    if (data.length) await loadImportTeams();
}

async function loadImportTeams() {
    $('import-result').hidden = true;
    const id = $('import-season').value;
    const { data, error } = await sb.from('season_teams').select('teams(id, name)').eq('league_season_id', id);
    if (error) { console.error('import teams', error); return; }
    state.importTeams = data.map((r) => r.teams).sort((a, b) => a.name.localeCompare(b.name));
    if (!state.importTeams.length) toast('That season has no teams yet');
}

const normalizeKey = (raw) => raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');

// Typing (or picking from the list) an existing guest key fills in that guest's name.
function fillNameFromKey() {
    const known = state.identities.find((i) => i.guestKey === normalizeKey($('import-key').value));
    if (known) $('import-name').value = known.displayName;
}

function readImportForm() {
    const key = normalizeKey($('import-key').value);
    const name = $('import-name').value.trim();
    if (!key) { toast('Enter a guest key'); return null; }
    if (!name) { toast('A display name is required'); return null; }
    return { key, name };
}

// One click: match the pasted names to the season's teams. If every one matched,
// import right away; otherwise show only the rows that need a decision.
async function startImport() {
    const form = readImportForm();
    if (!form) return;
    if (!state.importTeams.length) { toast('That season has no teams yet'); return; }

    const names = typedNames('import-input');
    if (names.length !== state.importTeams.length) {
        toast(`This season has ${state.importTeams.length} teams, you pasted ${names.length}`);
        return;
    }

    state.importMatches = matchTeams(names, state.importTeams);

    // One name left over and one team left over: the pairing is forced ("Spurs" is
    // the only team not matched, so it must be Tottenham), no need to ask.
    let eliminated = null;
    const stillOpen = state.importMatches.filter((m) => !m.match);
    if (stillOpen.length === 1) {
        const used = new Set(state.importMatches.filter((m) => m.match).map((m) => m.match.id));
        const left = state.importTeams.filter((t) => !used.has(t.id));
        if (left.length === 1) {
            stillOpen[0].match = left[0];
            eliminated = `${stillOpen[0].input} = ${left[0].name}`;
        }
    }

    const open = state.importMatches.filter((m) => !m.match);
    if (!open.length) {
        await submitImport(form, state.importMatches.map((m) => m.match.id), eliminated);
        return;
    }
    renderImportRows();
    $('import-result').hidden = false;
}

// Only the rows that did not match; their dropdowns exclude teams already matched.
function renderImportRows() {
    const taken = new Set(state.importMatches.filter((m) => m.match).map((m) => m.match.id));
    const open = state.importMatches.map((m, i) => ({ m, i })).filter(({ m }) => !m.match);
    $('import-summary').textContent =
        `${state.importMatches.length - open.length} of ${state.importMatches.length} teams matched automatically. Choose a team for the rest.`;
    $('import-rows').innerHTML = open.map(({ m, i }) => `
        <tr data-i="${i}">
            <td>${i + 1}</td>
            <td>${esc(m.input)}</td>
            <td><select data-i="${i}">
                <option value="" selected>— choose a team —</option>
                ${m.options.filter((c) => !taken.has(c.id)).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
            </select></td>
        </tr>`).join('');
    $('import-rows').querySelectorAll('select').forEach((sel) => sel.addEventListener('change', flagImportRows));
    flagImportRows();
}

function flagImportRows() {
    const selects = [...$('import-rows').querySelectorAll('select')];
    const counts = selects.reduce((acc, s) => (s.value ? acc.set(s.value, (acc.get(s.value) || 0) + 1) : acc), new Map());
    selects.forEach((s) => {
        const tr = s.closest('tr');
        tr.classList.toggle('is-new', !s.value);
        tr.classList.toggle('is-dup', Boolean(s.value) && counts.get(s.value) > 1);
    });
}

async function confirmImport() {
    const form = readImportForm();
    if (!form) return;
    flagImportRows();
    if ($('import-rows').querySelector('.is-new')) { toast('Choose a team for every row'); return; }
    if ($('import-rows').querySelector('.is-dup')) { toast('The same team is picked twice'); return; }

    const teamIds = state.importMatches.map((m) => m.match?.id ?? null);
    $('import-rows').querySelectorAll('select').forEach((s) => { teamIds[Number(s.dataset.i)] = s.value; });
    await submitImport(form, teamIds);
}

async function submitImport({ key, name }, teamIds, note = null) {
    [$('import-btn'), $('import-confirm-btn')].forEach((b) => { b.disabled = true; });
    const { error } = await sb.rpc('admin_import_guest_entry', {
        p_guest_key: key,
        p_display_name: name,
        p_league_season_id: $('import-season').value,
        p_team_ids: teamIds,
        p_late_gameweek: Number($('import-weeks').value),
    });
    [$('import-btn'), $('import-confirm-btn')].forEach((b) => { b.disabled = false; });
    if (error) { console.error('import', error); toast(errorMessage(error)); return; }

    toast(note ? `Imported ${name} (${key}). Matched by elimination: ${note}` : `Imported ${name} (${key})`, note ? 4000 : 1800);
    $('import-key').value = '';
    $('import-name').value = '';
    $('import-weeks').value = '0';
    $('import-input').value = '';
    $('import-result').hidden = true;
    await loadIdentities();
    await loadRenameTargets();
}

/* -------- guest identities (shared by import / claims / link / rename) -------- */

async function loadIdentities() {
    try {
        state.identities = await listUnclaimedGuestIdentities();
    } catch (e) {
        console.error('identities', e);
        return;
    }
    $('guest-keys').innerHTML = state.identities
        .map((i) => `<option value="${esc(i.guestKey)}" label="${esc(i.displayName)}"></option>`).join('');
    $('link-guest').innerHTML = state.identities
        .map((i) => `<option value="${esc(i.guestKey)}">${esc(i.displayName)} (${esc(i.guestKey)}): ${esc(describeSeasons(i.seasons))}</option>`).join('');
}

/* -------- pending claim requests -------- */

async function loadClaims() {
    const { data, error } = await sb.from('guest_claim_requests')
        .select('id, guest_key, requested_by_user_id, created_at')
        .eq('status', 'pending').order('created_at');
    if (error) { console.error('claims', error); return; }

    $('claims-empty').hidden = data.length > 0;
    const ids = [...new Set(data.map((r) => r.requested_by_user_id))];
    const { data: profiles } = ids.length
        ? await sb.from('profiles').select('id, name, display_name, avatar_url').in('id', ids)
        : { data: [] };
    const byId = new Map((profiles || []).map((p) => [p.id, p]));

    $('claims-list').innerHTML = data.map((r) => {
        const who = byId.get(r.requested_by_user_id);
        const guest = state.identities.find((i) => i.guestKey === r.guest_key);
        return `
        <div class="claim-row" data-id="${r.id}">
            <div class="claim-who">
                ${who?.avatar_url ? `<img src="${esc(who.avatar_url)}" alt="" referrerpolicy="no-referrer">` : ''}
                <div><b>${esc(who?.display_name || 'Unknown')}</b>${who && who.name !== who.display_name ? ` <span class="hint-inline">(${esc(who.name)})</span>` : ''}<br>
                <span class="hint-inline">says they are <b>${esc(guest?.displayName || r.guest_key)}</b>${guest ? `: ${esc(describeSeasons(guest.seasons))}` : ''}</span></div>
            </div>
            <div class="claim-actions">
                <button class="btn small" data-act="approve">Approve</button>
                <button class="btn secondary small" data-act="reject">Reject</button>
            </div>
        </div>`;
    }).join('');

    $('claims-list').querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => {
        const row = btn.closest('.claim-row');
        const req = data.find((r) => r.id === row.dataset.id);
        reviewClaim(req, byId.get(req.requested_by_user_id), btn.dataset.act === 'approve');
    }));
}

async function reviewClaim(req, who, approve) {
    const guest = state.identities.find((i) => i.guestKey === req.guest_key);
    if (approve) {
        const ok = await confirmDialog({
            title: 'Approve this claim?',
            body: `${guest?.displayName || req.guest_key}'s entries will be linked to ${who?.display_name || 'this account'}, replacing that account's own entry for any league season they share, and their display name becomes "${guest?.displayName || req.guest_key}". Other pending requests for this guest are rejected.`,
            confirmLabel: 'Approve',
        });
        if (!ok) return;
    }
    const { data, error } = await sb.rpc('admin_review_guest_claim', { p_request_id: req.id, p_approve: approve });
    if (error) { console.error('review', error); toast(errorMessage(error)); return; }
    toast(approve ? `Linked (${data?.merged ?? 0} entr${data?.merged === 1 ? 'y' : 'ies'})` : 'Request rejected');
    await loadIdentities();
    await loadClaims();
    await loadRenameTargets();
}

/* -------- link an account to a guest directly -------- */

async function findUser() {
    const email = $('link-email').value.trim();
    if (!email) return;
    const { data, error } = await sb.rpc('admin_find_user_by_email', { p_email: email });
    if (error) { console.error('find user', error); toast(errorMessage(error)); return; }
    state.foundUser = data?.[0] || null;
    const found = $('link-found');
    found.hidden = false;
    found.innerHTML = state.foundUser
        ? `Found <b>${esc(state.foundUser.display_name)}</b>${state.foundUser.name !== state.foundUser.display_name ? ` (${esc(state.foundUser.name)})` : ''}`
        : 'No account with that email.';
    $('link-btn').disabled = !state.foundUser;
}

async function linkAccount() {
    const key = $('link-guest').value;
    const guest = state.identities.find((i) => i.guestKey === key);
    if (!state.foundUser || !guest) return;
    const ok = await confirmDialog({
        title: 'Link this account?',
        body: `${guest.displayName}'s entries (${describeSeasons(guest.seasons)}) will be linked to ${state.foundUser.display_name}, replacing that account's own entry for any league season they share. Their display name becomes "${guest.displayName}".`,
        confirmLabel: 'Link',
    });
    if (!ok) return;
    const { data, error } = await sb.rpc('admin_merge_guest_key', { p_guest_key: key, p_user_id: state.foundUser.user_id });
    if (error) { console.error('link', error); toast(errorMessage(error)); return; }
    const over = data?.overwritten?.length || 0;
    toast(`Linked ${data?.merged ?? 0} entr${data?.merged === 1 ? 'y' : 'ies'}${over ? `, ${over} replaced` : ''}`);
    state.foundUser = null;
    $('link-btn').disabled = true;
    $('link-found').hidden = true;
    $('link-email').value = '';
    await loadIdentities();
    await loadClaims();
    await loadRenameTargets();
}

/* -------- rename -------- */

async function loadRenameTargets() {
    const { data: profiles } = await sb.from('profiles').select('id, name, display_name').order('display_name');
    state.renameTargets = new Map();
    const labels = [];
    (profiles || []).forEach((p) => {
        const label = `${p.display_name} (account${p.name && p.name !== p.display_name ? `: ${p.name}` : ''})`;
        state.renameTargets.set(label, { type: 'account', id: p.id, current: p.display_name });
        labels.push(label);
    });
    state.identities.forEach((i) => {
        const label = `${i.displayName} (guest: ${i.guestKey})`;
        state.renameTargets.set(label, { type: 'guest', key: i.guestKey, current: i.displayName });
        labels.push(label);
    });
    $('rename-options').innerHTML = labels.map((l) => `<option value="${esc(l)}"></option>`).join('');
}

async function renameTarget() {
    const target = state.renameTargets.get($('rename-search').value.trim());
    const name = $('rename-new').value.trim();
    if (!target) { toast('Pick a name from the list'); return; }
    if (!name) { toast('Enter the new name'); return; }

    const { error } = target.type === 'account'
        ? await sb.rpc('admin_rename_profile', { p_user_id: target.id, p_display_name: name })
        : await sb.rpc('admin_rename_guest', { p_guest_key: target.key, p_display_name: name });
    if (error) { console.error('rename', error); toast(errorMessage(error)); return; }

    toast(`Renamed to ${name}`);
    $('rename-search').value = '';
    $('rename-new').value = '';
    await loadIdentities();
    await loadClaims();
    await loadRenameTargets();
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
            <td>${esc(t.name)}<br><span class="hint-inline">${t.years.sort().map(seasonLabel).join(', ')}</span></td>
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
