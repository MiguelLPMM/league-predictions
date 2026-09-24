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
    if (allAgree) {
        // Words the user typed that the team does not have count against it ("Bayer
        // Leverkusen" fits "Leverkusen" better than "Bayern"), while a team word the user
        // left out is just an abbreviation ("City" for "Man City") and costs nothing.
        const typedChars = a.join('').length;
        const unmatched = a.filter((t) => !b.some((u) => tokensAgree(t, u))).join('').length;
        return 0.9 - 0.3 * (unmatched / typedChars);
    }

    const sa = a.join(' ');
    const sb = b.join(' ');
    return Math.max(0, 1 - levenshtein(sa, sb) / Math.max(sa.length, sb.length));
}

export const MATCH_THRESHOLD = 0.7;

// Two candidates whose scores are this close are indistinguishable: the typed name fits
// both ("City" fits Man City and Leicester City), so it must not be guessed.
export const AMBIGUITY_MARGIN = 0.05;

// names: typed names in table order. candidates: [{id, name, ...}].
// Returns one entry per name:
//   { input, match, score, ambiguous, duplicate, options }
// match is null when there is no good match OR when the name fits more than one team
// (ambiguous = true): those are left for a manual choice, never guessed. A single exact
// name match is decisive even if other teams also fit loosely. Each candidate is
// auto-matched to at most one name (the best pairing wins). options lists candidates
// best-first.
export function matchTeams(names, candidates) {
    const scored = names.map((input) => candidates
        .map((c) => ({ c, score: similarity(input, c.name) }))
        .sort((x, y) => y.score - x.score));

    // A name typed twice can't be resolved by guessing which row is which team, so every
    // row carrying it is left open (duplicate = true) for a manual choice.
    const key = (n) => normalize(n).join(' ');
    const counts = new Map();
    names.forEach((n) => counts.set(key(n), (counts.get(key(n)) || 0) + 1));
    const duplicateAt = new Set(names.map((n, i) => (counts.get(key(n)) > 1 ? i : -1)).filter((i) => i >= 0));

    const ambiguousAt = new Set();
    const pairs = [];
    scored.forEach((list, i) => {
        if (duplicateAt.has(i)) return;
        const top = list[0];
        if (!top || top.score < MATCH_THRESHOLD) return;
        const rivals = list.slice(1).filter((o) => o.score >= MATCH_THRESHOLD && o.score >= top.score - AMBIGUITY_MARGIN);
        const decisive = top.score === 1 && rivals.every((r) => r.score < 1);
        if (rivals.length && !decisive) { ambiguousAt.add(i); return; }
        pairs.push({ i, c: top.c, score: top.score });
    });
    pairs.sort((x, y) => y.score - x.score);

    const chosen = new Map();
    const taken = new Set();
    for (const p of pairs) {
        if (chosen.has(p.i) || taken.has(p.c.id)) continue;
        chosen.set(p.i, p);
        taken.add(p.c.id);
    }

    return names.map((input, i) => {
        const pick = chosen.get(i);
        return {
            input,
            match: pick?.c ?? null,
            score: pick?.score ?? 0,
            ambiguous: ambiguousAt.has(i) || duplicateAt.has(i),
            duplicate: duplicateAt.has(i),
            options: scored[i].map((o) => o.c),
        };
    });
}

// When the only open rows are one name typed several times ("Nantes" twice), the teams left
// over after everything else matched are the candidates. Suggest which row is which team by
// last season's final order: the earlier row gets the team that finished higher. A team with
// no rank last season (promoted) counts as having finished below every ranked team; two
// promoted teams can't be told apart, so then nothing is suggested. This is only a pre-fill
// for the manual choice, never applied silently.
//   previousPositions: Map(team_id -> position last season), or null.
// Returns Map(row index -> candidate) (empty when there is nothing safe to suggest).
export function proposeForDuplicates(matches, teams, previousPositions) {
    const none = new Map();
    const open = matches.map((m, i) => ({ m, i })).filter(({ m }) => !m.match);
    if (!open.length || !previousPositions || !open.every(({ m }) => m.duplicate)) return none;

    const key = (n) => normalize(n).join(' ');
    if (!open.every(({ m }) => key(m.input) === key(open[0].m.input))) return none; // one duplicated name only

    const used = new Set(matches.filter((m) => m.match).map((m) => m.match.id));
    const leftover = teams.filter((t) => !used.has(t.id));
    if (leftover.length !== open.length) return none;

    const rank = (t) => (previousPositions.has(t.id) ? previousPositions.get(t.id) : Infinity);
    const ordered = [...leftover].sort((a, b) => (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1));
    if (ordered.some((t, k) => k > 0 && rank(t) === rank(ordered[k - 1]))) return none; // e.g. two promoted teams
    return new Map(open.map(({ i }, k) => [i, ordered[k]]));
}
