/* ============================================================
   Mesh Simulation — how phones talk when the network is down

   A small discrete-event engine (nodes, links, in-flight packets,
   simulated clock) plus one scenario per mechanism in the design:
   leaderless clusters, managed flooding, Codec 2 PTT, chunked
   images, LoRa airtime, gateway fail-over, satellite fall-back,
   DTN transition, alerts into a dead zone, priority queues,
   partition and rejoin. Everything is simulated; the numbers used
   (hop range, 4–6 NDP cap, 1 % LoRa duty, 340 B SBD, jitter buffer
   80–240 ms, 2 s heartbeat, …) are the ones from the design notes.
   ============================================================ */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const W = 960, H = 560;
  const canvas = $("net"), ctx = canvas.getContext("2d");
  const rnd = (a, b) => a + Math.random() * (b - a);
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // ---------------- Engine ----------------
  const E = { nodes: [], links: [], packets: [], t: 0, speed: 4, paused: false, log: [], sc: null, C: {}, step: -1, timers: [] };
  const byId = {};
  function node(id, x, y, kind, label, extra) { const n = Object.assign({ id, x, y, kind, label: label || id, alive: true, seen: new Set(), badge: "", ring: null, r: kind === "phone" ? 16 : 14 }, extra || {}); E.nodes.push(n); byId[id] = n; return n; }
  function link(a, b, kind, opts) { const l = Object.assign({ a, b, kind: kind || "wifi", delay: kind === "lora" ? 900 : kind === "sat" ? 30000 : kind === "net" ? 120 : 45, loss: 0, up: true }, opts || {}); E.links.push(l); return l; }
  function linkBetween(a, b) { return E.links.find(l => (l.a === a && l.b === b) || (l.a === b && l.b === a)); }
  function neighbors(id) { const n = byId[id]; if (!n || !n.alive) return []; return E.links.filter(l => l.up && (l.a === id || l.b === id)).map(l => l.a === id ? l.b : l.a).filter(o => byId[o] && byId[o].alive); }
  function send(from, to, o) {
    o = o || {}; const l = linkBetween(from, to); const A = byId[from], B = byId[to];
    if (!l || !l.up || !A || !B || !A.alive || !B.alive) return null;
    if (Math.random() < (o.loss != null ? o.loss : l.loss)) { E.stats.lost = (E.stats.lost || 0) + 1; return null; }
    const p = { from, to, link: l, prog: 0, dur: o.dur || (l.delay + rnd(0, o.jitter || 0)), color: o.color || "#1F7A5C", label: o.label || "", r: o.r || 5, payload: o.payload || {}, onArrive: o.onArrive, born: E.t };
    E.packets.push(p); return p;
  }
  function flood(at, from, o) { let n = 0; neighbors(at).forEach(nb => { if (nb !== from && send(at, nb, o)) n++; }); return n; }
  function bfs(from, to) { // shortest path over up links & alive nodes
    const prev = { [from]: null }, q = [from];
    while (q.length) { const u = q.shift(); if (u === to) break; neighbors(u).forEach(v => { if (!(v in prev)) { prev[v] = u; q.push(v); } }); }
    if (!(to in prev)) return null; const path = []; for (let v = to; v != null; v = prev[v]) path.unshift(v); return path;
  }
  function reachable(from) { const seen = new Set([from]), q = [from]; while (q.length) { const u = q.shift(); neighbors(u).forEach(v => { if (!seen.has(v)) { seen.add(v); q.push(v); } }); } return seen; }
  function log(msg, cls, at) { E.log.unshift({ t: E.t, msg, cls: cls || "" }); if (E.log.length > 200) E.log.length = 200; logDirty = true; if (at) say(at, msg.length > 90 ? msg.slice(0, 88) + "…" : msg, cls); }
  function after(ms, fn) { E.timers.push({ at: E.t + ms, fn }); }
  function hint(t) { $("hint").textContent = t || ""; }
  function fmtT(ms) { return (ms / 1000).toFixed(1) + " s"; }
  function kill(id) { const n = byId[id]; if (!n) return; n.alive = false; E.packets = E.packets.filter(p => p.from !== id && p.to !== id); }
  function removeNode(id) { E.nodes = E.nodes.filter(n => n.id !== id); delete byId[id]; E.links = E.links.filter(l => l.a !== id && l.b !== id); E.packets = E.packets.filter(p => p.from !== id && p.to !== id); }
  function segIntersect(a, b, c, d) { const o = (p, q, r) => Math.sign((q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)); return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b) && o(a, b, c) !== 0 && o(c, d, a) !== 0; }
  function segDist(p, a, b) { const dx = b.x - a.x, dy = b.y - a.y; const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)); }
  const UI = { drag: null, hover: null, tool: "move", pt: null };
  // Speech bubbles: a short line above the node it concerns, so the story
  // can be followed on the picture itself (not only in the log).
  E.bubbles = [];
  // Bubble lifetimes are in real seconds (not simulated), so they stay readable at 10× too.
  const realNow = () => performance.now();
  // Nothing stays up for less than ~2.6 s of real time, whatever the caller asks for: a line
  // nobody can finish reading is worse than no line at all. Six on screen at once, at most.
  const BTTL = ttl => Math.max(2600, ttl || 5200);
  function say(id, text, cls, ttl) { const n = byId[id]; if (!n) return; E.bubbles = E.bubbles.filter(b => b.node !== id); E.bubbles.push({ node: id, text, cls: cls || "", born: realNow(), ttl: BTTL(ttl) }); if (E.bubbles.length > 6) E.bubbles.shift(); }
  function sayAt(x, y, text, cls, ttl) { E.bubbles.push({ x, y, text, cls: cls || "", born: realNow(), ttl: BTTL(ttl) }); if (E.bubbles.length > 6) E.bubbles.shift(); }
  function wrapText(ctx, text, max) { const words = text.split(" "), lines = []; let cur = ""; words.forEach(w => { const t = cur ? cur + " " + w : w; if (ctx.measureText(t).width > max && cur) { lines.push(cur); cur = w; } else cur = t; }); if (cur) lines.push(cur); return lines; }
  function drawBubbles() {
    const rn = realNow(); E.bubbles = E.bubbles.filter(b => rn - b.born < b.ttl);
    if (!E.bubbles.length) return;
    const paper = css("--paper"), ink = css("--ink");
    const placed = [];                         // boxes already drawn, so two clouds never sit on top of each other
    const pulse = .5 + .5 * Math.sin(rn / 260);
    E.bubbles.forEach((b, bi) => {
      const n = b.node ? byId[b.node] : null; if (b.node && !n) return;
      const x = n ? n.x : b.x, top = n ? n.y - n.r - (n.badge ? 30 : 12) : b.y;
      const age = rn - b.born; const alpha = age > b.ttl - 600 ? (b.ttl - age) / 600 : Math.min(1, age / 150);
      const pop = Math.min(1, age / 180); const scale = 0.85 + 0.15 * (1 - Math.pow(1 - pop, 3));
      const fresh = bi === E.bubbles.length - 1 && age < 1600;   // the newest line gets an extra nudge
      const col = b.cls === "bad" ? css("--red") : b.cls === "warn" ? css("--amber") : b.cls === "ok" ? css("--green") : b.cls === "info" ? css("--blue") : css("--gold");
      const icon = b.cls === "bad" ? "✕" : b.cls === "warn" ? "⚠" : b.cls === "ok" ? "✓" : b.cls === "info" ? "→" : "●";
      const head = n ? n.label.split(" ·")[0] : "wall";
      ctx.font = "600 14px Inter, sans-serif"; const lines = wrapText(ctx, b.text, 280); const lw = Math.max(...lines.map(l => ctx.measureText(l).width));
      ctx.font = "800 12px Inter, sans-serif"; const hw = ctx.measureText(icon + "  " + head).width + 8;
      const w = Math.max(lw, hw) + 30, h = lines.length * 18 + 42;
      let bx = Math.max(6, Math.min(W - w - 6, x - w / 2)); let by = top - h - 14;
      for (let g = 0; g < 14; g++) { const hit = placed.find(r => bx < r.x + r.w + 8 && bx + w + 8 > r.x && by < r.y + r.h + 8 && by + h + 8 > r.y); if (!hit) break; by = hit.y - h - 10; }
      if (by < 6) by = 6;
      placed.push({ x: bx, y: by, w, h });

      ctx.save(); ctx.globalAlpha = Math.max(0, alpha);
      // a halo on the node the line is about, so eye and text are tied together
      if (n) { ctx.save(); ctx.globalAlpha = Math.max(0, alpha) * (fresh ? .30 + .30 * pulse : .22); ctx.strokeStyle = col; ctx.lineWidth = fresh ? 3.5 : 2.5; ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 8 + (fresh ? 3 * pulse : 0), 0, 7); ctx.stroke(); ctx.restore(); }
      ctx.translate(x, by + h); ctx.scale(scale, scale); ctx.translate(-x, -(by + h));
      // leader line down to the node when the cloud had to move up out of the way
      if (n && by + h < top - 18) { ctx.save(); ctx.globalAlpha = Math.max(0, alpha) * .5; ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, by + h); ctx.lineTo(x, top - 4); ctx.stroke(); ctx.restore(); }
      // body: solid paper, a coloured glow and a real drop shadow — readable over links and clutter
      ctx.shadowColor = col; ctx.shadowBlur = fresh ? 22 : 14; ctx.fillStyle = paper; ctx.beginPath(); ctx.roundRect(bx, by, w, h, 12); ctx.fill();
      ctx.shadowColor = "rgba(0,0,0,.40)"; ctx.shadowBlur = 16; ctx.shadowOffsetY = 4; ctx.fill(); ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.beginPath(); ctx.moveTo(x - 8, by + h - 1); ctx.lineTo(x, by + h + 10); ctx.lineTo(x + 8, by + h - 1); ctx.closePath(); ctx.fill();
      // coloured header band + border
      ctx.save(); ctx.beginPath(); ctx.roundRect(bx, by, w, h, 12); ctx.clip();
      ctx.fillStyle = col; ctx.globalAlpha = Math.max(0, alpha) * .20; ctx.fillRect(bx, by, w, 26);
      ctx.globalAlpha = Math.max(0, alpha); ctx.fillRect(bx, by, 5, h);          // accent edge
      ctx.restore();
      ctx.strokeStyle = col; ctx.lineWidth = fresh ? 2.6 : 2; ctx.beginPath(); ctx.roundRect(bx, by, w, h, 12); ctx.stroke();
      ctx.fillStyle = col; ctx.font = "800 12px Inter, sans-serif"; ctx.textAlign = "left"; ctx.fillText(icon + "  " + head, bx + 14, by + 17);
      ctx.fillStyle = ink; ctx.font = "600 14px Inter, sans-serif"; lines.forEach((l, i) => ctx.fillText(l, bx + 14, by + 46 + i * 18));
      ctx.restore();
    });
  }
  function revive(id) { const n = byId[id]; if (n) n.alive = true; }
  function ring(cx, cy, n, r) { const out = []; for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / n; out.push([cx + Math.cos(a) * r * (i % 2 ? 1 : .78), cy + Math.sin(a) * r * (i % 2 ? .82 : 1)]); } return out; }
  function meshByRange(ids, range, kind) { for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { const a = byId[ids[i]], b = byId[ids[j]]; if (Math.hypot(a.x - b.x, a.y - b.y) < range) link(ids[i], ids[j], kind || "wifi"); } }
  function p95(arr) { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * .95))]; }

  const COL = { wifi: () => css("--green"), lora: () => css("--amber"), sat: () => css("--violet"), net: () => css("--blue"), ble: () => css("--blue") };

  // ---------------- Icons ----------------
  // A phone: rounded body, lit screen, speaker slot. Colour follows n.fill when a scenario sets one.
  function drawPhone(ctx, n, hot, paper, ink3) {
    const w = hot ? 22 : 20, h = hot ? 36 : 33, x = n.x - w / 2, y = n.y - h / 2;
    ctx.save();
    ctx.fillStyle = n.alive ? (n.fill || "#1b2a3e") : ink3; ctx.strokeStyle = paper; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 5); ctx.fill(); ctx.stroke();
    if (n.alive) {
      const g = ctx.createLinearGradient(x, y, x + w, y + h); g.addColorStop(0, n.fill ? "#ffffff88" : "#6aa5f0"); g.addColorStop(1, n.fill ? "#ffffff22" : "#2a6fd6");
      ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect(x + 3, y + 5, w - 6, h - 11, 2); ctx.fill();
      // signal bars on the screen
      ctx.fillStyle = "rgba(255,255,255,.85)"; [2, 4, 6, 8].forEach((bh, i) => ctx.fillRect(x + 5 + i * 3, y + 14 - bh, 2, bh));
      ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.fillRect(x + w / 2 - 3, y + 2, 6, 1.5);   // speaker
      ctx.fillStyle = "rgba(255,255,255,.6)"; ctx.beginPath(); ctx.arc(n.x, y + h - 3.5, 1.6, 0, Math.PI * 2); ctx.fill();   // home button
    }
    ctx.restore();
  }
  // An ESP32 + LoRa board: green PCB, gold pads, a chip, and an antenna with a little radio arc.
  function drawEsp(ctx, n, hot, paper, ink3) {
    const w = hot ? 34 : 30, h = hot ? 22 : 20, x = n.x - w / 2, y = n.y - h / 2 + 4;
    ctx.save();
    ctx.fillStyle = n.alive ? "#2f7d4f" : ink3; ctx.strokeStyle = paper; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 3); ctx.fill(); ctx.stroke();
    if (n.alive) {
      ctx.fillStyle = "#d9b14a"; for (let i = 0; i < 6; i++) { ctx.fillRect(x + 3 + i * 4.5, y + 1.5, 2, 2.5); ctx.fillRect(x + 3 + i * 4.5, y + h - 4, 2, 2.5); }   // pads
      ctx.fillStyle = "#1a1f24"; ctx.fillRect(x + 5, y + 6, 11, 8);   // ESP32 chip
      ctx.fillStyle = "#c33"; ctx.fillRect(x + 19, y + 7, 7, 6);      // LoRa module
      ctx.fillStyle = "#e6ecef"; ctx.font = "700 5px Inter, sans-serif"; ctx.textAlign = "left"; ctx.fillText("ESP32", x + 5.5, y + 12);
      // antenna
      const ax = x + w - 4, ay = y;
      ctx.strokeStyle = "#e6ecef"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax, ay - 11); ctx.stroke();
      ctx.fillStyle = "#e6ecef"; ctx.beginPath(); ctx.arc(ax, ay - 12, 2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#E2B54D"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(ax, ay - 12, 6, -2.3, -0.8); ctx.stroke(); ctx.beginPath(); ctx.arc(ax, ay - 12, 10, -2.3, -0.8); ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------- Rendering ----------------
  function draw() {
    const ink = css("--ink"), ink2 = css("--ink-2"), ink3 = css("--ink-3"), paper = css("--paper"), red = css("--red"), gold = css("--gold");
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = css("--canvas-grid"); ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    if (E.sc && E.sc.drawUnder) E.sc.drawUnder(ctx);
    // links
    E.links.forEach(l => {
      const a = byId[l.a], b = byId[l.b]; if (!a || !b) return;
      const dead = !l.up || !a.alive || !b.alive;
      if (l.hidden && dead) return;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.setLineDash(dead ? [3, 6] : l.kind === "lora" ? [9, 6] : l.kind === "sat" ? [2, 5] : []);
      const col = dead ? red : COL[l.kind]();
      if (!dead) { ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = l.kind === "wifi" ? 8 : 12; ctx.strokeStyle = col; ctx.globalAlpha = .35; ctx.lineWidth = (l.kind === "wifi" ? 2.2 : 2) + 3; ctx.stroke(); ctx.restore(); }
      ctx.strokeStyle = col; ctx.globalAlpha = dead ? .45 : (l.kind === "wifi" ? .75 : .95); ctx.lineWidth = dead ? 1.2 : l.kind === "wifi" ? (l.q != null ? 1.4 + l.q * 2 : 2.2) : 2;
      ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      if (l.label) { ctx.fillStyle = ink3; ctx.font = "500 10px JetBrains Mono, monospace"; ctx.textAlign = "center"; ctx.fillText(l.label, (a.x + b.x) / 2, (a.y + b.y) / 2 - 6 + (l.ly || 0)); }
    });
    if (E.sc && E.sc.draw) E.sc.draw(ctx);
    // packets
    E.packets.forEach(p => {
      const a = byId[p.from], b = byId[p.to]; const x = a.x + (b.x - a.x) * p.prog, y = a.y + (b.y - a.y) * p.prog;
      ctx.save(); ctx.shadowColor = p.color; ctx.shadowBlur = 10; ctx.beginPath(); ctx.arc(x, y, p.r, 0, Math.PI * 2); ctx.fillStyle = p.color; ctx.fill(); ctx.restore(); ctx.strokeStyle = paper; ctx.lineWidth = 1.5; ctx.stroke();
      if (p.label) { ctx.fillStyle = ink; ctx.font = "600 9.5px JetBrains Mono, monospace"; ctx.textAlign = "center"; ctx.fillText(p.label, x, y - p.r - 3); }
    });
    // range circle for the node under the pointer (or being dragged)
    const focus = UI.drag ? UI.drag.node : UI.hover;
    if (focus && focus.alive && E.sc && (E.sc.ranges || E.sc.rangeOf)) {
      const rs = E.sc.ranges ? E.sc.ranges(focus) : [{ r: E.sc.rangeOf(focus), color: focus.kind === "esp" ? gold : css("--green"), label: (focus.kind === "esp" ? "relay reach " : "phone reach ") + Math.round(E.sc.rangeOf(focus)) + " m" }];
      rs.filter(x => x.r).forEach(x => { ctx.beginPath(); ctx.arc(focus.x, focus.y, x.r, 0, Math.PI * 2); ctx.fillStyle = x.color; ctx.globalAlpha = .07; ctx.fill(); ctx.globalAlpha = .55; ctx.setLineDash([5, 6]); ctx.strokeStyle = x.color; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = ink3; ctx.font = "500 10px JetBrains Mono, monospace"; ctx.textAlign = "center"; ctx.fillText(x.label, focus.x, Math.max(12, focus.y - x.r - 6)); });
    }
    // nodes
    E.nodes.forEach(n => {
      ctx.globalAlpha = n.alive ? 1 : .5;
      const hot = n === focus;
      if (n.alive && (n.kind === "phone" || n.kind === "esp")) { ctx.save(); ctx.shadowColor = n.kind === "esp" ? gold : "#2a6fd6"; ctx.shadowBlur = hot ? 26 : 12; ctx.beginPath(); ctx.arc(n.x, n.y, n.r + (hot ? 2 : 0), 0, Math.PI * 2); ctx.fillStyle = "rgba(0,0,0,0.01)"; ctx.fill(); ctx.restore(); }
      if (n.ring) { ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 7, 0, Math.PI * 2); ctx.strokeStyle = n.ring; ctx.lineWidth = 2.5; ctx.stroke(); }
      ctx.fillStyle = n.alive ? (n.fill || (n.kind === "phone" ? "#2a6fd6" : n.kind === "esp" ? gold : n.kind === "cloud" ? css("--blue") : n.kind === "cmd" ? css("--gold-2") : n.kind === "sensor" ? css("--violet") : "#888")) : ink3;
      ctx.strokeStyle = paper; ctx.lineWidth = 2;
      if (n.kind === "esp") drawEsp(ctx, n, hot, paper, ink3);
      else if (n.kind === "cloud" || n.kind === "cmd") { ctx.beginPath(); ctx.roundRect(n.x - 34, n.y - 16, 68, 32, 8); ctx.fill(); ctx.stroke(); }
      else if (n.kind === "sat") { ctx.fillRect(n.x - 12, n.y - 6, 24, 12); ctx.strokeRect(n.x - 12, n.y - 6, 24, 12); ctx.fillRect(n.x - 30, n.y - 3, 14, 6); ctx.fillRect(n.x + 16, n.y - 3, 14, 6); }
      else if (n.kind === "phone") drawPhone(ctx, n, hot, paper, ink3);
      else { ctx.beginPath(); ctx.arc(n.x, n.y, n.r + (hot ? 2 : 0), 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      if (!n.alive) { ctx.strokeStyle = red; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(n.x - 8, n.y - 8); ctx.lineTo(n.x + 8, n.y + 8); ctx.moveTo(n.x + 8, n.y - 8); ctx.lineTo(n.x - 8, n.y + 8); ctx.stroke(); }
      ctx.globalAlpha = 1;
      if (n.kind === "cloud" || n.kind === "cmd") { ctx.fillStyle = "#fff"; ctx.font = "700 11px Inter, sans-serif"; ctx.textAlign = "center"; ctx.fillText(n.label, n.x, n.y + 4); }
      else { ctx.fillStyle = ink; ctx.font = "600 11px Inter, sans-serif"; ctx.textAlign = "center"; ctx.fillText(n.label, n.x, n.y + n.r + 14); }
      if (n.internet) { ctx.beginPath(); ctx.arc(n.x + n.r - 2, n.y - n.r + 2, 5, 0, Math.PI * 2); ctx.fillStyle = css("--green"); ctx.fill(); ctx.strokeStyle = paper; ctx.stroke(); }
      if (n.badge) { ctx.font = "700 9.5px JetBrains Mono, monospace"; const w = ctx.measureText(n.badge).width + 10; ctx.fillStyle = n.badgeColor || gold; ctx.beginPath(); ctx.roundRect(n.x - w / 2, n.y - n.r - 24, w, 15, 4); ctx.fill(); ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.fillText(n.badge, n.x, n.y - n.r - 13); }
      if (n.sub) { ctx.fillStyle = ink2; ctx.font = "500 10px JetBrains Mono, monospace"; ctx.textAlign = "center"; ctx.fillText(n.sub, n.x, n.y + n.r + 26); }
    });
    if (E.sc && E.sc.drawOver) E.sc.drawOver(ctx);
    drawBubbles();
  }

  // ---------------- Loop ----------------
  let last = performance.now(), logDirty = true, metricT = 0;
  function frame(now) {
    const real = Math.min(50, now - last); last = now;
    try { advance(real); } catch (err) { console.error(err); log("Something went wrong in the simulator: " + err.message, "bad"); E.paused = true; }
    if (logDirty) { renderLog(); logDirty = false; }
    draw(); setTimeout(() => frame(performance.now()), 16);
  }
  function advance(real) {
    if (!E.paused) {
      const dt = real * E.speed; E.t += dt;
      E.packets.forEach(p => { p.prog = Math.min(1, p.prog + dt / p.dur); });
      const arrived = E.packets.filter(p => p.prog >= 1); E.packets = E.packets.filter(p => p.prog < 1);
      arrived.forEach(p => { const n = byId[p.to]; if (n && n.alive) { if (p.onArrive) p.onArrive(n, p); if (E.sc.onArrive) E.sc.onArrive(n, p); } });
      const due = E.timers.filter(t => t.at <= E.t); E.timers = E.timers.filter(t => t.at > E.t); due.forEach(t => t.fn());
      if (E.sc.tick) E.sc.tick(dt);
      metricT += real; if (metricT > 250) { metricT = 0; renderMetrics(); $("clock").textContent = "t = " + fmtT(E.t); }
      if (autoRun && E.step < E.sc.steps.length - 1 && performance.now() - stepAt > (E.sc.stepGap || 9000)) nextStep();
    }
  }

  // ---------------- UI ----------------
  function renderMetrics() {
    if (!E.sc || !E.sc.metrics) return;
    $("metrics").innerHTML = E.sc.metrics().map(m => '<div class="metric' + (m.wide ? " wide" : "") + '"><b class="' + (m.cls || "") + '">' + m.value + "</b><span>" + m.label + "</span>" + (m.bar != null ? '<div class="bar"><i class="' + (m.barCls || "") + '" style="width:' + Math.max(0, Math.min(100, m.bar)) + '%"></i></div>' : "") + "</div>").join("");
  }
  function renderLog() { $("log").innerHTML = E.log.slice(0, 90).map(e => '<div class="' + e.cls + '"><span class="t">' + fmtT(e.t) + "</span><span>" + e.msg + "</span></div>").join(""); $("log-cnt").textContent = E.log.length + " events"; }
  function renderControls() {
    const box = $("controls"); box.innerHTML = "";
    (E.sc.controls || []).forEach(c => {
      const d = document.createElement("div"); d.className = "ctl";
      if (c.type === "range") {
        E.C[c.id] = c.value;
        d.innerHTML = '<label for="c-' + c.id + '">' + c.label + '</label><span class="v" id="v-' + c.id + '">' + c.value + (c.unit || "") + '</span><input type="range" id="c-' + c.id + '" min="' + c.min + '" max="' + c.max + '" step="' + (c.step || 1) + '" value="' + c.value + '">' + (c.desc ? '<span class="desc">' + c.desc + "</span>" : "");
        d.querySelector("input").addEventListener("input", ev => { E.C[c.id] = +ev.target.value; $("v-" + c.id).textContent = ev.target.value + (c.unit || ""); if (E.sc.onControl) E.sc.onControl(c.id, E.C[c.id]); });
      } else if (c.type === "switch") {
        E.C[c.id] = !!c.value;
        d.innerHTML = '<label class="switch"><input type="checkbox" id="c-' + c.id + '"' + (c.value ? " checked" : "") + ">" + c.label + "</label><span></span>" + (c.desc ? '<span class="desc">' + c.desc + "</span>" : "");
        d.querySelector("input").addEventListener("change", ev => { E.C[c.id] = ev.target.checked; if (E.sc.onControl) E.sc.onControl(c.id, E.C[c.id]); });
      } else if (c.type === "select") {
        E.C[c.id] = c.value;
        d.innerHTML = '<label for="c-' + c.id + '">' + c.label + "</label><span></span><select id=\"c-" + c.id + '">' + c.options.map(o => '<option value="' + o[0] + '"' + (o[0] == c.value ? " selected" : "") + ">" + o[1] + "</option>").join("") + "</select>" + (c.desc ? '<span class="desc">' + c.desc + "</span>" : "");
        d.querySelector("select").addEventListener("change", ev => { E.C[c.id] = isNaN(+ev.target.value) ? ev.target.value : +ev.target.value; if (E.sc.onControl) E.sc.onControl(c.id, E.C[c.id]); });
      } else if (c.type === "buttons") {
        d.innerHTML = (c.label ? "<label>" + c.label + "</label><span></span>" : "") + '<div class="row">' + c.buttons.map(b => '<button type="button" class="btn sm ' + (b.cls || "") + '" data-b="' + b.id + '">' + b.label + "</button>").join("") + "</div>" + (c.desc ? '<span class="desc">' + c.desc + "</span>" : "");
        d.querySelectorAll("[data-b]").forEach(b => b.addEventListener("click", () => { if (E.sc.onControl) E.sc.onControl(b.dataset.b, true); }));
      }
      box.appendChild(d);
    });
  }
  function setControl(id, v) { E.C[id] = v; const el = $("c-" + id); if (!el) return; if (el.type === "checkbox") el.checked = !!v; else el.value = v; const vv = $("v-" + id); if (vv) vv.textContent = v + ((E.sc.controls.find(c => c.id === id) || {}).unit || ""); }
  function renderTools() {
    const box = $("tools"); const tools = (E.sc && E.sc.tools) || []; box.hidden = !tools.length;
    box.innerHTML = tools.map(t => '<button type="button" class="tool' + (t.id === UI.tool ? " on" : "") + '" data-t="' + t.id + '" title="' + (t.tip || "") + '">' + t.label + "</button>").join("");
    box.querySelectorAll("[data-t]").forEach(b => b.addEventListener("click", () => { UI.tool = b.dataset.t; renderTools(); if (E.sc.onTool) E.sc.onTool(UI.tool); }));
    canvas.style.cursor = UI.tool === "move" ? "grab" : UI.tool === "wall" ? "crosshair" : UI.tool === "delete" ? "not-allowed" : "copy";
  }
  let autoRun = false, stepAt = 0;
  // The big play button: one press and the whole story runs by itself.
  function paintPlay() {
    const done = E.sc && E.step >= E.sc.steps.length - 1;
    const b = $("btn-play"), ico = b.querySelector(".play-ico"), lbl = b.querySelector(".play-lbl");
    b.classList.toggle("playing", autoRun);
    ico.textContent = autoRun ? "⏸" : done ? "↻" : "▶";
    lbl.textContent = autoRun ? "Pause" : done ? "Play again" : E.step < 0 ? "Play simulation" : "Keep playing";
    $("play-over").hidden = autoRun || E.step >= 0;
  }
  function setPlay(on) {
    if (on) {
      if (E.paused) { E.paused = false; $("btn-pause").textContent = "⏸"; $("btn-pause").classList.remove("on"); }
      if (E.sc && E.step >= E.sc.steps.length - 1) load(E.sc);   // finished → play it again from the top
    }
    autoRun = on;                                                // after load(), which clears it
    if (on) { if (E.step < 0) nextStep(); else stepAt = performance.now(); }
    paintPlay();
  }
  function renderSteps() {
    $("steps").innerHTML = E.sc.steps.map((s, i) => '<i class="' + (i < E.step ? "done" : i === E.step ? "cur" : "") + '"></i>').join("");
    $("narr").innerHTML = E.step < 0 ? E.sc.intro : E.sc.steps[E.step].text;
    $("btn-next").disabled = E.step >= E.sc.steps.length - 1; $("btn-next").textContent = E.step < 0 ? "Start →" : E.step >= E.sc.steps.length - 1 ? "Finished" : "Next →";
    paintPlay();
  }
  function nextStep() { if (E.step >= E.sc.steps.length - 1) return; E.step++; stepAt = performance.now(); const s = E.sc.steps[E.step]; if (s.run) s.run(); if (E.step >= E.sc.steps.length - 1) autoRun = false; renderSteps(); renderMetrics(); }
  function load(sc) {
    E.nodes.length = 0; E.links.length = 0; E.packets.length = 0; E.log.length = 0; E.timers.length = 0; E.bubbles.length = 0; E.t = 0; E.stats = {}; E.C = {}; E.step = -1; stepAt = 0; autoRun = false;
    for (const k in byId) delete byId[k];
    E.sc = sc; hint(sc.hint || "");
    $("sc-tier").textContent = sc.tier; $("sc-title").textContent = sc.title; $("sc-blurb").textContent = sc.blurb;
    document.querySelectorAll(".sc").forEach(b => b.classList.toggle("on", b.dataset.id === sc.id));
    UI.drag = null; UI.hover = null; UI.tool = (sc.tools && sc.tools[0].id) || "move"; renderTools();
    renderControls(); sc.setup(); renderSteps(); renderMetrics(); logDirty = true;
    try { history.replaceState(null, "", "#" + sc.id); } catch (e) {}
  }

  // ============================================================
  //  Scenarios
  // ============================================================
  const S = [];

  // ---------- 0. Build your own mesh (free play) ----------
  S.push({
    id: "sandbox", group: "Try it yourself", tier: "Free play · drag, add, block", title: "Build your own mesh",
    blurb: "Drag phones around. Add phones. Drop ESP32 relay boxes to bridge gaps. Draw walls — they cut phone-to-phone links, but relay boxes are mounted high and reach over them. Links appear and disappear on their own. Send a message and watch it go there and back.",
    hint: "Move: drag a phone. Pick a tool above to add phones, drop relays, draw walls, send a message, or remove things.",
    intro: "Two groups of phones, too far apart to talk. Press <b>Start</b> for a guided tour, or just start dragging things.",
    tools: [
      { id: "move", label: "✥ Move", tip: "Drag phones and relays" },
      { id: "phone", label: "+ Phone", tip: "Click on empty space to add a phone" },
      { id: "esp", label: "◆ Relay (ESP32)", tip: "Click to drop a relay box — long-range LoRa radio" },
      { id: "wall", label: "▬ Wall", tip: "Drag to draw a wall that blocks phone links" },
      { id: "send", label: "➤ Send", tip: "Click a phone, then another phone" },
      { id: "delete", label: "✕ Remove", tip: "Click a phone, relay or wall to remove it" }
    ],
    controls: [
      { id: "wifi", type: "range", label: "Phone reach (Wi-Fi Aware)", min: 50, max: 200, step: 10, value: 150, unit: " m", desc: "Phone to phone: about 100–200 m outdoors, less with obstacles. Walls block it." },
      { id: "attach", type: "range", label: "Relay-to-phone reach (ESP32 hotspot)", min: 30, max: 150, step: 10, value: 100, unit: " m", desc: "The ESP32's Wi-Fi hotspot reaches about 100 m outdoors. Boxes are mounted high, so a wall does not cut this link." },
      { id: "lora", type: "range", label: "Relay-to-relay reach (ESP32 LoRa)", min: 500, max: 5000, step: 100, value: 2000, unit: " m", desc: "LoRa between two ESP32 boxes on 865–868 MHz at up to 500 mW e.r.p. (Table II of India's 2021 rules): typically 2–5 km with a clear line of sight. This map is only about 1 km wide, so at the default every box reaches every other box." },
      { id: "traffic", type: "switch", label: "Phones chat on their own", value: true },
      { id: "acts", type: "buttons", buttons: [{ id: "clearWalls", label: "Clear walls" }, { id: "layout", label: "Reset layout" }] }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { walls: [], draft: null, pending: null, sent: 0, failed: 0, path: null, pathAt: 0, n: 0, acc: 0, groups: 1, pairs: 0, lastSay: {}, linkKeys: null });
      [["P1", 170, 220], ["P2", 260, 320], ["P3", 190, 420], ["P4", 390, 300], ["P5", 555, 300], ["P6", 675, 220], ["P7", 660, 400], ["P8", 775, 320]].forEach(p => node(p[0], p[1], p[2], "phone", p[0]));
      s.n = 8; this.rebuild();
    },
    rangeOf(n) { return n.kind === "esp" ? E.C.lora : E.C.wifi; },
    ranges(n) { return n.kind === "esp" ? [{ r: E.C.attach, color: css("--green"), label: "phones connect within " + E.C.attach + " m" }, { r: E.C.lora, color: css("--gold"), label: "other relay boxes within " + E.C.lora + " m (LoRa)" }] : [{ r: E.C.wifi, color: css("--green"), label: "phone reach " + E.C.wifi + " m" }]; },
    blocked(a, b) { return this.st.walls.some(w => segIntersect(a, b, { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 })); },
    rebuild() {
      const s = this.st; E.links.length = 0; const ns = E.nodes;
      for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
        const a = ns[i], b = ns[j]; const d = Math.hypot(a.x - b.x, a.y - b.y); const wall = this.blocked(a, b);
        // phones are at ground level: a wall between two phones cuts the link
        if (a.kind === "phone" && b.kind === "phone") { if (d < E.C.wifi && !wall) link(a.id, b.id, "wifi", { q: 1 - d / E.C.wifi }); }
        // relay boxes are mounted high (mast / roof), so a wall does not cut their links
        else if (a.kind === "esp" && b.kind === "esp") { if (d < E.C.lora) link(a.id, b.id, "lora", { delay: 700, label: wall ? "over the wall" : "" }); }
        else { if (d < E.C.attach) link(a.id, b.id, "wifi", { delay: 60, q: 1 - d / E.C.attach, label: wall ? "over the wall" : "" }); }
      }
      // connected groups + share of phone pairs that can talk
      const phones = ns.filter(n => n.kind === "phone"); let pairs = 0, ok = 0; const seen = new Set(); let groups = 0;
      phones.forEach(p => { if (!seen.has(p.id)) { groups++; reachable(p.id).forEach(x => seen.add(x)); } });
      for (let i = 0; i < phones.length; i++) { const rs = reachable(phones[i].id); for (let j = i + 1; j < phones.length; j++) { pairs++; if (rs.has(phones[j].id)) ok++; } }
      s.groups = groups; s.pairs = pairs ? Math.round(ok / pairs * 100) : 100;
      E.nodes.forEach(n => { if (n.kind === "esp") { const ph = neighbors(n.id).filter(x => byId[x].kind === "phone").length; n.sub = ph ? ph + " phone" + (ph > 1 ? "s" : "") + " connected" : "no phone in reach"; } });
    },
    announce() { // compare links before/after a user action and say what changed
      const s = this.st; const key = l => [l.a, l.b].sort().join("|"); const now = new Set(E.links.map(key)); const before = s.linkKeys || new Set();
      const lost = [...before].filter(k => !now.has(k)), got = [...now].filter(k => !before.has(k));
      lost.slice(0, 2).forEach(k => { const [a, b] = k.split("|"); const who = UI.drag && (UI.drag.node.id === a || UI.drag.node.id === b) ? UI.drag.node.id : a; const other = who === a ? b : a; if (E.t - (s.lastSay[k] || -9e9) > 2500) { s.lastSay[k] = E.t; say(who, "lost link to " + other + " — " + (this.blocked(byId[who], byId[other]) ? "a wall is in the way" : "too far apart"), "bad", 3200); } });
      got.slice(0, 2).forEach(k => { const [a, b] = k.split("|"); const who = UI.drag && (UI.drag.node.id === a || UI.drag.node.id === b) ? UI.drag.node.id : a; const other = who === a ? b : a; if (E.t - (s.lastSay[k] || -9e9) > 2500) { s.lastSay[k] = E.t; say(who, "linked to " + other + (byId[other] && byId[other].kind === "esp" || byId[who] && byId[who].kind === "esp" ? " (relay box)" : ""), "ok", 2600); } });
      s.linkKeys = now;
    },
    onMove() { this.rebuild(); this.announce(); },
    onControl(id) { const s = this.st; if (id === "clearWalls") { s.walls = []; log("Walls cleared", "sys"); } if (id === "layout") { const keep = E.C; load(this); Object.assign(E.C, keep); return; } this.rebuild(); },
    onPointerDown(pt, n, tool) {
      const s = this.st;
      if (tool === "phone" && !n) { const id = "P" + (++s.n); node(id, pt.x, pt.y, "phone", id); log("Added phone " + id, "ok"); this.rebuild(); const nb = neighbors(id).length; say(id, nb ? "new phone — linked to " + nb + " nearby" : "new phone — nobody in reach yet", nb ? "ok" : "warn"); s.linkKeys = new Set(E.links.map(l => [l.a, l.b].sort().join("|"))); }
      if (tool === "esp" && !n) { const id = "L" + (++s.n); node(id, pt.x, pt.y, "esp", id + " · relay"); log("Dropped relay box " + id + " — phones within " + E.C.attach + " m connect to it; it reaches other boxes over LoRa up to " + E.C.lora + " m", "ok"); this.rebuild(); const ph = neighbors(id).filter(x => byId[x].kind === "phone").length, lr = neighbors(id).filter(x => byId[x].kind === "esp").length; say(id, "relay box: " + (ph ? ph + " phone" + (ph > 1 ? "s" : "") + " connected" : "no phone in reach") + (lr ? " · LoRa to " + lr + " other box" + (lr > 1 ? "es" : "") : ""), ph ? "ok" : "warn"); s.linkKeys = new Set(E.links.map(l => [l.a, l.b].sort().join("|"))); }
      if (tool === "wall") s.draft = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
      if (tool === "delete") { if (n) { removeNode(n.id); log("Removed " + n.id, "warn"); this.rebuild(); s.linkKeys = new Set(E.links.map(l => [l.a, l.b].sort().join("|"))); } else { const w = s.walls.find(w => segDist(pt, { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }) < 10); if (w) { s.walls.splice(s.walls.indexOf(w), 1); log("Wall removed", "warn"); this.rebuild(); } } }
      if (tool === "send" && n && n.kind === "phone") this.onNodeClick(n);
    },
    onPointerMove(pt) { const s = this.st; if (s.draft) { s.draft.x2 = pt.x; s.draft.y2 = pt.y; } },
    onPointerUp() { const s = this.st; if (s.draft) { if (Math.hypot(s.draft.x2 - s.draft.x1, s.draft.y2 - s.draft.y1) > 12) { const w = s.draft; s.walls.push(w); const before = E.links.length; this.rebuild(); const cut = before - E.links.length; log("Wall drawn — phone links through it are cut; relay boxes still reach over it", "warn"); sayAt((w.x1 + w.x2) / 2, Math.min(w.y1, w.y2) - 4, cut > 0 ? "wall: " + cut + " phone link" + (cut > 1 ? "s" : "") + " cut — relay boxes still reach over it" : "wall — phone links can't cross it; relay boxes reach over it", "warn", 4000); s.linkKeys = new Set(E.links.map(l => [l.a, l.b].sort().join("|"))); } s.draft = null; this.rebuild(); } },
    onNodeClick(n) {
      const s = this.st; if (UI.tool !== "send" || n.kind !== "phone") return;
      if (!s.pending) { s.pending = n; E.nodes.forEach(x => { x.ring = null; }); n.ring = css("--gold"); log("From " + n.id + " — now click the phone it should reach", "sys"); say(n.id, "sending from here — now click the phone it should reach", "sys"); return; }
      if (s.pending === n) return; this.sendMsg(s.pending, n); s.pending.ring = null; s.pending = null;
    },
    sendMsg(a, b) {
      const s = this.st; const path = bfs(a.id, b.id);
      if (!path) { s.failed++; a.badge = "NO WAY THROUGH"; a.badgeColor = css("--red"); after(1800, () => { if (a.badge === "NO WAY THROUGH") a.badge = ""; }); log("No way from " + a.id + " to " + b.id + " — move a phone closer, or drop a relay in between", "bad"); say(a.id, "can't reach " + b.id + " — no path. Move a phone closer or drop a relay box between", "bad", 4000); return; }
      s.path = path; s.pathAt = E.t;
      const back = path.slice().reverse();
      say(a.id, "sending to " + b.id + " — " + (path.length - 1) + " hop" + (path.length > 2 ? "s" : "") + " via " + path.slice(1, -1).join(", ") + (path.length > 2 ? "" : "direct"), "sys", 2500);
      const reply = i => { if (i >= back.length - 1) { s.sent++; log(b.id + " → " + a.id + " reply delivered — two-way link confirmed", "ok"); say(a.id, "reply received from " + b.id + " ✓ two-way link works", "ok", 3500); return; } if (i > 0) say(back[i], "passing the reply on →", "info", 1400); send(back[i], back[i + 1], { color: css("--blue"), r: 5, label: i === 0 ? "reply" : "", onArrive: () => reply(i + 1) }); };
      const hop = i => { if (i >= path.length - 1) { s.sent++; log(a.id + " → " + b.id + " delivered in " + (path.length - 1) + " hop" + (path.length > 2 ? "s" : "") + " via " + path.join(" → ") + " — sending reply", "ok"); say(b.id, "got the message from " + a.id + " — sending a reply", "ok", 2500); after(300, () => reply(0)); return; } if (i > 0) say(path[i], byId[path[i]].kind === "esp" ? "relay box passing it on →" : "passing it on →", "info", 1400); send(path[i], path[i + 1], { color: css("--gold"), r: 5, label: i === 0 ? "msg" : "", onArrive: () => hop(i + 1) }); }; hop(0);
    },
    tick(dt) {
      const s = this.st; this.rebuild();
      if (!E.C.traffic) return; s.acc += dt; if (s.acc < 2200) return; s.acc = rnd(0, 600);
      const phones = E.nodes.filter(n => n.kind === "phone"); if (phones.length < 2) return;
      const a = phones[Math.floor(Math.random() * phones.length)]; let b = phones[Math.floor(Math.random() * phones.length)]; if (a === b) return;
      const path = bfs(a.id, b.id); if (!path) { s.failed++; return; }
      const hop = i => { if (i >= path.length - 1) { s.sent++; return; } send(path[i], path[i + 1], { color: css("--green"), r: 3.5, onArrive: () => hop(i + 1) }); }; hop(0);
    },
    drawUnder(ctx) {
      const s = this.st; const red = css("--red");
      const wall = (w, draft) => { ctx.save(); ctx.lineCap = "round"; ctx.setLineDash(draft ? [6, 6] : []); ctx.strokeStyle = red; ctx.globalAlpha = draft ? .6 : .25; ctx.lineWidth = 14; ctx.beginPath(); ctx.moveTo(w.x1, w.y1); ctx.lineTo(w.x2, w.y2); ctx.stroke(); ctx.globalAlpha = 1; ctx.lineWidth = 3; ctx.stroke(); ctx.restore(); };
      s.walls.forEach(w => wall(w, false)); if (s.draft) wall(s.draft, true);
      if (s.walls.length) { ctx.fillStyle = red; ctx.font = "700 10px Inter, sans-serif"; ctx.textAlign = "center"; s.walls.forEach(w => ctx.fillText("WALL", (w.x1 + w.x2) / 2, (w.y1 + w.y2) / 2 - 12)); }
      if (s.path && E.t - s.pathAt < 4000) { ctx.save(); ctx.globalAlpha = Math.max(0, 1 - (E.t - s.pathAt) / 4000) * .9; ctx.strokeStyle = css("--gold"); ctx.lineWidth = 9; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.shadowColor = css("--gold"); ctx.shadowBlur = 16; ctx.beginPath(); s.path.forEach((id, i) => { const n = byId[id]; if (!n) return; if (i) ctx.lineTo(n.x, n.y); else ctx.moveTo(n.x, n.y); }); ctx.stroke(); ctx.restore(); }
    },
    metrics() { const s = this.st; const phones = E.nodes.filter(n => n.kind === "phone").length, relays = E.nodes.filter(n => n.kind === "esp").length; return [{ label: "phones", value: phones }, { label: "relay boxes", value: relays }, { label: "walls", value: s.walls.length }, { label: "links", value: E.links.length }, { label: "separate groups", value: s.groups, cls: s.groups > 1 ? "warn" : "good" }, { label: "phones that can reach each other", value: s.pairs + " %", cls: s.pairs === 100 ? "good" : s.pairs < 50 ? "bad" : "warn", bar: s.pairs, barCls: s.pairs === 100 ? "green" : "amber" }, { label: "messages delivered", value: s.sent }, { label: "messages with no way through", value: s.failed, cls: s.failed ? "warn" : "" }]; },
    steps: [
      { text: "<b>Two groups, one gap.</b> The phones on the left can talk to each other, and so can the ones on the right — but not across the gap. Try it: pick the <b>Send</b> tool and click P4, then P5. No way through.", run() { UI.tool = "send"; renderTools(); } },
      { text: "<b>Drag a phone into the gap.</b> Pick <b>Move</b> and drag P4 to the middle. When it gets within reach of both sides, links appear on their own and the two groups become one.", run() { UI.tool = "move"; renderTools(); const p = byId.P4; if (p) { p.x = 407; p.y = 310; E.sc.rebuild(); log("P4 moved into the gap — within phone reach of both sides, it now bridges the two groups", "ok", "P4"); } } },
      { text: "<b>Or drop one relay box in the gap.</b> A phone can't stay there forever. Pick <b>Relay</b> and click in the middle. Phones on both sides connect to the box (it runs a Wi-Fi hotspot), and messages go through it both ways — P4 can go back to its team. Watch the message from P1 to P8 and the reply coming back.", run() { const p = byId.P4; if (p) { p.x = 390; p.y = 300; } node("L1", 480, 300, "esp", "L1 · relay"); E.sc.rebuild(); log("One relay box in the gap — both sides connect to its hotspot", "ok", "L1"); after(1200, () => E.sc.sendMsg(byId.P1, byId.P8)); } },
      { text: "<b>Wider gap? Two boxes talk over LoRa.</b> When the gap is wider than any hotspot can cover, put a box near each group. Each side's phones connect to their box, and the boxes talk to each other over LoRa — hundreds of metres. The right group has moved further away; the LoRa link holds.", run() { removeNode("L1"); node("L1", 400, 330, "esp", "L1 · relay"); node("L2", 700, 330, "esp", "L2 · relay"); ["P5", "P6", "P7", "P8"].forEach(id => { const n = byId[id]; if (n) n.x += 120; }); E.sc.rebuild(); log("Right group moved further away — L1 and L2 bridge it over LoRa (kilometres of reach)", "ok", "L2"); after(1200, () => E.sc.sendMsg(byId.P3, byId.P6)); } },
      { text: "<b>Now a wall.</b> Pick <b>Wall</b> and drag a line between two phones that are linked, say P1 and P2. Their link is cut — a collapsed building, a ridge. Relay boxes sit up high, so their links still reach over a wall, just not as far.", run() { E.sc.st.walls.push({ x1: 240, y1: 200, x2: 160, y2: 300 }); E.sc.rebuild(); log("Wall drawn between P1 and P2 — P1 is cut off", "warn", "P1"); } },
      { text: "<b>Bridge the wall.</b> Drop a relay box on each side, near a phone. Boxes are mounted high, so the wall doesn't touch their links: P1 connects to its box, the boxes talk over LoRa, and the message from P1 to P2 goes over the wall and comes back.", run() { node("L3", 140, 260, "esp", "L3 · relay"); node("L4", 300, 270, "esp", "L4 · relay"); E.sc.rebuild(); log("Relay boxes on both sides of the wall — P1 reconnected, message goes over the wall", "ok", "L3"); after(1200, () => E.sc.sendMsg(byId.P1, byId.P2)); } },
      { text: "<b>Your turn.</b> Add phones, move them apart until links break, drop relays, draw walls, remove things, and send messages to see the path light up. The numbers on the right tell you how connected everyone is.", run() { UI.tool = "move"; renderTools(); } }
    ]
  });

  // ---------- 1. Leaderless cluster ----------
  S.push({
    id: "leaderless", group: "Phones talking to phones", tier: "Step 1 · a group with no leader", title: "A group of phones with no leader",
    blurb: "Seven phones find each other on their own and link to every phone nearby. No phone is the boss. Knock some out and the rest keep talking through whatever links are left.",
    hint: "Drag phones to move them. Click a phone to switch it off; click again to switch it on.",
    intro: "The small green dots are location updates passing between phones. Drag a phone and watch its links change. Press <b>Start</b> to see what happens when phones are lost.",
    controls: [
      { id: "range", type: "range", label: "How far a phone can reach", min: 180, max: 340, step: 10, value: 310, unit: " px", desc: "About 100–200 m in real life, less with walls in the way. Shorter reach = fewer links." },
      { id: "reset", type: "buttons", buttons: [{ id: "revive", label: "Switch everyone back on" }] }
    ],
    st: {}, setup() {
      const s = this.st; s.delivered = 0; s.emit = 0; s.alive = 7; s.reach = 7; s.outage = 0;
      ring(480, 290, 7, 190).forEach((p, i) => node("P" + (i + 1), p[0], p[1], "phone", "P" + (i + 1)));
      this.rebuild();
    },
    rebuild() { E.links.length = 0; meshByRange(E.nodes.map(n => n.id), E.C.range || 310, "wifi"); },
    onMove() { this.rebuild(); }, rangeOf(n) { return n.kind === "phone" ? (E.C.range || 310) : 0; },
    onControl(id) { if (id === "range") { this.rebuild(); } if (id === "revive") { E.nodes.forEach(n => revive(n.id)); this.rebuild(); log("All phones are back on", "ok"); } },
    onNodeClick(n) {
      if (n.alive) { kill(n.id); log(n.id + " switched off — only its own links are lost", "bad", n.id); }
      else { revive(n.id); log(n.id + " back on — its neighbours found it again by themselves", "ok", n.id); }
      this.rebuild();
    },
    tick(dt) {
      const s = this.st;
      s.emit += dt; if (s.emit > 1800) { s.emit = 0; const alive = E.nodes.filter(n => n.alive); const src = alive[Math.floor(Math.random() * alive.length)]; if (src) { const pid = Math.random().toString(36).slice(2, 8); flood(src.id, null, { color: css("--green"), r: 4, payload: { pid, ttl: 4 } }); } }
      const alive = E.nodes.filter(n => n.alive); s.alive = alive.length;
      const sizes = alive.map(n => reachable(n.id).size); s.reach = sizes.length ? Math.max(...sizes) : 0;
      if (alive.length && s.reach < alive.length) s.outage += dt;
    },
    onArrive(n, p) { const { pid, ttl } = p.payload; if (!pid || n.seen.has(pid)) return; n.seen.add(pid); this.st.delivered++; if (ttl > 0) flood(n.id, p.from, { color: css("--green"), r: 4, payload: { pid, ttl: ttl - 1 } }); },
    metrics() { const s = this.st; return [{ label: "phones on", value: s.alive + " / 7" }, { label: "phones that can reach each other", value: s.reach + " / " + s.alive, cls: s.reach < s.alive ? "bad" : "good" }, { label: "time the group was split", value: fmtT(s.outage), cls: s.outage ? "warn" : "good" }, { label: "updates delivered", value: s.delivered }]; },
    steps: [
      { text: "<b>Phones find each other by themselves.</b> Any two phones close enough get a link. Nobody is in charge, and nobody has to scan a code or set anything up.", run() { } },
      { text: "<b>Switch off P1.</b> Only P1's own links are lost. The updates keep flowing through everyone else. Nothing stops.", run() { E.sc.onNodeClick(byId.P1); } },
      { text: "<b>Switch off two more.</b> P3 and P5 go too. The rest are still all connected through the links that are left. Losing a phone never brings the group down.", run() { E.sc.onNodeClick(byId.P3); E.sc.onNodeClick(byId.P5); } },
      { text: "<b>Distance is the real limit.</b> Shorten the reach and the links thin out until the group splits in two. Each half keeps working on its own. In the field, the fix is more phones in between, or higher ground — not a stronger radio.", run() { setControl("range", 200); E.sc.rebuild(); } },
      { text: "<b>Coming back is automatic.</b> Switch the phones back on and their neighbours pick them up again. Nobody has to do anything. Try clicking phones yourself.", run() { setControl("range", 310); E.sc.onControl("revive"); } }
    ]
  });

  // ---------- 2. Managed flooding ----------
  S.push({
    id: "flooding", group: "Phones talking to phones", tier: "Step 1 · how a message finds its way", title: "How a message finds its way",
    blurb: "No phone knows the whole map. So a message is simply passed to every neighbour, and they pass it on. The first copy to arrive wins; repeats are thrown away. A hop counter stops it going on forever.",
    hint: "Send a message from A to I. Then try a hop limit of 2, and try turning off the repeat check.",
    intro: "Nine phones linked by distance. Press <b>Start</b> to send a message from <b>A</b> to <b>I</b> and watch the copies spread.",
    controls: [
      { id: "ttl", type: "range", label: "Hop limit", min: 1, max: 8, value: 5, desc: "Goes down by one at every phone. At zero the message is dropped." },
      { id: "dedup", type: "switch", label: "Repeat check (remember seen messages)", value: true, desc: "Off = a phone passes on every copy it gets, even ones it has passed on before." },
      { id: "send", type: "buttons", buttons: [{ id: "sendAI", label: "Send A → I", cls: "primary" }, { id: "clear", label: "Clear" }] }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { copies: 0, dup: 0, ttlDrop: 0, delivered: null, hops: null, sentAt: null, seq: 0 });
      const P = [["A", 90, 280], ["B", 230, 150], ["C", 240, 410], ["D", 400, 260], ["E", 470, 120], ["F", 520, 420], ["G", 660, 250], ["H", 720, 420], ["I", 870, 300]];
      P.forEach(p => node(p[0], p[1], p[2], "phone", p[0])); meshByRange(P.map(p => p[0]), 235, "wifi");
      byId.A.ring = css("--gold"); byId.I.ring = css("--violet"); byId.A.sub = "source"; byId.I.sub = "destination";
    },
    onMove() { E.links.length = 0; meshByRange(E.nodes.map(n => n.id), 235, "wifi"); }, rangeOf(n) { return 235; },
    onControl(id) { if (id === "sendAI") this.fire(); if (id === "clear") { E.packets.length = 0; E.nodes.forEach(n => { n.seen.clear(); n.badge = ""; }); Object.assign(this.st, { copies: 0, dup: 0, ttlDrop: 0, delivered: null, hops: null }); } },
    fire() {
      const s = this.st; E.nodes.forEach(n => { n.seen.clear(); n.badge = ""; }); Object.assign(s, { copies: 0, dup: 0, ttlDrop: 0, delivered: null, hops: null, sentAt: E.t, pid: "pkt-" + (++s.seq) });
      byId.A.seen.add(s.pid);
      s.copies += flood("A", null, { color: css("--gold"), label: "ttl " + (E.C.ttl - 1), payload: { pid: s.pid, ttl: E.C.ttl - 1, hops: 1 } });
      log("A sends the message to its " + neighbors("A").length + " neighbours, hop limit " + E.C.ttl, "sys", "A");
    },
    onArrive(n, p) {
      const s = this.st, { pid, ttl, hops } = p.payload; if (pid !== s.pid) return;
      if (n.id === "I") { if (s.delivered == null) { s.delivered = E.t - s.sentAt; s.hops = hops; n.badge = "DELIVERED"; n.badgeColor = css("--green"); log("I got the message after " + hops + " hops in " + fmtT(s.delivered) + " — the first copy wins", "ok", "I"); } else { s.dup++; } return; }
      if (E.C.dedup && n.seen.has(pid)) { s.dup++; n.badge = "repeat ×" + (++n.dups || 1); n.badgeColor = css("--ink-3"); if (n.dups === 1) say(n.id, "seen this one already — thrown away", "", 1800); return; }
      n.seen.add(pid); n.dups = 0;
      if (ttl <= 0) { s.ttlDrop++; n.badge = "hops used up"; n.badgeColor = css("--red"); say(n.id, "no hops left — dropped", "bad", 1800); return; }
      s.copies += flood(n.id, p.from, { color: css("--gold"), label: "ttl " + (ttl - 1), payload: { pid, ttl: ttl - 1, hops: hops + 1 } });
      if (s.copies > 400) { E.packets.length = 0; log("Stopped at 400 copies — this flood is exactly what the hop limit and repeat check prevent.", "bad"); }
    },
    metrics() { const s = this.st; return [{ label: "copies sent", value: s.copies, cls: s.copies > 60 ? "bad" : "" }, { label: "repeats thrown away", value: s.dup }, { label: "dropped — hops used up", value: s.ttlDrop }, { label: "reached I", value: s.delivered == null ? "—" : fmtT(s.delivered) + " · " + s.hops + " hops", cls: s.delivered == null ? "" : "good" }, { label: "on the way now", value: E.packets.length }]; },
    steps: [
      { text: "<b>Send A → I with a hop limit of 5.</b> A gives the message to every neighbour. Each phone asks three things: is it for me? any hops left? have I seen it before? Then it passes it on to everyone except the phone it came from.", run() { E.sc.fire(); } },
      { text: "<b>The first copy wins.</b> I got the message by the shortest path. The copies still arriving are thrown away. Phones that saw the same message twice show a <b>repeat</b> tag. Notice how few copies it took.", run() { } },
      { text: "<b>Hop limit too small.</b> The same message with a limit of 2. It dies two phones out and never reaches I. The limit has to be big enough for the longest path you need — three hops is the target.", run() { setControl("ttl", 2); E.sc.fire(); } },
      { text: "<b>Repeat check off, hop limit 6.</b> Now every phone passes on every copy, even ones bouncing back. Watch the copy count climb. This is a flood, and it only stops because the hops run out.", run() { setControl("ttl", 6); setControl("dedup", false); E.sc.fire(); } },
      { text: "<b>Back to normal.</b> Repeat check on, hop limit 5. Same result, a fraction of the traffic. These two simple checks are what make this cheap.", run() { setControl("dedup", true); setControl("ttl", 5); E.sc.fire(); } }
    ]
  });

  // ---------- 3. PTT voice ----------
  S.push({
    id: "ptt", group: "Phones talking to phones", tier: "Voice · push-to-talk", title: "Talking over three phones in between",
    blurb: "A talks, D listens. There are three phones in between and two possible paths. Every 80 ms a tiny piece of voice is sent along both paths. D keeps the first copy, waits a moment to smooth things out, then plays it. Goal: the delay from mouth to ear stays under half a second.",
    hint: "Hold the talk button with the switch. Add loss and delay; then cut the link between B and C.",
    intro: "Two paths from A to D: A–B–C–D and A–E–F–D. Press <b>Start</b> to begin talking.",
    controls: [
      { id: "talk", type: "switch", label: "Talk button held (A speaking)", value: false },
      { id: "loss", type: "range", label: "Pieces lost on each link", min: 0, max: 30, value: 0, unit: " %" },
      { id: "jitter", type: "range", label: "Uneven delay on each link", min: 0, max: 150, value: 0, unit: " ms" },
      { id: "buf", type: "range", label: "Smoothing wait before playing", min: 80, max: 240, step: 10, value: 120, unit: " ms", desc: "D waits this long before playing, so uneven arrivals sound smooth. The app adjusts this between 80 and 240 ms." },
      { id: "wall", type: "switch", label: "Wall between B and C", value: false, desc: "Cuts the B–C link while A is talking." }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { seq: 0, acc: 0, rx: {}, played: 0, concealed: 0, late: 0, dup: 0, lat: [], first: null, buffered: 0 });
      node("A", 110, 280, "phone", "A · talker"); node("B", 330, 150, "phone", "B"); node("C", 590, 150, "phone", "C"); node("D", 850, 280, "phone", "D · listener"); node("E", 330, 420, "phone", "E"); node("F", 590, 420, "phone", "F");
      link("A", "B"); link("B", "C"); link("C", "D"); link("A", "E", "wifi", { delay: 55 }); link("E", "F", "wifi", { delay: 55 }); link("F", "D", "wifi", { delay: 55 });
      byId.A.ring = css("--gold"); byId.D.ring = css("--violet");
    },
    onControl(id, v) { if (id === "wall") { linkBetween("B", "C").up = !v; log(v ? "Wall: the B–C link is cut while A is talking" : "B–C link is back", v ? "bad" : "ok", "C"); if (v) say("D", "still hearing A — the voice was already flowing via E and F", "ok", 4000); } if (id === "talk") { byId.A.badge = v ? "TALKING" : ""; byId.A.badgeColor = css("--red"); if (v) { this.st.first = null; log("Talk button pressed — A stops listening and starts sending tiny voice pieces", "sys", "A"); } else log("Talk button released — A's mic closes, it can hear again", "sys", "A"); } },
    tick(dt) {
      const s = this.st; E.links.forEach(l => { l.loss = E.C.loss / 100; });
      if (E.C.talk) { s.acc += dt; while (s.acc >= 80) { s.acc -= 80; const seq = s.seq++; const t0 = E.t; flood("A", null, { color: css("--red"), r: 4, jitter: E.C.jitter, payload: { seq, t0 } }); } }
      // playout clock at D
      if (s.first != null) {
        for (const k in s.rx) { const r = s.rx[k]; const due = s.first.t + E.C.buf + (r.seq - s.first.seq) * 80; if (!r.done && E.t >= due) { r.done = true; if (r.buffered) { s.played++; s.lat.push(due - r.t0); if (s.lat.length > 200) s.lat.shift(); } else { s.concealed++; } } }
        s.buffered = Object.values(s.rx).filter(r => r.buffered && !r.done).length;
        for (const k in s.rx) if (s.rx[k].done && Object.keys(s.rx).length > 300) delete s.rx[k];
      }
    },
    onArrive(n, p) {
      const s = this.st, { seq, t0 } = p.payload; if (seq == null) return;
      if (n.id === "D") {
        if (s.rx[seq] && s.rx[seq].buffered) { s.dup++; return; }
        if (s.first == null) s.first = { seq, t: E.t };
        const due = s.first.t + E.C.buf + (seq - s.first.seq) * 80;
        if (E.t > due) { s.late++; s.rx[seq] = s.rx[seq] || { seq, t0, done: true, buffered: false }; return; }   // never retransmit late voice
        s.rx[seq] = { seq, t0, buffered: true, done: false }; return;
      }
      if (n.seen.has("v" + seq)) return; n.seen.add("v" + seq); if (n.seen.size > 60) n.seen.delete(n.seen.values().next().value);
      flood(n.id, p.from, { color: css("--red"), r: 4, jitter: E.C.jitter, payload: { seq, t0 } });
    },
    metrics() { const s = this.st; const p = Math.round(p95(s.lat)); const tot = s.played + s.concealed || 1; return [{ label: "delay, mouth to ear", value: (s.lat.length ? p + " ms" : "—"), cls: p > 500 ? "bad" : p ? "good" : "", bar: p / 5, barCls: p > 500 ? "red" : "green" }, { label: "pieces played", value: s.played }, { label: "pieces missing (filled in)", value: s.concealed + " · " + Math.round(s.concealed / tot * 100) + "%", cls: s.concealed / tot > .05 ? "bad" : "" }, { label: "arrived too late", value: s.late }, { label: "repeats thrown away", value: s.dup }, { label: "waiting to be played", value: s.buffered + " pieces", bar: s.buffered / (E.C.buf / 80 + 2) * 100 }]; },
    steps: [
      { text: "<b>Press the talk button.</b> Every 80 ms A sends one tiny piece of voice (about 128 bytes). It goes down both paths. D keeps the first copy of each piece and throws the other away.", run() { setControl("talk", true); E.sc.onControl("talk", true); } },
      { text: "<b>Lose 10 % of pieces on every link.</b> A piece lost on one path usually still arrives by the other. That is the protection. If a piece is lost on both, D fills the gap with a soft sound. It never asks for it again — too late for a conversation.", run() { setControl("loss", 10); } },
      { text: "<b>Make the delay uneven.</b> Pieces now arrive in fits and starts. The short wait before playing smooths that out. Pieces that miss their turn are dropped as <b>late</b>. Playing them the instant they arrive would sound robotic.", run() { setControl("jitter", 80); } },
      { text: "<b>Cut the B–C link.</b> One phone steps behind a wall. The voice keeps going over A–E–F–D with no gap, because it was already flowing there. Nothing had to be re-planned.", run() { setControl("wall", true); E.sc.onControl("wall", true); } },
      { text: "<b>Wait 240 ms before playing.</b> Fewer late pieces — but the delay from mouth to ear goes up by the same amount. The app balances these two between 80 and 240 ms.", run() { setControl("buf", 240); } }
    ]
  });

  // ---------- 4. Image transfer ----------
  S.push({
    id: "image", group: "Phones talking to phones", tier: "Photos · sent in small pieces", title: "Sending a photo piece by piece",
    blurb: "A 40 KB photo is cut into 40 pieces of 1 KB. Each piece is passed one phone at a time, and each phone keeps a whole piece before passing it on. If a phone in the middle walks away, the sender waits for another path, asks the receiver which piece it got last, and carries on from there. We also show sending over two paths at once — and why we don't do that.",
    hint: "Start sending, then make phone C walk away. Then try the two-paths-at-once mode.",
    intro: "A sends, D receives. Main path A–B–C–D, spare path A–E–F–D. Press <b>Start</b> to send 40 pieces.",
    controls: [
      { id: "start", type: "buttons", buttons: [{ id: "go", label: "Start sending", cls: "primary" }, { id: "walk", label: "Phone C walks away", cls: "danger" }, { id: "back", label: "C comes back" }] },
      { id: "multi", type: "switch", label: "Send over both paths at once (we don't)", value: false, desc: "Every other piece goes the other way. Watch the 'open links' count at the middle phones — a phone can only hold about 4." }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { total: 40, next: 0, verified: -1, active: false, outstanding: {}, resumes: 0, retx: 0, ooo: 0, lastSeq: -1, t0: null, done: null, sendAcc: 0, path: ["A", "B", "C", "D"], alt: ["A", "E", "F", "D"], stored: {}, locked: false });
      node("A", 110, 280, "phone", "A · sender"); node("B", 330, 150, "phone", "B"); node("C", 590, 150, "phone", "C"); node("D", 850, 280, "phone", "D · receiver"); node("E", 330, 420, "phone", "E"); node("F", 590, 420, "phone", "F");
      link("A", "B"); link("B", "C"); link("C", "D"); link("A", "E"); link("E", "F"); link("F", "D");
      ["B", "C", "E", "F"].forEach(id => { byId[id].ndp = 2; }); // background NDPs already open at relays
      this.badges();
    },
    badges() { ["B", "C", "E", "F"].forEach(id => { const n = byId[id]; n.sub = "open links " + n.ndp + "/4" + (n.ndp > 4 ? " ⚠" : ""); }); byId.D.sub = "got " + (this.st.verified + 1) + "/" + this.st.total; },
    onControl(id, v) {
      const s = this.st;
      if (id === "go") { Object.assign(s, { next: 0, verified: -1, active: true, outstanding: {}, resumes: 0, retx: 0, ooo: 0, lastSeq: -1, t0: E.t, done: null, stored: {} }); E.nodes.forEach(n => { n.badge = ""; }); log("Start: 40 KB photo → 40 pieces of 1 KB, one phone at a time along " + s.path.join("–"), "sys", "A"); }
      if (id === "walk") { kill("C"); log("Phone C walked away — the pieces it was holding are lost", "bad", "C"); }
      if (id === "back") { revive("C"); log("C is back", "ok"); }
      if (id === "multi") { ["B", "C", "E", "F"].forEach(x => { byId[x].ndp = 2; }); s.locked = false; log(v ? "Both paths at once — pieces alternate between them" : "One path at a time", v ? "warn" : "sys"); }
      this.badges();
    },
    route(k) { const s = this.st; const pathUp = p => p.every(id => byId[id].alive); if (E.C.multi) { const both = [s.path, s.alt].filter(pathUp); return both.length ? both[k % both.length] : null; } return pathUp(s.path) ? s.path : pathUp(s.alt) ? s.alt : null; },
    tick(dt) {
      const s = this.st; if (!s.active) return;
      // NDP accounting: an active route holds one data path open at each relay it crosses
      ["B", "C", "E", "F"].forEach(id => { byId[id].ndp = 2; });
      const routes = E.C.multi ? [s.path, s.alt] : [this.route(0)]; routes.filter(Boolean).forEach(r => r.slice(1, -1).forEach(id => { byId[id].ndp += 1; }));
      if (E.C.multi) ["B", "C", "E", "F"].forEach(id => { byId[id].ndp += 1; }); // ARQ/control paths back to the sender
      const over = ["B", "C", "E", "F"].some(id => byId[id].ndp > 4); if (over && !s.locked) { s.locked = true; log("A middle phone has more links open than it can handle — everything else through it is stuck", "bad", ["B", "C", "E", "F"].find(id => byId[id].ndp > 4)); } if (!over) s.locked = false;
      // timeouts → checkpointed resume
      for (const k in s.outstanding) { if (E.t - s.outstanding[k] > 1400) { delete s.outstanding[k]; const r = this.route(+k); if (!r) { byId.A.badge = "WAITING FOR A PATH"; byId.A.badgeColor = css("--amber"); return; } s.resumes++; s.retx++; log("No confirmation for piece " + k + ". A asks D: which piece did you get last? → " + s.verified + ". Carrying on from " + (s.verified + 1) + " along " + r.join("–") + ".", "warn", "A"); say("D", "last piece I got: #" + s.verified, "info", 2500); s.next = s.verified + 1; byId.A.badge = "CONTINUING FROM " + s.next; byId.A.badgeColor = css("--green"); for (const j in s.outstanding) delete s.outstanding[j]; } }
      s.sendAcc += dt; const gap = s.locked ? 520 : 130;
      if (s.sendAcc >= gap && s.next < s.total && Object.keys(s.outstanding).length < 6) { s.sendAcc = 0; const k = s.next++; const r = this.route(k); if (!r) { s.next--; byId.A.badge = "WAITING FOR A PATH"; byId.A.badgeColor = css("--amber"); return; } byId.A.badge = ""; s.outstanding[k] = E.t; this.hop(k, r, 0); }
      if (s.verified >= s.total - 1 && !s.done) { s.done = E.t - s.t0; s.active = false; byId.D.badge = "PHOTO COMPLETE"; byId.D.badgeColor = css("--green"); log("All 40 pieces received in " + fmtT(s.done) + (s.resumes ? ", carrying on " + s.resumes + " time(s) after a break" : ""), "ok", "D"); }
    },
    hop(k, r, i) {
      const s = this.st; const from = r[i], to = r[i + 1]; if (!to) return;
      send(from, to, { color: css("--blue"), label: "#" + k, dur: s.locked ? 900 : undefined, payload: { k, r, i: i + 1 }, onArrive: (n, p) => {
        if (n.id === "D") { if (k > s.verified + 1 && E.C.multi) s.ooo++; if (k === s.verified + 1) { s.verified = k; while (s.stored["D" + (s.verified + 1)]) s.verified++; } else s.stored["D" + k] = true; delete s.outstanding[k]; this.badges(); return; }
        s.stored[n.id + ":" + k] = true; this.hop(k, r, p.payload.i);   // store fully, then forward
      } });
    },
    metrics() { const s = this.st; const maxNdp = Math.max(...["B", "C", "E", "F"].map(id => byId[id] ? byId[id].ndp : 0)); return [{ label: "pieces received by D", value: (s.verified + 1) + " / " + s.total, bar: (s.verified + 1) / s.total * 100, barCls: "green" }, { label: "times it carried on after a break", value: s.resumes }, { label: "pieces sent again", value: s.retx }, { label: "arrived out of order", value: s.ooo, cls: s.ooo ? "warn" : "" }, { label: "most links open at one phone", value: maxNdp + " / 4", cls: maxNdp > 4 ? "bad" : "good" }, { label: "time taken", value: s.done ? fmtT(s.done) : s.t0 ? fmtT(E.t - s.t0) : "—" }]; },
    steps: [
      { text: "<b>Start sending.</b> Pieces move one phone at a time. B holds a whole piece before passing it on. D counts the pieces in order and reports how far it has got.", run() { E.sc.onControl("go"); } },
      { text: "<b>Phone C walks away.</b> The pieces inside C are gone. A stops getting confirmations. Instead of starting from zero, it asks D: which piece did you get last?", run() { E.sc.onControl("walk"); } },
      { text: "<b>Carry on by the spare path.</b> A continues from the next piece along A–E–F–D. The photo finishes with a handful of pieces sent twice, not all forty.", run() { } },
      { text: "<b>What we don't do: both paths at once.</b> C is back. Now pieces alternate between the two paths. Look at the middle phones: every open path uses up one of the few links a phone can hold (about 4). They go over the limit, everything through them slows down, and pieces arrive out of order.", run() { E.sc.onControl("back"); setControl("multi", true); E.sc.onControl("multi", true); E.sc.onControl("go"); } },
      { text: "<b>Why one path is better.</b> Speed was never the problem — the number of open links was. One path, plus carrying on from where it stopped, leaves the rest of the network free.", run() { setControl("multi", false); E.sc.onControl("multi", false); } }
    ]
  });

  // ---------- 5. LoRa under India's 2021 rules ----------
  // Time on air, Semtech SX126x formula (explicit header, CRC on, 8-symbol preamble, CR 4/5).
  function loraAirtime(bytes, sf, bw) { bw = bw || 125000; const cr = 1, de = sf >= 11 ? 1 : 0; const ts = Math.pow(2, sf) / bw; const pre = (8 + 4.25) * ts; const ps = 8 + Math.max(Math.ceil((8 * bytes - 4 * sf + 28 + 16) / (4 * (sf - 2 * de))) * (cr + 4), 0); return (pre + ps * ts) * 1000; }
  // G.S.R. 853(E), 10 Dec 2021 — 865–868 MHz licence-exempt short-range devices.
  const REG = {
    t1:    { name: "Table I · general data", duty: 0.01,  power: "25 mW e.r.p.",  bwMax: 0,      note: "the old 1 % assumption" },
    t2node:{ name: "Table II · tracking & data · ordinary node", duty: 0.025, power: "500 mW e.r.p.", bwMax: 200000, note: "2.5 % for a node that only sends its own data" },
    t2ap:  { name: "Table II · tracking & data · network access point", duty: 0.10, power: "500 mW e.r.p.", bwMax: 200000, note: "10 % for a box that forwards traffic for others — every relay box in this design" },
    lic:   { name: "Licensed public-safety spectrum", duty: 1.0, power: "per licence", bwMax: 0, note: "for a real deployment by NDRF / SDRF / police; limits are set by the licence, not the SRD table" }
  };
  S.push({
    id: "lora", group: "Linking groups with LoRa radios", tier: "Step 2 · the LoRa radio link", title: "The LoRa link under India's 2021 rules",
    blurb: "Two groups of phones, each with an ESP32 radio box. LoRa on 865–868 MHz is licence-free in India, but the 2021 rules (G.S.R. 853(E)) limit how much of each hour a box may transmit. Most guides quote a flat 1 %. Pick the right category and the right settings, and the same radio legally carries ten to thirty times more.",
    hint: "Change the category, the spreading factor, the report size and the bandwidth. Raise an SOS while the radio is busy.",
    intro: "Each phone reports its location on the timer you set. The gateway phone hands it to the radio box, which sends it to the command centre over LoRa. Press <b>Start</b> to begin with the old 1 % assumption.",
    controls: [
      { id: "cat", type: "select", label: "Regulatory category (G.S.R. 853(E))", value: "t2ap", options: [["t1", "Table I · general data · 1 % · 25 mW"], ["t2node", "Table II · tracking · ordinary node · 2.5 % · 500 mW"], ["t2ap", "Table II · tracking · network access point · 10 % · 500 mW"], ["lic", "Licensed public-safety spectrum · no duty limit"]], desc: "Table II covers tracking, tracing and data acquisition — including emergency detection of buried victims. Our boxes forward traffic for others, so they are network access points." },
      { id: "sf", type: "select", label: "Spreading factor", value: "auto", options: [["auto", "Adaptive — lowest SF the link allows (with APC)"], [7, "SF7 — fixed"], [9, "SF9 — fixed"], [12, "SF12 — fixed, contingency"]], desc: "SF7 costs about a third of SF9 on air and a twenty-third of SF12. Adaptive SF and adaptive power come from the same link-margin measurement." },
      { id: "pkt", type: "select", label: "Position report", value: 164, options: [[164, "164 B — full signature on every report"], [76, "76 B — compact, batch-signed (routine only)"], [96, "96 B — one summary per group"]], desc: "Keep the 64-byte signature on SOS and commands. Routine positions can be batch-signed, delta-coded and use ID codes instead of names." },
      { id: "bw", type: "select", label: "Bandwidth", value: 125, options: [[125, "125 kHz — allowed (≤ 200 kHz)"], [250, "250 kHz — faster, but not allowed under Table II"]] },
      { id: "interval", type: "range", label: "How often phones report", min: 2, max: 60, value: 10, unit: " s" },
      { id: "ledger", type: "switch", label: "Airtime ledger by priority (SOS 30 % reserved)", value: true, desc: "SOS 30 % · commands 30 % · positions 30 % · bulk 10 % of the hour's budget, so telemetry can never eat the SOS slice." },
      { id: "sos", type: "buttons", buttons: [{ id: "raiseSOS", label: "Raise SOS (176 B)", cls: "danger" }] }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { busy: [], q: [], sent: 0, coal: 0, sosLat: null, sosAt: null, acc: {}, chanFree: 0, refused: 0, used: { 0: 0, 1: 0, 2: 0, 3: 0 }, holdLog: 0, bwSaid: false, ledgerHits: 0 });
      ring(190, 300, 5, 110).forEach((p, i) => node("A" + (i + 1), p[0], p[1], "phone", "A" + (i + 1))); node("L1", 330, 300, "esp", "L1 · box");
      ring(660, 300, 5, 110).forEach((p, i) => node("B" + (i + 1), p[0], p[1], "phone", "B" + (i + 1))); node("L2", 800, 300, "esp", "L2 · box");
      node("EOC", 900, 120, "cmd", "EOC");
      meshByRange(["A1", "A2", "A3", "A4", "A5"], 170); meshByRange(["B1", "B2", "B3", "B4", "B5"], 170);
      link("A2", "L1", "wifi", { label: "hotspot" }); link("B2", "L2", "wifi", { label: "hotspot" }); link("L1", "L2", "lora", { label: "LoRa 865–868 MHz · 125 kHz", ly: -26 }); link("L2", "EOC", "net", { label: "backhaul" });
      byId.A2.badge = "GATEWAY"; byId.B2.badge = "GATEWAY"; this.roleBadge();
    },
    reg() { return REG[E.C.cat] || REG.t2ap; },
    sfNow() { return E.C.sf === "auto" ? 7 : +E.C.sf; },   // the L1–L2 link has margin to spare, so adaptive picks SF7
    bwOk() { const r = this.reg(); return !r.bwMax || (+E.C.bw) * 1000 <= r.bwMax; },
    roleBadge() { const r = this.reg(); byId.L1.badge = (r.duty >= 1 ? "LICENSED" : (r.duty * 100) + " % · " + r.power); byId.L1.badgeColor = r.duty >= 0.1 ? css("--green") : r.duty >= 0.025 ? css("--amber") : css("--red"); byId.L2.badge = byId.L1.badge; byId.L2.badgeColor = byId.L1.badgeColor; },
    onControl(id, v) {
      const s = this.st;
      if (id === "raiseSOS") { s.sosAt = E.t; this.enqueue({ kind: "SOS", bytes: 176, from: "A4", pri: 0 }); byId.A4.ring = css("--red"); log("A4 raises an SOS — it uses the reserved SOS slice and goes to the front of the line", "bad", "A4"); }
      if (id === "cat") { const r = this.reg(); this.roleBadge(); log("Category: " + r.name + " — " + (r.duty >= 1 ? "no duty-cycle limit" : (r.duty * 100) + " % of each hour on air") + ", " + r.power + ". " + r.note, "sys", "L1"); s.bwSaid = false; }
      if (id === "sf") log(E.C.sf === "auto" ? "Adaptive SF: the L1–L2 link has margin to spare, so the boxes step down to SF7 and turn transmit power down (APC)" : "SF fixed at " + E.C.sf, "sys", "L1");
      if (id === "pkt") log("Position report is now " + E.C.pkt + " B (" + (E.C.pkt === 164 ? "signed individually" : E.C.pkt === 76 ? "compact, signed in batches" : "one summary per group") + ")", "sys", "A2");
      if (id === "bw") { s.bwSaid = false; if (!this.bwOk()) log("250 kHz is not permitted under Table II (≤ 200 kHz). The box refuses to transmit until bandwidth is back at 125 kHz.", "bad", "L1"); else log("Bandwidth locked to 125 kHz — allowed", "ok", "L1"); }
      if (id === "ledger") log(v ? "Airtime ledger on: SOS 30 % · commands 30 % · positions 30 % · bulk 10 %" : "Ledger off: first come, first served — telemetry can eat the whole budget", v ? "ok" : "warn", "L1");
    },
    enqueue(m) { const s = this.st; if (m.pri === 0) s.q.unshift(m); else { const i = s.q.findIndex(x => x.pri === 2 && x.from === m.from); if (i >= 0) { s.q[i] = m; s.coal++; return; } s.q.push(m); } },
    tick(dt) {
      const s = this.st; const win = 60000; s.busy = s.busy.filter(b => b.end > E.t - win);
      const r = this.reg(); const sf = this.sfNow();
      // sources
      ["A1", "A3", "A4", "A5"].forEach(id => { s.acc[id] = (s.acc[id] || 0) + dt; if (s.acc[id] >= E.C.interval * 1000) { s.acc[id] = 0; send(id, "A2", { color: css("--green"), r: 4, onArrive: () => { if (+E.C.pkt === 96) { s.pendingSummary = (s.pendingSummary || 0) + 1; } else this.enqueue({ kind: "POS", bytes: +E.C.pkt, from: id, pri: 2 }); } }); } });
      if (+E.C.pkt === 96) { s.sumAcc = (s.sumAcc || 0) + dt; if (s.sumAcc >= E.C.interval * 1000) { s.sumAcc = 0; if (s.pendingSummary) { this.enqueue({ kind: "SUM×" + s.pendingSummary, bytes: 96, from: "A2", pri: 2 }); s.pendingSummary = 0; } } }
      // ledger: air time used in the window, per priority
      const usedBy = { 0: 0, 1: 0, 2: 0, 3: 0 }; s.busy.forEach(b => { usedBy[b.pri] += Math.min(b.end, E.t) - Math.max(b.start, E.t - win); });
      const total = Object.values(usedBy).reduce((a, b) => a + b, 0); s.duty = total / win; s.usedBy = usedBy;
      const limit = r.duty; const slice = { 0: 0.30, 1: 0.30, 2: 0.30, 3: 0.10 };
      if (s.chanFree <= E.t && s.q.length) {
        const m = s.q[0];
        if (!this.bwOk()) { if (!s.bwSaid) { s.bwSaid = true; byId.L1.badge = "REFUSED · 250 kHz"; byId.L1.badgeColor = css("--red"); } if (!m.refused) { m.refused = true; s.refused++; } return; }
        const at = loraAirtime(m.bytes, sf, +E.C.bw * 1000);
        const allowedAll = s.duty < limit;
        const allowedSlice = E.C.ledger ? (usedBy[m.pri] / win) < limit * slice[m.pri] : allowedAll;
        if (limit < 1 && (!allowedAll || !allowedSlice)) {
          if (m.pri !== 0) { const latest = {}; s.q.filter(x => x.pri === 2).forEach(x => { latest[x.from] = x; }); const before = s.q.length; s.q = s.q.filter(x => x.pri === 0 || latest[x.from] === x); s.coal += before - s.q.length; s.holdLog += dt; if (s.holdLog > 6000) { s.holdLog = 0; log((E.C.ledger ? "Position slice used up (" + (limit * 30) + " % of the hour)" : "Hour's air time used up (" + (limit * 100) + " %)") + " — routine reports held; newest kept per phone", "warn", "L1"); } return; }
          if (!allowedAll && E.C.ledger && usedBy[0] / win < limit * slice[0]) { /* SOS slice still free — fall through and send */ } else { s.holdLog += dt; if (s.holdLog > 6000) { s.holdLog = 0; log("Even the SOS is waiting: the whole budget is spent and nothing was reserved", "bad", "L1"); } return; }
        }
        s.q.shift(); s.chanFree = E.t + at; s.busy.push({ start: E.t, end: E.t + at, pri: m.pri }); s.sent++; if (m.pri === 0 && E.C.ledger) s.ledgerHits++;
        send("L1", "L2", { color: m.pri === 0 ? css("--red") : css("--amber"), label: m.kind + " " + m.bytes + "B · SF" + sf, dur: at, r: 6, onArrive: () => { send("L2", "EOC", { color: m.pri === 0 ? css("--red") : css("--amber"), r: 5, onArrive: () => { if (m.pri === 0 && s.sosAt != null) { s.sosLat = E.t - s.sosAt; s.sosAt = null; byId.A4.ring = null; log("SOS reached the command centre in " + fmtT(s.sosLat), "ok", "EOC"); } } }); } });
      }
      if (this.bwOk() && byId.L1.badge.startsWith("REFUSED")) this.roleBadge();
    },
    metrics() {
      const s = this.st, r = this.reg(), sf = this.sfNow(); const bw = +E.C.bw * 1000; const at = loraAirtime(+E.C.pkt, sf, bw); const perHour = !this.bwOk() ? "not allowed" : r.duty >= 1 ? "no limit" : Math.floor(r.duty * 3600000 / at);
      const used = s.duty || 0; const rel = r.duty >= 1 ? 0 : used / r.duty;
      const p0 = s.usedBy ? s.usedBy[0] / 60000 : 0;
      return [
        { label: "band · bandwidth · power", value: "865–868 MHz · " + E.C.bw + " kHz · " + r.power + (E.C.sf === "auto" ? " · APC on" : ""), wide: true, cls: this.bwOk() ? "" : "bad" },
        { label: "air time for one report", value: (at / 1000).toFixed(3) + " s · SF" + sf },
        { label: "reports allowed per hour", value: perHour, cls: perHour === "not allowed" ? "bad" : perHour === "no limit" ? "good" : perHour < 100 ? "bad" : perHour < 500 ? "warn" : "good" },
        { label: "air time used vs limit", value: r.duty >= 1 ? (used * 100).toFixed(2) + " % · no limit" : (used * 100).toFixed(2) + " % of " + (r.duty * 100) + " %", cls: rel >= 1 ? "bad" : rel > .7 ? "warn" : "good", bar: r.duty >= 1 ? used * 100 : rel * 100, barCls: rel >= 1 ? "red" : rel > .7 ? "amber" : "green" },
        { label: "SOS slice used (30 % reserved)", value: E.C.ledger && r.duty < 1 ? Math.round(p0 / (r.duty * .3) * 100) + " %" : "—", bar: E.C.ledger && r.duty < 1 ? p0 / (r.duty * .3) * 100 : 0, barCls: "red" },
        { label: "messages waiting", value: s.q.length, cls: s.q.length > 8 ? "bad" : "" },
        { label: "old reports replaced by newer", value: s.coal },
        { label: "refused (bandwidth not allowed)", value: s.refused, cls: s.refused ? "bad" : "" },
        { label: "last SOS took", value: s.sosLat != null ? fmtT(s.sosLat) : "—", cls: s.sosLat > 10000 ? "bad" : s.sosLat ? "good" : "" }
      ];
    },
    steps: [
      { text: "<b>The old assumption.</b> Table I, 1 % of the hour, SF9, 164-byte reports. Each report takes 0.84 s on air, so a box gets about 42 an hour — and four phones every 10 s want 1,440. Watch the gauge fill and reports get held back.", run() { setControl("cat", "t1"); E.sc.onControl("cat"); setControl("sf", 9); setControl("pkt", 164); setControl("bw", 125); setControl("interval", 10); } },
      { text: "<b>Lever 1 — the right category.</b> Our boxes track people, carry SOS and collect data, and forward for others: that is Table II, network access point. 10 % of the hour and 500 mW instead of 1 % and 25 mW. Same radio: about 428 reports an hour at SF9.", run() { setControl("cat", "t2ap"); E.sc.onControl("cat"); } },
      { text: "<b>Lever 2 — the lowest spreading factor the link allows.</b> The L1–L2 link has margin to spare, so adaptive SF steps down to SF7 and adaptive power control (required by Table II) turns the transmitter down too. 0.27 s per report: about 1,350 an hour.", run() { setControl("sf", "auto"); E.sc.onControl("sf"); } },
      { text: "<b>Lever 3 — shrink the routine report.</b> A 164-byte report spends most of its bytes on a per-report signature. Keep that on SOS and commands; batch-sign routine positions instead. 76 bytes: 0.14 s on air, about 2,600 an hour. The gauge stays low even at 10 s reports.", run() { setControl("pkt", 76); E.sc.onControl("pkt"); } },
      { text: "<b>Lever 4 — spend the budget by priority.</b> Reports every 2 s from every phone would still fill the box. With the ledger, positions may only use their 30 % slice; the SOS slice is untouched. Raise an SOS now and it crosses immediately.", run() { setControl("interval", 2); E.sc.onControl("raiseSOS"); } },
      { text: "<b>What does not work: wider bandwidth.</b> 250 kHz would halve the air time, but Table II allows at most 200 kHz. The box refuses to transmit. (Hopping channels does not help either: India treats 865–868 MHz as one band, so there is no per-channel budget.)", run() { setControl("bw", 250); E.sc.onControl("bw"); } },
      { text: "<b>Back to 125 kHz — and the real way past the limits.</b> For a deployment by NDRF, SDRF or police, the LoRa tier can move to licensed public-safety spectrum; duty cycle is then set by the licence. The hardware is unchanged. The prototype stays fully inside the licence-exempt rules.", run() { setControl("bw", 125); E.sc.onControl("bw"); setControl("cat", "lic"); E.sc.onControl("cat"); setControl("interval", 10); } }
    ]
  });

  // ---------- 6. Gateway fail-over ----------
  S.push({
    id: "failover", group: "Linking groups with LoRa radios", tier: "Step 2 · when the gateway phone dies", title: "When the gateway phone dies",
    blurb: "The radio box is the thing with the long-range link, so the radio box decides who its phone is. The attached phone sends a small 'still here' signal every 2 s. If it stops, other approved phones nearby ask to take over, and the box picks the best one — plugged in beats battery. The old phone can't barge back in later.",
    hint: "Cut the gateway phone's power, then bring it back after the hand-over.",
    intro: "P1 is attached to radio box L1 and sends 'still here' every 2 s. P2 and P3 are approved to take over if needed. Press <b>Start</b>.",
    controls: [{ id: "acts", type: "buttons", buttons: [{ id: "cut", label: "P1's battery dies", cls: "danger" }, { id: "return", label: "P1 comes back" }] }],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { gen: 1, owner: "P1", lastHb: 0, hbAcc: 0, expired: null, phase: "attached", lostAt: null, recovered: null, queued: 12, ack: 9 });
      node("L1", 480, 250, "esp", "L1 · radio box"); node("P1", 300, 160, "phone", "P1", { battery: 61, ext: false }); node("P2", 300, 380, "phone", "P2", { battery: 38, ext: true }); node("P3", 660, 380, "phone", "P3", { battery: 84, ext: false }); node("P4", 660, 160, "phone", "P4", { battery: 70, ext: false, capable: false });
      node("EOC", 880, 110, "cmd", "EOC"); link("L1", "EOC", "lora", { label: "LoRa backbone" });
      ["P1", "P2", "P3", "P4"].forEach(id => link(id, "L1", "ble", { label: "" })); meshByRange(["P1", "P2", "P3", "P4"], 420);
      byId.P1.sub = "61 % battery"; byId.P2.sub = "38 % · plugged in"; byId.P3.sub = "84 % battery"; byId.P4.sub = "not approved";
      this.badges();
    },
    badges() { const s = this.st; E.nodes.forEach(n => { if (n.kind === "phone") { n.badge = n.id === s.owner ? "ATTACHED · round " + s.gen : (n.capable === false ? "" : "can take over"); n.badgeColor = n.id === s.owner ? css("--green") : css("--ink-3"); } }); byId.L1.sub = "round " + s.gen + " · " + s.queued + " messages waiting · " + s.ack + " confirmed"; },
    onControl(id) {
      const s = this.st;
      if (id === "cut" && byId.P1.alive) { kill("P1"); s.lostAt = E.t; s.phase = "lost"; log("P1's battery died. The radio box still has its " + s.queued + " waiting messages (" + s.ack + " already confirmed). The 'still here' signals stop.", "bad", "P1"); }
      if (id === "return") { revive("P1"); log("P1 is back — it tries to attach with its old round-1 ticket", "sys"); send("P1", "L1", { color: css("--blue"), label: "attach (round 1)", onArrive: () => { if (s.gen > 1) { log("The box says no: round 1 is out of date, we are on round " + s.gen + ". So two phones can never both think they are in charge.", "warn", "L1"); byId.P1.badge = "REFUSED (old round)"; byId.P1.badgeColor = css("--red"); } else { s.owner = "P1"; this.badges(); } } }); }
    },
    tick(dt) {
      const s = this.st; s.hbAcc += dt;
      if (s.hbAcc >= 2000) { s.hbAcc = 0; if (byId[s.owner].alive) send(s.owner, "L1", { color: css("--green"), r: 4, label: "hb", onArrive: () => { s.lastHb = E.t; } }); }
      if (s.phase === "lost" && E.t - s.lastHb > 4200) { s.phase = "electing"; log("Two 'still here' signals missed — P1 is treated as gone. Approved phones ask to take over.", "warn", "L1"); ["P2", "P3"].forEach(c => send(c, "L1", { color: css("--blue"), label: "take over?", onArrive: () => { s.req = (s.req || 0) + 1; if (s.req === 2) { s.req = 0; const pick = byId.P2.ext ? "P2" : "P3"; s.gen++; s.owner = pick; s.phase = "syncing"; log("The box picks " + pick + " — plugged in beats 84 % battery. New round: " + s.gen, "ok", pick); this.badges(); send("L1", pick, { color: css("--amber"), label: "what's waiting", onArrive: () => send(pick, "L1", { color: css("--amber"), label: "carry on", onArrive: () => { s.phase = "attached"; s.recovered = E.t - s.lostAt; s.lastHb = E.t; log("They compare their lists of waiting messages and carry on. Back up in " + fmtT(s.recovered) + " (goal: under 20 s). Messages lost: none.", "ok", "L1"); this.badges(); } }) }); } } })); }
      if (s.phase === "attached" && Math.random() < dt / 6000) { s.queued++; s.ack++; this.badges(); }
    },
    metrics() { const s = this.st; const phase = { attached: "working", lost: "phone lost", electing: "choosing a new phone", syncing: "handing over" }[s.phase] || s.phase; return [{ label: "phone in charge", value: s.owner + " · round " + s.gen }, { label: "what's happening", value: phase, cls: s.phase === "attached" ? "good" : "warn" }, { label: "time to recover", value: s.recovered != null ? fmtT(s.recovered) : s.lostAt ? fmtT(E.t - s.lostAt) : "—", cls: s.recovered != null ? (s.recovered < 20000 ? "good" : "bad") : "" }, { label: "confirmed messages lost", value: 0, cls: "good" }]; },
    steps: [
      { text: "<b>Normal.</b> P1 sends 'still here' to the radio box every 2 s. Messages waiting to go out are kept on the box <i>and</i> on the phones that wrote them, so nothing depends on one device.", run() { } },
      { text: "<b>P1's battery dies.</b> The phones don't hold a vote. The box simply notices the signals have stopped. After two missed signals it treats P1 as gone.", run() { E.sc.onControl("cut"); } },
      { text: "<b>Others ask; the box chooses.</b> P2 (38 %, but plugged into a car charger) beats P3 (84 % battery). Plugged in first, then battery, then who can reach the most phones. Each hand-over starts a new round number.", run() { } },
      { text: "<b>P1 comes back.</b> It shows its old round-1 ticket. The box refuses — that round is over. This is what stops two phones both thinking they are in charge.", run() { E.sc.onControl("return"); } }
    ]
  });

  // ---------- 7. Satellite ----------
  S.push({
    id: "satellite", group: "Reaching command by satellite", tier: "Step 3 · satellite backup", title: "When the radio chain can't reach command",
    blurb: "The command centre is 120 km away. Normally two relay radios pass messages there. When hills block the relays, the radio box falls back to a small satellite modem: 340 bytes per message, tens of seconds each way, and it needs a clear view of the sky. (Simulated here, using the same message limits as the real modem.)",
    hint: "Switch the hills on, change the message size, then send.",
    intro: "The group on the left has radio box L1 with a satellite modem. Relays R1 and R2 chain to the command centre. Press <b>Start</b>.",
    controls: [
      { id: "terrain", type: "switch", label: "Hills block the relay chain", value: false, desc: "Relay R2 can no longer be reached." },
      { id: "sky", type: "switch", label: "Clear sky above L1", value: true, desc: "Satellite needs a view of the sky — distance doesn't matter." },
      { id: "size", type: "range", label: "Message size", min: 40, max: 700, step: 10, value: 120, unit: " bytes" },
      { id: "send", type: "buttons", buttons: [{ id: "tx", label: "Send to command", cls: "primary" }] }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { sent: 0, path: "—", lat: null, frames: 0, sentAt: null });
      ring(150, 330, 4, 90).forEach((p, i) => node("A" + (i + 1), p[0], p[1], "phone", "A" + (i + 1))); meshByRange(["A1", "A2", "A3", "A4"], 150);
      node("L1", 290, 330, "esp", "L1 · radio box + satellite"); link("A2", "L1", "wifi", { label: "AP" });
      node("R1", 480, 300, "esp", "R1 · relay"); node("R2", 680, 260, "esp", "R2 · relay"); node("EOC", 890, 230, "cmd", "Command · 120 km");
      link("L1", "R1", "lora", { label: "LoRa" }); link("R1", "R2", "lora", { label: "LoRa" }); link("R2", "EOC", "lora", { label: "LoRa" });
      node("SAT", 560, 60, "sat", "Satellite"); link("L1", "SAT", "sat", { delay: 14000, label: "up" }); link("SAT", "EOC", "sat", { delay: 14000, label: "down" });
    },
    onControl(id, v) {
      const s = this.st;
      if (id === "terrain") { byId.R2.alive = !v; log(v ? "Hills: relay R2 can't be reached — the chain is broken" : "Relay chain is back", v ? "bad" : "ok", "R2"); }
      if (id === "sky") { linkBetween("L1", "SAT").up = !!v; log(v ? "L1 can see the sky" : "L1 is under trees — it can't see the satellite", v ? "ok" : "bad", "L1"); }
      if (id === "tx") {
        s.sentAt = E.t; const bytes = E.C.size;
        send("A1", "A2", { color: css("--gold"), label: bytes + " B", onArrive: () => send("A2", "L1", { color: css("--gold"), onArrive: () => {
          if (bfs("L1", "EOC") && byId.R2.alive) { s.path = "relay chain"; this.relay(["L1", "R1", "R2", "EOC"], 0, bytes); return; }
          if (!linkBetween("L1", "SAT").up) { s.path = "none — kept for later"; log("No relay chain and no sky: the message waits on L1 until one comes back", "bad", "L1"); return; }
          const frames = Math.ceil(bytes / 340); s.frames = frames; s.path = "satellite · " + frames + " message" + (frames > 1 ? "s" : "");
          if (frames > 1) log(bytes + " bytes is more than a satellite message can hold (340) — split into " + frames + " (this is why the app shows a size limit when you type)", "warn", "L1"); else say("L1", "no relay chain — sending by satellite instead", "warn", 3000);
          for (let f = 0; f < frames; f++) send("L1", "SAT", { color: css("--violet"), label: "sat " + (f + 1) + "/" + frames, r: 6, dur: 14000 + f * 9000 + rnd(0, 6000), onArrive: () => send("SAT", "EOC", { color: css("--violet"), r: 6, dur: 12000 + rnd(0, 8000), onArrive: () => { if (f === frames - 1) { s.lat = E.t - s.sentAt; s.sent++; log("Command got the message by satellite in " + fmtT(s.lat), "ok", "EOC"); } } }) });
        } }) });
      }
    },
    relay(path, i, bytes) { const s = this.st; if (i >= path.length - 1) { s.lat = E.t - s.sentAt; s.sent++; log("Command got the message over the relay chain in " + fmtT(s.lat), "ok", "EOC"); return; } send(path[i], path[i + 1], { color: css("--amber"), label: bytes + " B", dur: loraAirtime(Math.min(bytes, 240), 9) + 200, onArrive: () => this.relay(path, i + 1, bytes) }); },
    metrics() { const s = this.st; return [{ label: "path used", value: s.path, wide: true }, { label: "last message took", value: s.lat != null ? fmtT(s.lat) : "—", cls: s.lat > 20000 ? "warn" : s.lat ? "good" : "" }, { label: "satellite messages needed", value: s.frames || "—" }, { label: "messages delivered", value: s.sent }]; },
    steps: [
      { text: "<b>Normal: the relay chain.</b> A small message hops L1 → R1 → R2 → command in a few seconds. The satellite isn't used while a cheaper path exists.", run() { E.sc.onControl("tx"); } },
      { text: "<b>Hills break the chain.</b> R2 is out of reach, and there is no time to put another relay up. The radio box switches to the satellite. Notice how long it takes — tens of seconds, not a blink.", run() { setControl("terrain", true); E.sc.onControl("terrain", true); E.sc.onControl("tx"); } },
      { text: "<b>A message that's too big.</b> 600 bytes doesn't fit in one 340-byte satellite message, so it goes as two. This is why the app shows a size limit while you type.", run() { setControl("size", 600); E.sc.onControl("tx"); } },
      { text: "<b>It's about the sky, not the distance.</b> Put L1 under trees: the satellite is overhead but can't be reached. Messages wait. This is why the modem sits on one chosen box with a clear view.", run() { setControl("sky", false); E.sc.onControl("sky", false); setControl("size", 120); E.sc.onControl("tx"); } }
    ]
  });

  // ---------- 8. DTN transition ----------
  S.push({
    id: "dtn", group: "When the internet comes back", tier: "Step 4 · one phone gets signal", title: "One phone gets signal, everyone benefits",
    blurb: "A patch of mobile signal covers part of the area. Any phone inside it checks that the internet really works, then tells the others: 'I have internet'. Everyone sends their reports through that phone, and anything that was waiting goes out in one go. Step out of the signal and things simply queue up again. The phone-to-phone links never switch off.",
    hint: "Slide the signal patch over the group. Try making it come and go.",
    intro: "Eight phones in a group; the internet is top-right. Nobody has signal yet, so every report waits. Press <b>Start</b>.",
    controls: [
      { id: "cov", type: "range", label: "Where the mobile signal is", min: 0, max: 100, value: 100, desc: "Slide left to move the signal patch over the group." },
      { id: "flicker", type: "switch", label: "Signal comes and goes", value: false, desc: "Every ~6 s the signal drops and returns." }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { tiers: { DIRECT: 0, GATEWAY: 0, QUEUED: 0 }, flushed: 0, acc: {}, valid: {}, gw: null, flick: 0, covOn: true });
      const P = [["P1", 150, 200], ["P2", 250, 330], ["P3", 320, 170], ["P4", 420, 300], ["P5", 520, 190], ["P6", 560, 380], ["P7", 660, 260], ["P8", 740, 400]];
      P.forEach(p => node(p[0], p[1], p[2], "phone", p[0], { q: 0 })); meshByRange(P.map(p => p[0]), 190);
      node("CLOUD", 880, 80, "cloud", "Internet"); E.nodes.filter(n => n.kind === "phone").forEach(n => link(n.id, "CLOUD", "net", { delay: 250 }));
      E.links.filter(l => l.kind === "net").forEach(l => { l.up = false; l.hidden = true; });
    },
    covCenter() { return { x: 180 + E.C.cov * 9, y: 330, r: 150 }; },
    drawUnder(ctx) { const c = this.covCenter(); if (!this.st.covOn) return; ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2); ctx.fillStyle = css("--blue"); ctx.globalAlpha = .12; ctx.fill(); ctx.globalAlpha = .7; ctx.setLineDash([6, 6]); ctx.strokeStyle = css("--blue"); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = css("--blue"); ctx.font = "700 11px Inter, sans-serif"; ctx.textAlign = "center"; ctx.fillText("mobile signal here", c.x, c.y - c.r - 8); },
    tick(dt) {
      const s = this.st; const c = this.covCenter();
      if (E.C.flicker) { s.flick += dt; if (s.flick > 6000) { s.flick = 0; s.covOn = !s.covOn; log(s.covOn ? "Signal is back" : "Signal dropped", s.covOn ? "ok" : "warn"); } } else s.covOn = true;
      E.nodes.filter(n => n.kind === "phone").forEach(n => {
        const inside = s.covOn && Math.hypot(n.x - c.x, n.y - c.y) < c.r;
        if (inside) { s.valid[n.id] = (s.valid[n.id] || 0) + dt; if (s.valid[n.id] > 1500 && !n.internet) { n.internet = true; n.badge = "GATEWAY"; n.badgeColor = css("--green"); linkBetween(n.id, "CLOUD").up = true; log(n.id + " checked: the internet really works → tells the others 'I have internet'", "ok", n.id); s.bgen = (s.bgen || 0) + 1; flood(n.id, null, { color: css("--green"), r: 4, label: "I have internet", payload: { beacon: n.id, gen: s.bgen, ttl: 4 } }); } }
        else { s.valid[n.id] = 0; if (n.internet) { n.internet = false; n.badge = ""; linkBetween(n.id, "CLOUD").up = false; log(n.id + " lost the internet — the others go back to waiting", "warn", n.id); } }
      });
      const gws = E.nodes.filter(n => n.internet).map(n => n.id); s.gw = gws[0] || null;
      E.nodes.filter(n => n.kind === "phone").forEach(n => {
        s.acc[n.id] = (s.acc[n.id] || 0) + dt; if (s.acc[n.id] < 2200) return; s.acc[n.id] = rnd(0, 800);
        const count = 1 + n.q; n.q = 0;
        if (n.internet) { s.tiers.DIRECT += count; if (count > 1) s.flushed += count - 1; for (let i = 0; i < Math.min(count, 4); i++) send(n.id, "CLOUD", { color: css("--blue"), r: 4, dur: 250 + i * 120 }); return; }
        const gw = gws.map(g => ({ g, p: bfs(n.id, g) })).filter(x => x.p).sort((a, b) => a.p.length - b.p.length)[0];
        if (gw) { s.tiers.GATEWAY += count; if (count > 1) { s.flushed += count - 1; log(n.id + " sends its " + count + " waiting reports in one go, through " + gw.g, "ok", n.id); } this.relay(gw.p, 0, Math.min(count, 4)); return; }
        n.q += count; s.tiers.QUEUED++; n.sub = "waiting " + n.q;
      });
      E.nodes.forEach(n => { if (n.kind === "phone") n.sub = n.q ? "waiting " + n.q : ""; });
    },
    onArrive(n, p) { const b = p.payload.beacon; if (!b) return; const key = b + ":" + p.payload.gen; if (n.seen.has(key)) return; n.seen.add(key); if (p.payload.ttl > 0 && !n.internet) flood(n.id, p.from, { color: css("--green"), r: 4, label: "I have internet", payload: { beacon: b, gen: p.payload.gen, ttl: p.payload.ttl - 1 } }); },
    relay(path, i, count) { if (i >= path.length - 1) { for (let k = 0; k < count; k++) send(path[i], "CLOUD", { color: css("--blue"), r: 4, dur: 250 + k * 120 }); return; } for (let k = 0; k < count; k++) send(path[i], path[i + 1], { color: css("--gold"), r: 4, dur: 45 + k * 60, onArrive: k === 0 ? () => this.relay(path, i + 1, count) : null }); },
    metrics() { const s = this.st; const q = E.nodes.reduce((a, n) => a + (n.q || 0), 0); return [{ label: "phone with internet", value: s.gw || "none", cls: s.gw ? "good" : "bad" }, { label: "reports waiting now", value: q, cls: q ? "warn" : "good" }, { label: "sent straight to the internet", value: s.tiers.DIRECT }, { label: "sent through another phone", value: s.tiers.GATEWAY }, { label: "kept waiting", value: s.tiers.QUEUED }, { label: "sent later in one go", value: s.flushed }]; },
    steps: [
      { text: "<b>No signal anywhere.</b> The signal patch is off to the right. Every phone keeps its reports. Nothing is lost, nothing is delivered yet.", run() { setControl("cov", 100); } },
      { text: "<b>Signal reaches P7 and P8.</b> After checking for 1.5 s that the internet really works, they tell the others. Everyone now sends through them (gold dots), and all the waiting reports go out in one go.", run() { setControl("cov", 66); } },
      { text: "<b>And back again.</b> Slide the signal away. The two phones say 'no internet any more' and everyone goes back to waiting. The links between the phones never changed.", run() { setControl("cov", 100); } },
      { text: "<b>Signal that comes and goes.</b> This is what really happens. Watch reports switch between 'straight out', 'through another phone' and 'waiting' — without anyone touching a setting.", run() { setControl("cov", 62); setControl("flicker", true); } }
    ]
  });

  // ---------- 9. Alert into a dead zone ----------
  S.push({
    id: "alert", group: "When the internet comes back", tier: "Alerts · reaching phones with no signal", title: "Three ways a warning reaches a dead zone",
    blurb: "The weather station's data reaches our server over its own link — local damage rarely stops that. The hard part is the last stretch: getting the warning to phones that have no signal. There are three ways, and one trick: a message marked 'for everyone'.",
    hint: "Try each of the three ways. Then compare 'for everyone' with sending to each phone one by one.",
    intro: "The weather station can reach our server. The phones below have no internet. Press <b>Start</b> to see the warning arrive at the server.",
    controls: [
      { id: "bcast", type: "switch", label: "Mark the message 'for everyone'", value: true, desc: "Off = the server has to send a separate message to each phone." },
      { id: "paths", type: "buttons", label: "Get it there by", buttons: [{ id: "p1", label: "① One phone still has signal" }, { id: "p2", label: "② No signal at all: satellite" }, { id: "p3", label: "③ Loaded onto phones beforehand" }, { id: "clr", label: "Clear" }] }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { alerted: new Set(), pkts: 0, t0: null, full: null });
      node("IMD", 90, 70, "sensor", "Weather station"); node("BE", 480, 70, "cloud", "Our server"); link("IMD", "BE", "net", { label: "the station's own link", delay: 400 });
      node("SAT", 800, 70, "sat", "Satellite"); link("BE", "SAT", "sat", { delay: 9000 });
      const P = [["P1", 160, 300], ["P2", 270, 400], ["P3", 300, 240], ["P4", 420, 340], ["P5", 520, 240], ["P6", 560, 420], ["P7", 680, 320], ["P8", 760, 440]];
      P.forEach(p => node(p[0], p[1], p[2], "phone", p[0])); meshByRange(P.map(p => p[0]), 185);
      node("L1", 850, 300, "esp", "L1 · radio box + satellite"); link("P7", "L1", "wifi", { label: "AP" }); link("SAT", "L1", "sat", { delay: 9000 });
      link("BE", "P5", "net", { delay: 300 }); linkBetween("BE", "P5").up = false;
    },
    drawUnder(ctx) { ctx.beginPath(); ctx.roundRect(100, 190, 800, 320, 16); ctx.setLineDash([8, 6]); ctx.strokeStyle = css("--red"); ctx.globalAlpha = .6; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = css("--red"); ctx.font = "700 11px Inter, sans-serif"; ctx.textAlign = "left"; ctx.fillText("NO SIGNAL HERE", 112, 208); },
    onControl(id) {
      const s = this.st;
      if (id === "clr") { s.alerted.clear(); s.pkts = 0; s.t0 = null; s.full = null; E.nodes.forEach(n => { n.badge = ""; n.seen.clear(); n.internet = false; }); linkBetween("BE", "P5").up = false; return; }
      s.alerted.clear(); s.pkts = 0; s.t0 = E.t; s.full = null; E.nodes.forEach(n => { if (n.kind === "phone") { n.badge = ""; n.seen.clear(); } });
      const alertId = "alert-" + Math.random().toString(36).slice(2, 7);
      if (id === "p1") { byId.P5.internet = true; linkBetween("BE", "P5").up = true; log("Way ①: P5 still has one bar of signal, so it becomes the way in for everyone.", "sys", "P5"); this.fromBackend(alertId, "P5"); }
      if (id === "p2") { log("Way ②: nobody has signal. The server sends the warning by satellite to radio box L1, which hands it to P7, and it spreads from there.", "sys", "BE"); s.pkts++; send("BE", "SAT", { color: css("--violet"), label: "WARNING", r: 6, onArrive: () => { s.pkts++; send("SAT", "L1", { color: css("--violet"), label: "sat", r: 6, onArrive: () => { s.pkts++; send("L1", "P7", { color: css("--red"), label: "WARNING", onArrive: () => this.deliver("P7", null, alertId, 4) }); } }); } }); }
      if (id === "p3") { log("Way ③: no messages needed. The danger map was loaded onto every phone at the briefing, so each phone already knows this area is high risk.", "sys"); E.nodes.filter(n => n.kind === "phone").forEach(n => { n.badge = "ALREADY KNOWS: HIGH RISK"; n.badgeColor = css("--amber"); s.alerted.add(n.id); }); s.full = 0; }
    },
    fromBackend(alertId, gw) {
      const s = this.st;
      if (E.C.bcast) { s.pkts++; send("BE", gw, { color: css("--red"), label: "WARNING · for everyone", onArrive: () => this.deliver(gw, null, alertId, 4) }); }
      else { E.nodes.filter(n => n.kind === "phone").forEach((n, i) => { s.pkts++; send("BE", gw, { color: css("--red"), label: "→" + n.id, dur: 300 + i * 90, onArrive: () => { const p = bfs(gw, n.id); if (p) this.unicast(p, 0, n.id); } }); }); }
    },
    unicast(path, i, dst) { const s = this.st; if (i >= path.length - 1) { this.mark(byId[dst]); return; } s.pkts++; send(path[i], path[i + 1], { color: css("--red"), r: 4, label: "→" + dst, onArrive: () => this.unicast(path, i + 1, dst) }); },
    deliver(at, from, alertId, ttl) { const n = byId[at]; if (n.seen.has(alertId)) return; n.seen.add(alertId); this.mark(n); if (ttl > 0) this.st.pkts += flood(at, from, { color: css("--red"), r: 4, label: "for everyone", payload: { alertId, ttl: ttl - 1 } }); },
    onArrive(n, p) { if (p.payload.alertId && n.kind === "phone") this.deliver(n.id, p.from, p.payload.alertId, p.payload.ttl); },
    mark(n) { const s = this.st; if (n.kind !== "phone") return; n.badge = "WARNING RECEIVED"; n.badgeColor = css("--red"); s.alerted.add(n.id); if (s.alerted.size === 8 && s.full == null) { s.full = E.t - s.t0; log("All 8 phones warned in " + fmtT(s.full) + " using " + s.pkts + " messages", "ok", n.id); } },
    metrics() { const s = this.st; return [{ label: "phones warned", value: s.alerted.size + " / 8", cls: s.alerted.size === 8 ? "good" : "", bar: s.alerted.size / 8 * 100, barCls: "green" }, { label: "messages sent", value: s.pkts }, { label: "time until everyone knew", value: s.full != null ? fmtT(s.full) : "—" }, { label: "how it was addressed", value: E.C.bcast ? "for everyone" : "one by one ×8" }]; },
    steps: [
      { text: "<b>The weather side is fine.</b> The station reports to our server over its own link, whatever happens to the local phone towers. The server raises a warning. Now it has to reach eight phones with no internet.", run() { send("IMD", "BE", { color: css("--violet"), label: "heavy rain", r: 6, onArrive: () => log("Server: this area is now CRITICAL. Warning ready to go out.", "warn") }); } },
      { text: "<b>Way ① — one phone still has signal.</b> P5 has a bar. It gets the warning, and because it is marked <b>for everyone</b>, each phone keeps a copy and passes it on. Same hop limit and repeat check as always.", run() { E.sc.onControl("p1"); } },
      { text: "<b>Way ② — nobody has signal.</b> The server sends by satellite to the radio box. The box hands it to a phone and it spreads from there.", run() { E.sc.onControl("clr"); E.sc.onControl("p2"); } },
      { text: "<b>Way ③ — loaded beforehand.</b> No messages at all. The danger map was put on every phone at the briefing. Anyone walking into this area already sees the warning. This is the safety net if everything else fails.", run() { E.sc.onControl("clr"); E.sc.onControl("p3"); } },
      { text: "<b>Why 'for everyone' matters.</b> Turn it off and run way ① again: the server now has to send eight separate messages, and each one is passed along separately. Count the messages.", run() { E.sc.onControl("clr"); setControl("bcast", false); E.sc.onControl("p1"); } }
    ]
  });

  // ---------- 10. Priority & queueing ----------
  S.push({
    id: "priority", group: "Keeping things in order", tier: "Urgent messages first", title: "Urgent messages go first",
    blurb: "Six phones send everything through one phone, R, to the command centre over a slow link. Messages come in four levels: SOS first, then tasks, then locations, then bulk data. SOS always jumps the queue. Old locations are replaced by newer ones. Bulk data only goes when there's room. And one broken phone shouting SOS can't drown out a real one.",
    hint: "Slow the link down; raise an SOS; then switch on the broken phone.",
    intro: "Messages are flowing. Press <b>Start</b> to slow the link down.",
    controls: [
      { id: "cap", type: "range", label: "Link speed", min: 2, max: 20, value: 14, unit: " msgs/s" },
      { id: "faulty", type: "switch", label: "P6 is broken — keeps shouting SOS", value: false },
      { id: "fair", type: "switch", label: "Fair share for SOS", value: true, desc: "No single phone can send more than one SOS a second while others are waiting." },
      { id: "sos", type: "buttons", buttons: [{ id: "raise", label: "P3 raises a real SOS", cls: "danger" }] }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { q: { 0: [], 1: [], 2: {}, 3: [] }, deliv: { 0: 0, 1: 0, 2: 0, 3: 0 }, coal: 0, dropped3: 0, sosLat: [], acc: 0, gen: {}, lastP0: {}, tokens: 0 });
      ring(200, 300, 6, 130).forEach((p, i) => node("P" + (i + 1), p[0], p[1], "phone", "P" + (i + 1))); node("R", 470, 300, "phone", "R · passes everything on"); node("EOC", 860, 300, "cmd", "Command");
      for (let i = 1; i <= 6; i++) link("P" + i, "R"); link("R", "EOC", "wifi", { label: "slow link", delay: 300 });
    },
    draw(ctx) { const s = this.st; const x = 560, y = 380, w = 260; const rows = [["SOS", s.q[0].length, css("--red")], ["Tasks", s.q[1].length, css("--amber")], ["Locations", Object.keys(s.q[2]).length, css("--gold")], ["Bulk data", s.q[3].length, css("--ink-3")]]; ctx.font = "600 11px Inter, sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = css("--ink-2"); ctx.fillText("Waiting at R", x, y - 8); rows.forEach((r, i) => { ctx.fillStyle = css("--ink-2"); ctx.fillText(r[0], x, y + 14 + i * 22); ctx.fillStyle = css("--line"); ctx.fillRect(x + 90, y + 4 + i * 22, w - 90, 12); ctx.fillStyle = r[2]; ctx.fillRect(x + 90, y + 4 + i * 22, Math.min(w - 90, r[1] * 6), 12); ctx.fillStyle = css("--ink"); ctx.font = "600 10px JetBrains Mono, monospace"; ctx.fillText(r[1], x + w + 6, y + 14 + i * 22); ctx.font = "600 11px Inter, sans-serif"; }); },
    onControl(id) { if (id === "raise") { this.emit("P3", 0, "SOS"); log("P3 raises a real SOS", "bad", "P3"); } },
    emit(from, pri, kind) { const s = this.st; send(from, "R", { color: [css("--red"), css("--amber"), css("--gold"), css("--ink-3")][pri], r: pri === 0 ? 6 : 4, payload: { pri, kind, from, t0: E.t }, onArrive: (n, p) => { const m = p.payload; if (pri === 2) { if (s.q[2][from]) s.coal++; s.q[2][from] = m; } else if (pri === 3) { if (s.q[3].length > 12) s.dropped3++; else s.q[3].push(m); } else s.q[pri].push(m); } }); },
    tick(dt) {
      const s = this.st;
      // generators
      for (let i = 1; i <= 6; i++) { const id = "P" + i; s.gen[id] = (s.gen[id] || 0) + dt; if (s.gen[id] > 700) { s.gen[id] -= 700; this.emit(id, 2, "POS"); if (Math.random() < .25) this.emit(id, 3, "BULK"); if (Math.random() < .12) this.emit(id, 1, "TASK-ACK"); } }
      if (E.C.faulty) { s.fAcc = (s.fAcc || 0) + dt; if (s.fAcc > 120) { s.fAcc = 0; this.emit("P6", 0, "SOS?"); byId.P6.badge = "BROKEN"; byId.P6.badgeColor = css("--red"); } } else byId.P6.badge = "";
      // constrained link: token bucket
      s.tokens = Math.min(E.C.cap, s.tokens + E.C.cap * dt / 1000);
      while (s.tokens >= 1) {
        let m = null;
        const p0 = s.q[0]; if (p0.length) { const idx = E.C.fair ? p0.findIndex(x => E.t - (s.lastP0[x.from] || -1e9) > 1000 || new Set(p0.map(y => y.from)).size === 1) : 0; if (idx >= 0) { m = p0.splice(idx, 1)[0]; s.lastP0[m.from] = E.t; } else if (p0.length > 20) { p0.splice(0, p0.length - 20); } }
        if (!m && s.q[1].length) m = s.q[1].shift();
        if (!m) { const k = Object.keys(s.q[2])[0]; if (k) { m = s.q[2][k]; delete s.q[2][k]; } }
        if (!m && s.q[3].length && s.tokens > E.C.cap * .5) m = s.q[3].shift();   // bulk only with spare capacity
        if (!m) break;
        s.tokens -= 1; s.deliv[m.pri]++;
        send("R", "EOC", { color: [css("--red"), css("--amber"), css("--gold"), css("--ink-3")][m.pri], r: m.pri === 0 ? 6 : 4, label: m.pri === 0 ? m.kind : "", onArrive: () => { if (m.pri === 0 && m.from === "P3") { s.sosLat.push(E.t - m.t0); if (s.sosLat.length > 20) s.sosLat.shift(); } } });
      }
    },
    metrics() { const s = this.st; return [{ label: "delivered: SOS / tasks", value: s.deliv[0] + " / " + s.deliv[1] }, { label: "delivered: locations / bulk", value: s.deliv[2] + " / " + s.deliv[3] }, { label: "old locations replaced", value: s.coal }, { label: "bulk dropped (no room)", value: s.dropped3, cls: s.dropped3 ? "warn" : "" }, { label: "P3's SOS took (worst)", value: s.sosLat.length ? Math.round(p95(s.sosLat)) + " ms" : "—", cls: p95(s.sosLat) > 2000 ? "bad" : s.sosLat.length ? "good" : "" }, { label: "SOS messages waiting", value: s.q[0].length, cls: s.q[0].length > 5 ? "bad" : "" }]; },
    steps: [
      { text: "<b>Plenty of room.</b> Everything gets through. Notice that while locations wait, a newer one from the same phone replaces the older one.", run() { } },
      { text: "<b>Slow the link to 5 messages a second.</b> Bulk data stops moving — it only goes when there's spare room. More old locations get replaced. Task messages still get through.", run() { setControl("cap", 5); } },
      { text: "<b>An SOS on a busy link.</b> P3's SOS goes straight to the front and crosses in well under 2 seconds.", run() { E.sc.onControl("raise"); } },
      { text: "<b>A broken phone keeps shouting SOS.</b> P6 sends one every 120 ms. The fair-share rule limits it to one a second whenever someone else is waiting. Raise P3's SOS again — it still gets through.", run() { setControl("faulty", true); E.sc.onControl("raise"); } },
      { text: "<b>Fair share off.</b> Now P6 hogs the SOS lane and P3's real SOS waits behind it. This is exactly what the fair-share rule prevents.", run() { setControl("fair", false); E.sc.onControl("raise"); } }
    ]
  });

  // ---------- 11. Partition & rejoin ----------
  S.push({
    id: "partition", group: "Keeping things in order", tier: "A group splits in two", title: "A group splits in two, then joins back",
    blurb: "A group splits when something — a collapsed building, a ridge — cuts the links in the middle. Both halves keep working, and both may make decisions. When they join back up, they compare notes. If they disagree, the disagreement is shown, not quietly overwritten.",
    hint: "Put the wall up, give task T-7 out from each side, then take the wall down.",
    intro: "Eight phones. C1 and C2 belong to the two team leaders. Press <b>Start</b>.",
    controls: [
      { id: "wall", type: "switch", label: "Wall splits the group", value: false },
      { id: "assign", type: "buttons", label: "Give out task T-7", buttons: [{ id: "a1", label: "from C1 (left)" }, { id: "a2", label: "from C2 (right)" }] }
    ],
    st: {}, setup() {
      const s = this.st; Object.assign(s, { assign: {}, conflicts: 0, obs: {}, acc: 0, synced: 0 });
      const P = [["C1", 150, 280], ["P2", 260, 170], ["P3", 270, 400], ["P4", 400, 290], ["P5", 560, 290], ["P6", 690, 170], ["P7", 700, 400], ["C2", 810, 280]];
      P.forEach(p => node(p[0], p[1], p[2], "phone", p[0], { log: {}, obs: 0 })); meshByRange(P.map(p => p[0]), 200);
      byId.C1.ring = css("--gold"); byId.C2.ring = css("--gold"); byId.C1.sub = "team leader A"; byId.C2.sub = "team leader B";
    },
    draw(ctx) { if (!E.C.wall) return; ctx.fillStyle = css("--red"); ctx.globalAlpha = .18; ctx.fillRect(470, 120, 20, 340); ctx.globalAlpha = 1; ctx.fillStyle = css("--red"); ctx.font = "700 11px Inter, sans-serif"; ctx.textAlign = "center"; ctx.fillText("SPLIT", 480, 110); },
    onControl(id) {
      const s = this.st;
      if (id === "wall") { const l = linkBetween("P4", "P5"); if (l) l.up = !E.C.wall; log(E.C.wall ? "Wall: the P4–P5 link is cut. Two halves, each still working." : "Wall gone — the halves join back and compare notes", E.C.wall ? "bad" : "ok"); if (!E.C.wall) this.sync(); }
      if (id === "a1" || id === "a2") { const from = id === "a1" ? "C1" : "C2"; const to = id === "a1" ? "P3" : "P7"; const rec = { task: "T-7", to, by: from, t: E.t, epoch: from }; log(from + " gives task T-7 to " + to, "sys", from); this.propagate(from, rec); }
    },
    propagate(from, rec) { const reach = reachable(from); reach.forEach(id => { const n = byId[id]; const prev = n.log["T-7"]; if (prev && prev.to !== rec.to) { n.conflict = true; } n.log["T-7"] = prev && prev.to !== rec.to ? { ...rec, conflict: [prev, rec] } : rec; }); const path = [...reach].filter(x => x !== from); path.forEach((id, i) => { const p = bfs(from, id); if (p) this.hop(p, 0, css("--gold")); }); this.badges(); },
    hop(path, i, color) { if (i >= path.length - 1) return; send(path[i], path[i + 1], { color, r: 4, onArrive: () => this.hop(path, i + 1, color) }); },
    sync() { const s = this.st; const all = E.nodes; const recs = all.map(n => n.log["T-7"]).filter(Boolean); const uniq = {}; recs.forEach(r => { uniq[r.to] = r; }); const vals = Object.values(uniq); all.forEach(n => { if (vals.length > 1) { n.log["T-7"] = { task: "T-7", conflict: vals, to: vals.map(v => v.to).join(" & ") }; n.conflict = true; } else if (vals.length === 1) n.log["T-7"] = vals[0]; n.obs = 7; }); s.synced++; if (vals.length > 1) { s.conflicts = 1; log("Comparing notes: T-7 was given to " + vals.map(v => v.to + " (by " + v.by + ")").join(" and ") + " — shown as a clash for the coordinator to sort out", "warn", "P4"); } else log("Comparing notes: everyone agrees, no clashes", "ok", "P4"); for (let i = 0; i < 4; i++) { send("P4", "P5", { color: css("--blue"), r: 4, dur: 200 + i * 120 }); send("P5", "P4", { color: css("--blue"), r: 4, dur: 200 + i * 120 }); } this.badges(); },
    badges() { E.nodes.forEach(n => { const r = n.log["T-7"]; n.badge = r ? (r.conflict ? "T-7 CLASH" : "T-7 → " + r.to) : ""; n.badgeColor = r && r.conflict ? css("--red") : css("--green"); }); },
    tick(dt) { const s = this.st; s.acc += dt; if (s.acc > 1500) { s.acc = 0; E.nodes.forEach(n => { n.obs = reachable(n.id).size - 1; flood(n.id, null, { color: css("--green"), r: 3, payload: { obs: 1, ttl: 0 } }); }); } },
    metrics() { const s = this.st; const halves = new Set(E.nodes.map(n => [...reachable(n.id)].sort()[0])).size; const conf = E.nodes.filter(n => n.log["T-7"] && n.log["T-7"].conflict).length; return [{ label: "separate groups", value: halves, cls: halves > 1 ? "warn" : "good" }, { label: "phones showing the T-7 clash", value: conf + " / 8", cls: conf ? "bad" : "good" }, { label: "phones C1 can see", value: byId.C1 ? byId.C1.obs : 0 }, { label: "phones C2 can see", value: byId.C2 ? byId.C2.obs : 0 }, { label: "times notes were compared", value: s.synced }]; },
    steps: [
      { text: "<b>One group.</b> Every phone can see the other seven. Team leaders C1 and C2 see the same picture.", run() { } },
      { text: "<b>The wall goes up.</b> The P4–P5 link is cut and there are now two groups of four. Each half keeps sharing locations and can keep giving out tasks. Nothing waits for a boss.", run() { setControl("wall", true); E.sc.onControl("wall"); } },
      { text: "<b>Both leaders give out T-7.</b> C1 gives it to P3. C2, not knowing, gives it to P7. Each decision spreads within its own half.", run() { E.sc.onControl("a1"); after(600, () => E.sc.onControl("a2")); } },
      { text: "<b>Joining back up.</b> The wall comes down and the halves compare notes. T-7 now has two people on it. The app does <i>not</i> pick one quietly — every phone shows the clash so a person can sort it out.", run() { setControl("wall", false); E.sc.onControl("wall"); } }
    ]
  });

  // ============================================================
  //  Boot
  // ============================================================
  function buildList() {
    const groups = [...new Set(S.map(s => s.group))]; const box = $("scenarios");
    box.innerHTML = groups.map(g => '<div class="sc-group">' + g + "</div>" + S.filter(s => s.group === g).map(s => '<button type="button" class="sc" data-id="' + s.id + '"><b><span class="n">' + String(S.indexOf(s) + 1).padStart(2, "0") + "</span>" + s.title + "</b><span>" + s.tier + "</span></button>").join("")).join("");
    box.querySelectorAll(".sc").forEach(b => b.addEventListener("click", () => load(S.find(s => s.id === b.dataset.id))));
  }
  // Pointer handling: drag nodes in every scenario; scenarios with tools get
  // pointer down/move/up for adding things and drawing walls.
  function ptOf(ev) { const r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left) / r.width * W, y: (ev.clientY - r.top) / r.height * H }; }
  function hitNode(pt) { return E.nodes.find(n => Math.hypot(n.x - pt.x, n.y - pt.y) < (n.kind === "cloud" || n.kind === "cmd" ? 34 : 22)); }
  canvas.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return; const pt = ptOf(ev); const n = hitNode(pt); UI.pt = pt;
    if (n && UI.tool === "move" && E.sc.draggable !== false) { UI.drag = { node: n, dx: n.x - pt.x, dy: n.y - pt.y, moved: 0, sx: pt.x, sy: pt.y }; canvas.setPointerCapture(ev.pointerId); canvas.style.cursor = "grabbing"; return; }
    if (E.sc.onPointerDown) E.sc.onPointerDown(pt, n, UI.tool);
    if (UI.tool === "wall") { try { canvas.setPointerCapture(ev.pointerId); } catch (e) {} }
  });
  canvas.addEventListener("pointermove", ev => {
    const pt = ptOf(ev); UI.pt = pt;
    if (UI.drag) { const n = UI.drag.node; n.x = Math.max(20, Math.min(W - 20, pt.x + UI.drag.dx)); n.y = Math.max(20, Math.min(H - 20, pt.y + UI.drag.dy)); UI.drag.moved = Math.hypot(pt.x - UI.drag.sx, pt.y - UI.drag.sy); if (E.sc.onMove) E.sc.onMove(n); return; }
    UI.hover = hitNode(pt); if (E.sc.onPointerMove) E.sc.onPointerMove(pt, UI.tool);
  });
  function endDrag(ev) {
    const pt = UI.pt;
    if (UI.drag) { const d = UI.drag; UI.drag = null; canvas.style.cursor = "grab"; if (d.moved < 4 && E.sc.onNodeClick) E.sc.onNodeClick(d.node); else if (E.sc.onDrop) E.sc.onDrop(d.node); return; }
    if (E.sc.onPointerUp) E.sc.onPointerUp(pt, UI.tool);
  }
  canvas.addEventListener("pointerup", endDrag); canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => { UI.hover = null; });
  $("btn-next").addEventListener("click", nextStep);
  $("btn-reset").addEventListener("click", () => load(E.sc));
  $("btn-play").addEventListener("click", () => setPlay(!autoRun));
  $("btn-play-over").addEventListener("click", () => setPlay(true));
  $("btn-pause").addEventListener("click", () => { E.paused = !E.paused; $("btn-pause").textContent = E.paused ? "▶" : "⏸"; $("btn-pause").classList.toggle("on", E.paused); });
  document.querySelectorAll(".spd").forEach(b => b.addEventListener("click", () => { E.speed = +b.dataset.s; document.querySelectorAll(".spd").forEach(x => x.classList.toggle("on", x === b)); }));
  (function theme() { const btn = $("theme-toggle"); function paint() { const dark = document.documentElement.getAttribute("data-theme") === "dark"; btn.innerHTML = '<span aria-hidden="true">' + (dark ? "☀" : "☾") + "</span>" + (dark ? "Light" : "Dark"); } btn.addEventListener("click", () => { const t = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"; document.documentElement.setAttribute("data-theme", t); try { localStorage.setItem("rl_theme", t); } catch (e) {} paint(); }); paint(); })();

  buildList();
  // #scenario opens a scenario; #scenario,auto also starts auto-run (kiosk / demo use)
  const hash = (location.hash || "").slice(1).split(","); load(S.find(s => s.id === hash[0]) || S[0]);
  if (hash[1] === "auto") setPlay(true); else paintPlay();
  frame(performance.now());
})();
