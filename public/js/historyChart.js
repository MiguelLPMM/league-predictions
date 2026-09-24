// History chart: one line per player, one point per season, straight segments between
// consecutive seasons. The y axis is upside down (score 0 at the top) because a lower
// score is better, so better seasons sit higher. Under each season label a small row shows
// how many teams the league had that season, since that changes what a score means.
//
// Every season gets a minimum column width. When the seasons don't fit the screen the plot
// scrolls sideways (scrollbar hidden) while the score axis stays put on the left; it opens
// on the selected season, or on the latest one.
//
// Hovering a line, a point or a legend chip highlights that player and fades the rest;
// clicking or tapping pins players (as many as you like) and they stay highlighted while you
// hover others; hovering/tapping a point shows its details. Plain SVG, no library.
//
// data: { seasons: [{ year, label, teams, live }],
//         series:  [{ key, name, color, isSelf, points: [{ year, score, bangOn, late, teams, live }] }] }

const M = { left: 40, right: 14, top: 14, bottom: 50 }; // margins around the plot, in px
const MIN_COL = 58;                                     // narrowest a season column may get before the chart scrolls

// The 12 line colours. Each person is assigned one palette index in the database (so it is the
// same in every league and chart); this is only the index -> colour table. Consecutive indices
// are far apart on the colour wheel and the lightness varies a little, so people who join one
// after another never look alike. Each entry: [hue, lightness offset in %].
const PALETTE = [[212, 0], [2, 0], [142, -4], [42, 0], [284, 6], [172, -6], [326, 4], [24, 2], [98, -6], [246, 10], [192, 8], [350, -8]];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Round the top of the axis up to a tidy value with at most 5 gridlines.
function niceScale(maxScore) {
    const steps = [2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
    const step = steps.find((s) => maxScore / s <= 5) || 1000;
    return { step, max: Math.max(step, Math.ceil(maxScore / step) * step) };
}

// style attribute carrying a series colour (falls back to its position when none is stored)
const colourStyle = (series, i) => {
    const [h, dl] = PALETTE[(Number.isInteger(series.color) ? series.color : i) % PALETTE.length];
    return `--h:${h};--dl:${dl}%`;
};

export function mountHistoryChart(container, initialData, options = {}) {
    let data = initialData;
    let selectedYear = options.selectedYear ?? null;
    const height = options.height || 300;
    const showLegend = options.legend !== false;
    const showNote = options.note !== false;

    // hover: the player under the mouse. pinned: players the user clicked or tapped (any number).
    // Both stay highlighted at once, so hovering someone else never hides a pinned player.
    const state = { hover: null, pinned: new Set(), hoverTip: null, pinnedTip: null };
    let geometry = null;      // where each point sits (plot coordinates), for the tooltip
    let lastWidth = 0;
    let scrollTarget = 'auto'; // 'auto' = keep the current position; 'selected' = bring the selected season into view

    container.classList.add('hist');

    function draw() {
        const W = Math.round(container.clientWidth);
        if (W < 40) return; // hidden (zero width): the resize observer draws it once it is visible
        lastWidth = W;

        const { seasons, series } = data;
        if (!seasons.length || !series.length) {
            container.innerHTML = '<p class="hint hist-empty">No history yet.</p>';
            geometry = null;
            return;
        }

        const previousScroll = container.querySelector('.hist-scroll')?.scrollLeft ?? null;

        const allScores = series.flatMap((s) => s.points.map((p) => p.score));
        const { step, max } = niceScale(Math.max(1, ...allScores));
        const colW = Math.max(MIN_COL, (W - M.left - M.right) / seasons.length);
        const plotW = colW * seasons.length;          // may be wider than the screen: then it scrolls
        const plotSvgW = plotW + M.right;
        const plotH = height - M.top - M.bottom;
        const plotBottom = M.top + plotH;
        const index = new Map(seasons.map((s, i) => [s.year, i]));
        const xOf = (year) => colW * (index.get(year) + 0.5);
        const yOf = (score) => M.top + (score / max) * plotH; // 0 at the top: lower is better

        // fixed left part: score labels and the "teams" row caption
        let axis = `<svg class="hist-axis" width="${M.left}" height="${height}" viewBox="0 0 ${M.left} ${height}" aria-hidden="true">`;
        for (let t = 0; t <= max; t += step) {
            axis += `<text class="hist-tick" x="${M.left - 6}" y="${yOf(t) + 3}" text-anchor="end">${t}</text>`;
        }
        axis += `<text class="hist-rowcap" x="${M.left - 6}" y="${plotBottom + 32}" text-anchor="end">teams</text></svg>`;

        // scrolling part: gridlines, selected-season band, season labels + team counts, players
        let svg = `<svg class="hist-plot" width="${plotSvgW}" height="${height}" viewBox="0 0 ${plotSvgW} ${height}" role="img" aria-label="Score history by season, lower is better">`;
        const selIdx = index.get(selectedYear);
        if (selIdx !== undefined) {
            svg += `<rect class="hist-sel" x="${colW * selIdx}" y="${M.top - 6}" width="${colW}" height="${plotH + 6 + 44}" rx="8"/>`;
        }
        for (let t = 0; t <= max; t += step) {
            svg += `<line class="hist-grid" x1="0" x2="${plotSvgW}" y1="${yOf(t)}" y2="${yOf(t)}"/>`;
        }
        seasons.forEach((s, i) => {
            const x = colW * (i + 0.5);
            const sel = s.year === selectedYear ? ' sel' : '';
            svg += `<text class="hist-season${sel}" x="${x}" y="${plotBottom + 16}" text-anchor="middle">${esc(s.label)}${s.live ? '*' : ''}</text>`;
            svg += `<text class="hist-teams" x="${x}" y="${plotBottom + 32}" text-anchor="middle">${s.teams}</text>`;
        });

        geometry = series.map((s) => s.points.map((p) => ({ x: xOf(p.year), y: yOf(p.score) })));
        series.forEach((s, si) => {
            const pts = geometry[si];
            const line = pts.map((q) => `${q.x},${q.y}`).join(' ');
            svg += `<g class="hs${s.isSelf ? ' self' : ''}" data-key="${esc(s.key)}" style="${colourStyle(s, si)}">`;
            if (pts.length > 1) {
                svg += `<polyline class="hl" points="${line}"/>`;
                svg += `<polyline class="hh" points="${line}"/>`; // wide invisible stroke: an easy target
            }
            s.points.forEach((p, pi) => {
                svg += `<circle class="hp${p.live ? ' live' : ''}" cx="${pts[pi].x}" cy="${pts[pi].y}" r="4.5"/>`;
                svg += `<circle class="hpz" data-s="${si}" data-p="${pi}" cx="${pts[pi].x}" cy="${pts[pi].y}" r="12"/>`;
            });
            svg += '</g>';
        });
        svg += '</svg>';

        let legend = '';
        if (showLegend && series.length > 1) {
            legend = '<div class="hist-legend">' + series.map((s, si) =>
                `<button type="button" class="hist-chip${s.isSelf ? ' self' : ''}" data-key="${esc(s.key)}" style="${colourStyle(s, si)}"><i></i>${esc(s.name)}</button>`).join('') + '</div>';
        }
        const note = showNote && seasons.some((s) => s.live) ? '<p class="hist-note">* season in progress: hollow points can still move</p>' : '';

        container.innerHTML = `<div class="hist-scroll"><div class="hist-inner">${axis}${svg}<div class="hist-tip" hidden></div></div></div>${legend}${note}`;

        // where to scroll: keep the position on a resize, else show the selected season (or the latest)
        const scroller = container.querySelector('.hist-scroll');
        const viewport = scroller.clientWidth - M.left;
        const overflow = scroller.scrollWidth > scroller.clientWidth + 1;
        if (overflow) {
            const focusCol = selIdx !== undefined ? selIdx : seasons.length - 1;
            const wanted = colW * (focusCol + 0.5) - viewport / 2;
            const keep = scrollTarget === 'auto' && previousScroll !== null;
            scroller.scrollLeft = keep ? previousScroll : Math.max(0, Math.min(wanted, scroller.scrollWidth - scroller.clientWidth));
        }
        scrollTarget = 'auto';
        apply();
    }

    // Reflect hover / pinned state: fade everyone but the highlighted players, show the tooltip.
    function apply() {
        const active = new Set(state.pinned);
        if (state.hover !== null) active.add(state.hover);
        const svg = container.querySelector('.hist-plot');
        if (!svg) return;
        svg.classList.toggle('has-active', active.size > 0);
        container.querySelectorAll('.hs, .hist-chip').forEach((el) => el.classList.toggle('on', active.has(el.dataset.key)));

        const tip = container.querySelector('.hist-tip');
        const t = state.hoverTip ?? state.pinnedTip;
        if (!t || !geometry) { tip.hidden = true; return; }
        const s = data.series[t.s];
        const p = s.points[t.p];
        const g = geometry[t.s][t.p];
        const season = data.seasons.find((x) => x.year === p.year);
        tip.innerHTML = `<b>${esc(s.name)}</b><br>${esc(season.label)}${p.live ? ' (in progress)' : ''} · score ${p.score}<br>${p.bangOn} bang on · ${p.teams} teams${p.late ? ` · GW ${p.late} late` : ''}`;
        tip.hidden = false;

        // position in .hist-inner coordinates (the axis takes the first M.left px); keep it inside the visible part
        const scroller = container.querySelector('.hist-scroll');
        const w = tip.offsetWidth;
        const visibleLeft = scroller.scrollLeft + M.left + w / 2 + 4;
        const visibleRight = scroller.scrollLeft + scroller.clientWidth - w / 2 - 4;
        tip.style.left = `${Math.min(Math.max(M.left + g.x, visibleLeft), Math.max(visibleLeft, visibleRight))}px`;
        const above = g.y - tip.offsetHeight - 10 > 0;
        tip.style.top = `${above ? g.y - 10 : g.y + 14}px`;
        tip.style.transform = above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)';
    }

    const keyOf = (el) => el.closest('[data-key]')?.dataset.key ?? null;
    const tipOf = (el) => {
        const z = el.closest('.hpz');
        return z ? { s: Number(z.dataset.s), p: Number(z.dataset.p) } : null;
    };

    // hover: mouse only (a touch "hover" would stick after the tap; taps are handled as clicks)
    container.addEventListener('pointerover', (e) => {
        if (e.pointerType !== 'mouse') return;
        const key = keyOf(e.target);
        if (key === null) return;
        state.hover = key;
        state.hoverTip = tipOf(e.target);
        apply();
    });
    container.addEventListener('pointerout', (e) => {
        if (e.pointerType !== 'mouse') return;
        const to = e.relatedTarget;
        if (to && container.contains(to) && keyOf(to) !== null) return; // moving to another player/point: pointerover handles it
        state.hover = null;
        state.hoverTip = null;
        apply();
    });

    // click / tap: pin a player (tap again to release just them); tapping empty space releases everyone
    container.addEventListener('click', (e) => {
        const key = keyOf(e.target);
        if (key === null) {
            state.pinned.clear();
            state.pinnedTip = null;
            state.hover = null;
            state.hoverTip = null;
            apply();
            return;
        }
        const tip = tipOf(e.target);
        if (state.pinned.has(key) && !tip) {
            state.pinned.delete(key);
            state.pinnedTip = null;
        } else {
            state.pinned.add(key);
            state.pinnedTip = tip;
        }
        apply();
    });

    // a tooltip that was pinned stays put; hide a hover tooltip once the plot scrolls
    container.addEventListener('scroll', (e) => {
        if (e.target.classList?.contains('hist-scroll') && state.hoverTip) { state.hoverTip = null; apply(); }
    }, true);

    const observer = new ResizeObserver(() => {
        if (Math.abs(container.clientWidth - lastWidth) > 2) draw();
    });
    observer.observe(container);
    draw();

    return {
        setData(next) { data = next; state.hover = state.hoverTip = state.pinnedTip = null; state.pinned.clear(); scrollTarget = 'selected'; draw(); },
        setSelectedYear(year) { selectedYear = year; scrollTarget = 'selected'; draw(); },
        destroy() { observer.disconnect(); container.innerHTML = ''; },
    };
}
