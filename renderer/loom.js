/* ==========================================================================
   BURNEDWOLF — LOOM
   --------------------------------------------------------------------------
   The 3D layer, in the Flat Weave world's own grammar.

   The previous build's 3D was ember particles, glowing orbs and haloed rings —
   every one of them a lighting effect, and a flat weave has no lighting. So
   none of that survives. What replaces it is the thing this world actually
   contains in three dimensions: a LOOM. Warp threads under tension in depth,
   weft passing through them, a motif appearing pick by pick.

   Rules this file obeys, which are the world's rules:
     · Flat colour only. No gradients, no glow, no shadow, no additive blending.
     · Threads are lines with real depth, shaded by darkening the flat dye —
       the way a thread turns away from you — never by adding light.
     · Motion is mechanical: the weft crosses, the beater packs it down, repeat.

   Everything is real 3D maths (rotation + perspective projection) on a 2D
   canvas. No WebGL, no dependencies, works inside the packed asar, offline.

   API
     LOOM.warp(canvas, o)      warp threads in depth — ambient, very quiet
     LOOM.weave(canvas, o)     a motif woven pick by pick — the boot moment
     LOOM.guard(canvas, o)     the wolf's-mouth motif as a live state object
     LOOM.bars(canvas, o)      woven bar chart (usage) — blocks, not gradients
     LOOM.stop(a)              stop one animator
   ========================================================================== */
(function (global) {
    'use strict';

    // ---------------------------------------------------------------- loop
    const running = new Set();
    let raf = null, last = 0;

    function frame(t) {
        raf = requestAnimationFrame(frame);
        const dt = Math.min(50, t - last) / 16.6667;
        last = t;
        for (const a of running) {
            if (a.paused) continue;
            try { a.step(dt, t); } catch (e) { running.delete(a); }
        }
        if (!running.size) { cancelAnimationFrame(raf); raf = null; }
    }
    function join(a) {
        running.add(a);
        if (raf === null) { last = performance.now(); raf = requestAnimationFrame(frame); }
        return a;
    }
    function stop(a) { if (a) running.delete(a); }

    // A window in the tray must cost nothing.
    document.addEventListener('visibilitychange', () => {
        for (const a of running) a.paused = document.hidden;
    });

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ------------------------------------------------------------- helpers
    function fit(cv) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const r = cv.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
        if (cv._w !== w || cv._h !== h || cv._d !== dpr) {
            cv.width = w * dpr; cv.height = h * dpr;
            cv._w = w; cv._h = h; cv._d = dpr;
            cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        return { w, h, ctx: cv.getContext('2d') };
    }

    function dye(name, fallback) {
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            return v || fallback;
        } catch (e) { return fallback; }
    }

    function rgb(hex) {
        const h = (hex || '').replace('#', '');
        if (h.length !== 6) return [200, 200, 200];
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    // Depth shading in a flat world: a thread turning away gets DARKER.
    // Never lighter — light is what this world does not have.
    function shade(c, k, a) {
        const f = Math.max(0, Math.min(1, k));
        return `rgba(${Math.round(c[0] * f)},${Math.round(c[1] * f)},${Math.round(c[2] * f)},${a == null ? 1 : a})`;
    }

    // Rotate about Y then X, then project. One shared transform for every scene.
    function project(p, cy, sy, cx, sx, cxp, cyp, scale, dist) {
        const x = p.x * cy - p.z * sy;
        let z = p.x * sy + p.z * cy;
        const y = p.y * cx - z * sx;
        z = p.y * sx + z * cx;
        const k = dist / (dist + z);
        return { x: cxp + x * scale * k, y: cyp + y * scale * k, z, k };
    }

    // =====================================================================
    // WARP — threads under tension, receding. The ambient layer.
    // Deliberately almost invisible: it is the cloth the UI sits on, not a
    // light show competing with the content.
    // =====================================================================
    function warp(canvas, opts) {
        if (!canvas) return null;
        const o = Object.assign({ threads: 26, speed: 0.00035, alpha: 0.5 }, opts || {});
        const wool = rgb(dye('--selvedge-2', '#3a4762'));
        let ry = -0.5;

        const a = {
            paused: false,
            step(dt) {
                const { w, h, ctx } = fit(canvas);
                if (w < 8 || h < 8) return;
                ctx.clearRect(0, 0, w, h);
                ry += o.speed * dt * (reduced ? 0.15 : 1);
                const cy = Math.cos(ry), sy = Math.sin(ry);
                const cx = Math.cos(0.12), sx = Math.sin(0.12);
                const scale = Math.max(w, h) * 0.62;
                const cxp = w / 2, cyp = h / 2;

                ctx.lineWidth = 1;
                for (let i = 0; i < o.threads; i++) {
                    const f = i / (o.threads - 1);
                    const x = (f - 0.5) * 2;
                    // a warp thread bows slightly under tension
                    const bow = Math.sin(f * Math.PI) * 0.06;
                    const top = project({ x, y: -1.15, z: bow }, cy, sy, cx, sx, cxp, cyp, scale, 3.4);
                    const bot = project({ x, y: 1.15, z: bow }, cy, sy, cx, sx, cxp, cyp, scale, 3.4);
                    ctx.strokeStyle = shade(wool, 0.35 + top.k * 0.5, o.alpha * (0.3 + top.k * 0.5));
                    ctx.beginPath();
                    ctx.moveTo(top.x, top.y);
                    ctx.lineTo(bot.x, bot.y);
                    ctx.stroke();
                }
            }
        };
        return join(a);
    }

    // =====================================================================
    // WEAVE — a motif appears pick by pick on a loom seen in perspective.
    // This is the boot moment: the cloth being made, not a spinner.
    // =====================================================================
    // "Kurt izi" — wolf track. A canonical Anatolian protective motif, drawn
    // on a 13x13 pick grid. 1 = madder, 2 = wool, 0 = ground.
    const KURT_IZI = [
        '0000000000000',
        '0111000000000',
        '0122100000000',
        '0121210000000',
        '0112221000000',
        '0011222100000',
        '0001222210000',
        '0000122221000',
        '0000012222100',
        '0000001222210',
        '0000000122221',
        '0000000012221',
        '0000000001110'
    ].map(r => r.split('').map(Number));

    function weave(canvas, opts) {
        if (!canvas) return null;
        const o = Object.assign({ grid: KURT_IZI, pps: 9, loop: true }, opts || {});
        const g = o.grid;
        const rows = g.length, cols = g[0].length;
        const madder = rgb(dye('--madder', '#b8322a'));
        const wool = rgb(dye('--wool-2', '#c4b9a4'));
        const warpCol = rgb(dye('--selvedge', '#2b3446'));
        let picks = 0, ry = 0.32;

        const a = {
            paused: false,
            reset() { picks = 0; },
            step(dt) {
                const { w, h, ctx } = fit(canvas);
                if (w < 12 || h < 12) return;
                ctx.clearRect(0, 0, w, h);
                picks += (o.pps / 60) * dt * (reduced ? 3 : 1);
                if (picks > rows + 6) { if (o.loop) picks = 0; else picks = rows; }

                ry += 0.0009 * dt * (reduced ? 0 : 1);
                const cy = Math.cos(Math.sin(ry) * 0.42), sy = Math.sin(Math.sin(ry) * 0.42);
                const cx = Math.cos(0.34), sx = Math.sin(0.34);
                const scale = Math.min(w, h) * 0.5;
                const cxp = w / 2, cyp = h / 2;
                const cell = 2 / Math.max(rows, cols);

                // the warp still to be filled, sitting behind the cloth
                ctx.lineWidth = 1;
                for (let c = 0; c <= cols; c++) {
                    const x = -1 + c * cell * (cols / Math.max(rows, cols)) * (Math.max(rows, cols) / cols);
                    const px = -1 + (c / cols) * 2;
                    const t = project({ x: px, y: -1, z: 0 }, cy, sy, cx, sx, cxp, cyp, scale, 3.2);
                    const b = project({ x: px, y: 1, z: 0 }, cy, sy, cx, sx, cxp, cyp, scale, 3.2);
                    ctx.strokeStyle = shade(warpCol, 0.5 + t.k * 0.4, 0.55);
                    ctx.beginPath(); ctx.moveTo(t.x, t.y); ctx.lineTo(b.x, b.y); ctx.stroke();
                }

                // the woven picks, bottom-up, each a flat quad
                const done = Math.floor(picks);
                for (let r = 0; r < Math.min(rows, done); r++) {
                    const rowFromBottom = rows - 1 - r;
                    for (let c = 0; c < cols; c++) {
                        const v = g[rowFromBottom][c];
                        if (!v) continue;
                        const x0 = -1 + (c / cols) * 2, x1 = -1 + ((c + 1) / cols) * 2;
                        const y1 = 1 - (r / rows) * 2, y0 = 1 - ((r + 1) / rows) * 2;
                        const p0 = project({ x: x0, y: y0, z: 0 }, cy, sy, cx, sx, cxp, cyp, scale, 3.2);
                        const p1 = project({ x: x1, y: y0, z: 0 }, cy, sy, cx, sx, cxp, cyp, scale, 3.2);
                        const p2 = project({ x: x1, y: y1, z: 0 }, cy, sy, cx, sx, cxp, cyp, scale, 3.2);
                        const p3 = project({ x: x0, y: y1, z: 0 }, cy, sy, cx, sx, cxp, cyp, scale, 3.2);
                        const col = v === 1 ? madder : wool;
                        // the newest pick sits proud of the cloth until beaten down
                        const fresh = (r === done - 1) ? 0.78 : 1;
                        ctx.fillStyle = shade(col, (0.62 + p0.k * 0.42) * fresh, 1);
                        ctx.beginPath();
                        ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
                        ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y);
                        ctx.closePath(); ctx.fill();
                    }
                }

                // the shuttle: the weft crossing the shed on the active pick
                if (done < rows) {
                    const cross = picks - done;
                    const y = 1 - (done / rows) * 2 - (1 / rows);
                    const sxp = -1 + cross * 2;
                    const s = project({ x: sxp, y, z: 0.05 }, cy, sy, cx, sx, cxp, cyp, scale, 3.2);
                    ctx.fillStyle = shade(rgb(dye('--walnut', '#8a6a45')), 0.9, 1);
                    ctx.fillRect(s.x - 4, s.y - 2, 8, 4);
                }
            }
        };
        return join(a);
    }

    // =====================================================================
    // GUARD — the protective motif as a live state object.
    // Woven and complete = protection on. Unwoven outline = off.
    // Replaces the old glowing ring core; it says the same thing with the
    // world's own symbol instead of a light.
    // =====================================================================
    function guard(canvas, opts) {
        if (!canvas) return null;
        const o = Object.assign({}, opts || {});
        const madder = rgb(dye('--madder', '#b8322a'));
        const wool = rgb(dye('--wool-2', '#c4b9a4'));
        const idle = rgb(dye('--selvedge-2', '#3a4762'));
        let on = false, fill = 0, ry = 0;

        // "Kurt ağzı" — wolf's mouth. Interlocking hooks that turn danger away.
        // Drawn as concentric hooked rings so it reads at 100px.
        const RINGS = [
            { r: 1.00, hooks: 8, w: 0.13 },
            { r: 0.70, hooks: 8, w: 0.13 },
            { r: 0.40, hooks: 4, w: 0.16 }
        ];

        const a = {
            paused: false,
            set(v) { on = !!v; },
            step(dt, t) {
                const { w, h, ctx } = fit(canvas);
                if (w < 12 || h < 12) return;
                ctx.clearRect(0, 0, w, h);
                fill += ((on ? 1 : 0) - fill) * 0.07 * dt;
                ry += (0.0016 + fill * 0.0022) * dt * (reduced ? 0 : 1);

                const cy = Math.cos(ry), sy = Math.sin(ry);
                const cx = Math.cos(0.42), sx = Math.sin(0.42);
                const scale = Math.min(w, h) * 0.42;
                const cxp = w / 2, cyp = h / 2;

                RINGS.forEach((ring, ri) => {
                    const n = ring.hooks;
                    // A hooked octagon: each side steps out then back, the
                    // "mouth". Built as a closed polyline in 3D, then filled.
                    const pts = [];
                    for (let i = 0; i < n; i++) {
                        const a0 = (i / n) * Math.PI * 2;
                        const a1 = ((i + 0.5) / n) * Math.PI * 2;
                        pts.push({ a: a0, r: ring.r });
                        pts.push({ a: a1, r: ring.r * (1 - ring.w) });
                    }
                    const proj = pts.map(p => project(
                        { x: Math.cos(p.a) * p.r, y: Math.sin(p.a) * p.r, z: (ri - 1) * 0.18 },
                        cy, sy, cx, sx, cxp, cyp, scale, 3.0));

                    const woven = fill > (RINGS.length - 1 - ri) / RINGS.length;
                    const amount = Math.max(0, Math.min(1, (fill - (RINGS.length - 1 - ri) / RINGS.length) * RINGS.length));
                    const base = woven ? (ri === 1 ? wool : madder) : idle;
                    const depth = 0.55 + (proj[0].k) * 0.45;

                    ctx.beginPath();
                    proj.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
                    ctx.closePath();
                    if (woven) {
                        ctx.fillStyle = shade(base, depth, 0.16 + amount * 0.5);
                        ctx.fill();
                    }
                    ctx.strokeStyle = shade(base, depth, woven ? 1 : 0.75);
                    ctx.lineWidth = woven ? 2 : 1.2;
                    ctx.stroke();
                });
            }
        };
        return join(a);
    }

    // =====================================================================
    // BARS — usage as woven blocks. Discrete picks stacked, not a smooth bar.
    // =====================================================================
    function bars(canvas, opts) {
        if (!canvas) return null;
        const o = Object.assign({ unit: 7 }, opts || {});
        let data = [], grow = 0;
        const madder = rgb(dye('--madder', '#b8322a'));
        const wool = rgb(dye('--wool-2', '#c4b9a4'));
        const rule = dye('--selvedge', '#2b3446');
        const ink = dye('--ink-3', '#9d947f');

        const a = {
            paused: false,
            setData(d) {
                const same = d.length === data.length && d.every((x, i) => data[i] && x.key === data[i].key && x.value === data[i].value);
                data = d || [];
                if (!same) grow = 0;
            },
            step(dt) {
                const { w, h, ctx } = fit(canvas);
                if (w < 20 || h < 20) return;
                ctx.clearRect(0, 0, w, h);
                if (!data.length) return;
                grow = Math.min(1, grow + 0.07 * dt);

                const padT = 10, padB = 18, padL = 2, padR = 2;
                const plotH = h - padT - padB, plotW = w - padL - padR;
                const max = Math.max(1, ...data.map(d => d.value));
                const slot = plotW / data.length;
                const bw = Math.max(3, slot - 3);
                // how many picks tall the tallest column is
                const maxPicks = Math.max(1, Math.floor(plotH / o.unit));

                ctx.strokeStyle = rule;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(padL, padT + plotH + .5);
                ctx.lineTo(padL + plotW, padT + plotH + .5);
                ctx.stroke();

                data.forEach((d, i) => {
                    const x = padL + i * slot + (slot - bw) / 2;
                    const picks = Math.round((d.value / max) * maxPicks * grow);
                    const col = d.today ? madder : wool;
                    for (let p = 0; p < picks; p++) {
                        const y = padT + plotH - (p + 1) * o.unit;
                        // each pick slightly darker toward the bottom: the
                        // cloth is packed tighter where it was beaten down
                        const k = 0.55 + (p / Math.max(1, maxPicks)) * 0.45;
                        ctx.fillStyle = shade(col, k, 1);
                        ctx.fillRect(x, y + 1, bw, o.unit - 2);
                    }
                });

                ctx.fillStyle = ink;
                ctx.font = '10px "BW Mono", monospace';
                ctx.textAlign = 'left';
                ctx.fillText(data[0].label || '', padL, h - 5);
                if (data.length > 1) {
                    ctx.textAlign = 'right';
                    ctx.fillText(data[data.length - 1].label || '', padL + plotW, h - 5);
                }
                ctx.textAlign = 'right';
                ctx.fillText(String(max), padL + plotW, padT - 1);
            }
        };
        return join(a);
    }

    global.LOOM = { warp, weave, guard, bars, stop, KURT_IZI, reduced };
    if (typeof module !== 'undefined' && module.exports) module.exports = global.LOOM;
})(window);
