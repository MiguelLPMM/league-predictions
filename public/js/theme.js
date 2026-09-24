// Theme choice: 'system' (default: follow the device), 'light' or 'dark'.
// 'system' is stored as no value at all. The choice becomes <html data-theme>;
// with no attribute the stylesheet follows prefers-color-scheme by itself.
// Every page also runs a tiny inline script in <head> that applies a saved
// Light/Dark choice before first paint (see the pages), so there is no flash.
const KEY = 'theme';

export function getTheme() {
    try {
        const stored = localStorage.getItem(KEY);
        if (stored === 'light' || stored === 'dark') return stored;
    } catch { /* storage unavailable */ }
    return 'system';
}

export function setTheme(theme) {
    try {
        if (theme === 'light' || theme === 'dark') localStorage.setItem(KEY, theme);
        else localStorage.removeItem(KEY);
    } catch { /* storage unavailable: the choice just won't persist */ }

    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    else delete root.dataset.theme;
}
