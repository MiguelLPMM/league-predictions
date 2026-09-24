// Profile page: who you are, and the "is this past player me?" claim - view a
// pending request, change or cancel it, or make one if you still can.
import { supabaseClient as sb } from './supabaseClient.js';
import { onUser } from './auth.js';
import { initShell, lastLeague } from './shell.js';
import { toast } from './notify.js';
import { userAvatar } from './auth.js';
import {
    listUnclaimedGuestIdentities, getMyPendingClaim, hasCompletedMerge, requestClaim, cancelClaim,
} from './api/guestClaims.js';
import { describeSeasons } from './guestClaimPrompt.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

initShell({ league: lastLeague(), page: 'profile' });

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => console.error('sw register', err));
    });
}

let currentUser = null;
let changing = false; // the picker is open on top of a pending request

onUser((user) => {
    const id = user ? user.id : null;
    if (id === (currentUser && currentUser.id)) return;
    currentUser = user;
    if (!user) {
        $('profile-gate').hidden = false;
        $('profile-content').hidden = true;
        return;
    }
    $('profile-gate').hidden = true;
    $('profile-content').hidden = false;
    renderAccount();
    renderClaim();
});

async function renderAccount() {
    const { data: profile } = await sb.from('profiles').select('name, display_name').eq('id', currentUser.id).maybeSingle();
    const avatar = userAvatar(currentUser);
    const shown = profile?.display_name || profile?.name || currentUser.email;
    const showLogin = profile?.name && profile.name !== shown;
    $('profile-account').innerHTML = `
        ${avatar ? `<img src="${esc(avatar)}" alt="" referrerpolicy="no-referrer">` : ''}
        <div>
            <b>${esc(shown)}</b>
            ${showLogin ? `<br><span class="hint-inline">Login name: ${esc(profile.name)}</span>` : ''}
            <br><span class="hint-inline">${esc(currentUser.email || '')}</span>
        </div>`;
}

const pickerHtml = (identities, current) => `
    <div class="admin-form">
        <label for="claim-pick">Which past player are you?</label>
        <select id="claim-pick" class="season-select">
            ${identities.map((i) => `<option value="${esc(i.guestKey)}"${i.guestKey === current ? ' selected' : ''}>${esc(i.displayName)}: ${esc(describeSeasons(i.seasons))}</option>`).join('')}
        </select>
    </div>`;

async function renderClaim() {
    const area = $('claim-area');
    area.innerHTML = '<p class="hint">Loading…</p>';
    try {
        if (await hasCompletedMerge(currentUser.id)) {
            const { data: profile } = await sb.from('profiles').select('display_name').eq('id', currentUser.id).maybeSingle();
            area.innerHTML = `<p class="hint">You are linked to your past entries as <b>${esc(profile?.display_name || 'you')}</b>. Linking another past player has to be done by the admin.</p>`;
            return;
        }

        const [pending, identities, lastRejected] = await Promise.all([
            getMyPendingClaim(currentUser.id),
            listUnclaimedGuestIdentities(),
            lastRejectedClaim(),
        ]);

        if (pending && !changing) {
            const identity = identities.find((i) => i.guestKey === pending.guestKey);
            area.innerHTML = `
                <p class="hint">Pending request: you said you are <b>${esc(pending.displayName)}</b>${identity ? ` (${esc(describeSeasons(identity.seasons))})` : ''}. The admin hasn't reviewed it yet.</p>
                <div class="admin-actions">
                    <button class="btn secondary" id="claim-change">Change</button>
                    <button class="btn secondary" id="claim-cancel">Cancel request</button>
                </div>`;
            $('claim-change').addEventListener('click', () => { changing = true; renderClaim(); });
            $('claim-cancel').addEventListener('click', () => cancelPending(pending));
            return;
        }

        if (!identities.length) {
            changing = false;
            area.innerHTML = `<p class="hint">${pending ? 'There is nobody else to pick right now.' : 'There are no unclaimed past players right now.'}</p>`
                + (pending ? '<div class="admin-actions"><button class="btn secondary" id="claim-back">Back</button></div>' : '');
            if (pending) $('claim-back').addEventListener('click', () => { changing = false; renderClaim(); });
            return;
        }

        area.innerHTML = `
            ${lastRejected && !pending ? '<p class="hint">Your previous request was not approved. You can send another.</p>' : ''}
            ${pickerHtml(identities, pending?.guestKey)}
            <div class="admin-actions">
                <button class="btn" id="claim-send">${pending ? 'Send new request' : 'Send request'}</button>
                ${pending ? '<button class="btn secondary" id="claim-back">Back</button>' : ''}
            </div>`;
        $('claim-send').addEventListener('click', () => sendClaim(pending));
        if (pending) $('claim-back').addEventListener('click', () => { changing = false; renderClaim(); });
    } catch (e) {
        console.error('claim area', e);
        area.innerHTML = '<p class="hint">Could not load this right now, please try again later.</p>';
    }
}

async function lastRejectedClaim() {
    const { data } = await sb.from('guest_claim_requests')
        .select('id').eq('requested_by_user_id', currentUser.id).eq('status', 'rejected')
        .order('resolved_at', { ascending: false }).limit(1).maybeSingle();
    return data;
}

async function sendClaim(pending) {
    const key = $('claim-pick').value;
    const btn = $('claim-send');
    btn.disabled = true;
    try {
        if (pending) await cancelClaim(pending.id);   // changing: replace the old request
        try {
            await requestClaim(currentUser.id, key);
        } catch (e) {
            if (pending) await requestClaim(currentUser.id, pending.guestKey).catch(() => {}); // put the old one back
            throw e;
        }
        toast(pending ? 'Request changed' : 'Request sent. The admin will review it');
    } catch (e) {
        console.error('send claim', e);
        toast('Could not send the request');
    }
    changing = false;
    renderClaim();
}

async function cancelPending(pending) {
    try {
        await cancelClaim(pending.id);
        toast('Request cancelled');
    } catch (e) {
        console.error('cancel claim', e);
        toast('Could not cancel the request');
    }
    renderClaim();
}
