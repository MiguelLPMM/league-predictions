// Toast that can also survive a page navigation (e.g. "Signed in" after the
// Google redirect): notifyNext() stores the message, the next page shows it.
const KEY = 'pendingToast';

export function toast(msg, ms = 1800) {
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
    toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

export function notifyNext(msg) {
    try { sessionStorage.setItem(KEY, msg); } catch { /* storage unavailable */ }
}

export function showPendingToast() {
    try {
        const msg = sessionStorage.getItem(KEY);
        if (msg) {
            sessionStorage.removeItem(KEY);
            toast(msg);
        }
    } catch { /* storage unavailable */ }
}
