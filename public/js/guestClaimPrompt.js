// One-time "were you one of our past players?" prompt for signed-in users.
// Shown at most once per page load, and only if there is something to claim:
// the user hasn't merged already, hasn't dismissed it, has no pending request,
// and at least one unclaimed guest exists.
import {
    listUnclaimedGuestIdentities, getMyPendingClaim, hasCompletedMerge,
    hasDismissedPrompt, dismissPrompt, requestClaim,
} from './api/guestClaims.js';
import { LEAGUE_LABELS, seasonLabel } from './leagues.js';
import { toast } from './notify.js';

let checked = false;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// "Premier League 20/21, 21/22 · La Liga 21/22"
export function describeSeasons(seasons) {
    const byLeague = new Map();
    seasons.forEach((s) => byLeague.set(s.league, [...(byLeague.get(s.league) || []), seasonLabel(s.season_year)]));
    return [...byLeague].map(([league, labels]) => `${LEAGUE_LABELS[league] || league} ${labels.join(', ')}`).join(' · ');
}

function showPrompt(user, identities) {
    const dlg = document.createElement('dialog');
    dlg.className = 'confirm claim-dialog';
    dlg.innerHTML = `
        <h2>Were you one of our past players?</h2>
        <p>These predictions were imported from before the app existed. If one of them is yours, pick it and the admin will confirm and link it to your account.</p>
        <div class="claim-list">
            ${identities.map((i) => `
                <button class="claim-option" data-key="${esc(i.guestKey)}">
                    <b>${esc(i.displayName)}</b><span>${esc(describeSeasons(i.seasons))}</span>
                </button>`).join('')}
        </div>
        <div class="confirm-actions">
            <button class="btn secondary" id="claim-none">None of these are me</button>
        </div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => dlg.remove());

    dlg.querySelectorAll('.claim-option').forEach((btn) => btn.addEventListener('click', async () => {
        try {
            await requestClaim(user.id, btn.dataset.key);
            toast('Request sent. The admin will review it');
        } catch (e) {
            console.error('claim request', e);
            toast('Something went wrong, please try again');
        }
        dlg.close();
    }));
    dlg.querySelector('#claim-none').addEventListener('click', async () => {
        try {
            await dismissPrompt(user.id);
            toast('Got it');
        } catch (e) {
            console.error('dismiss', e);
        }
        dlg.close();
    });
    dlg.showModal();
}

export async function maybeShowGuestClaimPrompt(user) {
    if (checked || !user) return;
    checked = true;
    try {
        if (await hasCompletedMerge(user.id)) return;
        const [dismissed, pending, identities] = await Promise.all([
            hasDismissedPrompt(user.id), getMyPendingClaim(user.id), listUnclaimedGuestIdentities(),
        ]);
        if (dismissed || pending || !identities.length) return;
        showPrompt(user, identities);
    } catch (e) {
        console.error('guest claim check', e);
    }
}
