// Fuzzy matching of typed/pasted team names ("Manchester City", "Wolves",
// "Atletico Madrid") to the teams already in the database ("Man City",
// "Wolverhampton", "Atleti"). Pure functions, no DOM.

const STOP = new Set(['fc', 'cf', 'afc', 'ac', 'as', 'ssc', 'sc', 'fk', 'sv', 'vfb', 'vfl', 'tsg', 'rb', 'the', 'de', 'calcio', 'club', '1', '04', '05', '1899', '1846']);

export function normalize(name) {
    return String(name || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter((t) => t && !STOP.has(t));
}

// Two tokens "agree" if one is a prefix of the other (man / manchester) or they
// share a long common start (wolves / wolverhampton).
function tokensAgree(a, b) {
    if (a === b) return true;
    const [s, l] = a.length <= b.length ? [a, b] : [b, a];
    if (s.length >= 3 && l.startsWith(s)) return true;
    let i = 0;
    while (i < s.length && s[i] === l[i]) i++;
    return i >= 4 && i / s.length >= 0.6;
}

function levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return dp[a.length][b.length];
}

// 1 = identical, 0 = unrelated
export function similarity(inputName, candidateName) {
    const a = normalize(inputName);
    const b = normalize(candidateName);
    if (!a.length || !b.length) return 0;
    if (a.join(' ') === b.join(' ')) return 1;

    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    const used = new Set();
    const allAgree = short.every((t) => {
        const idx = long.findIndex((u, i) => !used.has(i) && tokensAgree(t, u));
        if (idx === -1) return false;
        used.add(idx);
        return true;
    });
    if (allAgree) return 0.9;

    const sa = a.join(' ');
    const sb = b.join(' ');
    return Math.max(0, 1 - levenshtein(sa, sb) / Math.max(sa.length, sb.length));
}

export const MATCH_THRESHOLD = 0.7;

// names: typed names in table order. candidates: [{id, name, ...}].
// Returns one entry per name: { input, match (candidate | null), score, options }
// where options lists candidates best-first. Each candidate is auto-matched to at
// most one name (the best pairing wins); a name with no good match gets match=null.
export function matchTeams(names, candidates) {
    const pairs = [];
    names.forEach((input, i) => candidates.forEach((c) => {
        const score = similarity(input, c.name);
        if (score >= MATCH_THRESHOLD) pairs.push({ i, c, score });
    }));
    pairs.sort((x, y) => y.score - x.score);

    const chosen = new Map();
    const taken = new Set();
    for (const p of pairs) {
        if (chosen.has(p.i) || taken.has(p.c.id)) continue;
        chosen.set(p.i, p);
        taken.add(p.c.id);
    }

    return names.map((input, i) => {
        const options = [...candidates]
            .map((c) => ({ c, score: similarity(input, c.name) }))
            .sort((x, y) => y.score - x.score)
            .map((o) => o.c);
        const pick = chosen.get(i);
        return { input, match: pick?.c ?? null, score: pick?.score ?? 0, options };
    });
}
