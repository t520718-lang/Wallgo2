/* Wall Go II page: same-device play and room-code play over the artifact's shared store. */
(function () {
  "use strict";
  var WG = window.WG, N = WG.N;
  var NAMES = ["紅", "藍", "黃"];
  var TYPE = { s: "方形", r: "圓形" };
  var C = 60, P = 14, SIZE = P * 2 + C * N;
  var TAB = Math.random().toString(36).slice(2, 8);
  var LS = "wg2-local";
  function $(id) { return document.getElementById(id); }
  var view = $("view");

  var S = {
    view: "home", kind: null, match: null, ui: {}, stamp: "",
    setup: { n: 3, timer: 90, brkNoWall: false, undo: true },
    animOn: true, anim: null, nextAnim: null,
    net: "loading", db: null, user: null, myId: null, canWrite: null,
    code: null, ref: null, room: null, unsub: null, busy: false, missing: false, slow: false, loadT: null,
    names: {}, asked: {}, dests: [], saved: null, nick: ""
  };

  function esc(t) { return String(t).replace(/[&<>"']/g, function (ch) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]; }); }
  var toastT = null;
  function toast(msg) {
    var el = $("toast"); el.textContent = msg; el.classList.remove("hidden");
    clearTimeout(toastT); toastT = setTimeout(function () { el.classList.add("hidden"); }, 3200);
  }
  function errMsg(e) {
    if (e && e.code === "invalid_argument") return window.WG_STANDALONE ? "寫入被拒絕，請重新整理後再試。" : "寫入被拒絕。你可能只有檢視權限，需要「協作者」以上才能下棋。";
    if (e && e.code === "quota_exceeded") return "儲存空間已滿，請擁有者清理舊房間。";
    return "連線出了問題，請再試一次。";
  }
  function loadSaved() { try { var t = localStorage.getItem(LS); return t ? JSON.parse(t) : null; } catch (e) { return null; } }
  function saveLocal(m) { try { if (m) localStorage.setItem(LS, JSON.stringify(m)); else localStorage.removeItem(LS); } catch (e) { /* storage is optional */ } }
  function setHash(h) { try { if (location.hash !== (h ? "#" + h : "")) location.hash = h || ""; } catch (e) { /* ignore */ } }

  /* ---------- who is who ---------- */
  // In a one-on-one the colours are dealt afresh: game player 0 is red, 1 is blue. orig() says whose seat that is.
  function orig(p) { var m = S.match; return m && m.stage !== "r1" && m.duel ? m.duel[p] : p; }
  function seatOf(p) { return S.room && S.room.seats ? S.room.seats[orig(p)] : ""; }
  function seatLabel(o) {
    if (S.kind !== "online") return "原本的" + NAMES[o];
    var id = S.room ? S.room.seats[o] : "";
    return (id && S.names[id]) || ("原本的" + NAMES[o]);
  }
  function isMine(p) { return S.kind === "local" || (!!S.myId && seatOf(p) === S.myId); }
  function seated() { return S.kind === "local" || (S.room && S.myId && S.room.seats.indexOf(S.myId) >= 0); }
  function canAct(p) { return p !== null && isMine(p) && !S.busy; }
  function label(p) {
    if (S.kind !== "online") return NAMES[p] + (orig(p) !== p ? "（原" + NAMES[orig(p)] + "）" : "");
    var id = seatOf(p), nm = id ? (S.names[id] || "") : "";
    return NAMES[p] + (nm ? " " + nm : (orig(p) !== p ? "（原" + NAMES[orig(p)] + "）" : "")) + (id && id === S.myId ? "（你）" : "");
  }
  function askNames() {
    if (!S.user || !S.user.profiles || !S.room) return;
    var ids = S.room.seats.filter(function (id) { return id && !S.asked[id]; });
    if (!ids.length) return;
    ids.forEach(function (id) { S.asked[id] = true; });
    S.user.profiles(ids).then(function (ps) {
      ids.forEach(function (id) { S.names[id] = (ps && ps[id] && ps[id].name) || ""; });
      render();
    }, function () { /* names are optional */ });
  }

  /* ---------- committing changes ---------- */
  function commit(m) {
    m.turnAt = Date.now();
    S.ui = {};
    if (S.kind === "local") { S.match = m; saveLocal(m); render(); return; }
    var room = WG.clone(S.room); room.match = m; room.v = (room.v || 0) + 1;
    S.room = room; S.match = m; S.busy = true; render();
    S.ref.set(room).then(function () { S.busy = false; render(); }, function (e) { S.busy = false; toast(errMsg(e)); render(); });
  }
  // Lobby changes go through a short lease so two people cannot take the same seat.
  function lobby(fn) {
    if (S.busy) return;
    S.busy = true; render();
    var lock = S.db.doc("rooms/" + S.code + "/locks/lobby");
    // The lease is short and cannot be handed back early, so wait it out a few times before giving up.
    function grab(left) {
      return lock.acquire({ holder: S.myId + "-" + TAB, ttlMs: 1500 }).then(function (a) {
        if (a.acquired) return true;
        if (!left) throw { soft: "有人正在操作，請再按一次。" };
        return new Promise(function (res) { setTimeout(res, 450); }).then(function () { return grab(left - 1); });
      });
    }
    grab(5).then(function () {
      return S.ref.get();
    }).then(function (snap) {
      if (!snap.exists) throw { soft: "找不到這個房間。" };
      var room = WG.clone(snap.data());
      var msg = fn(room);
      if (msg) throw { soft: msg };
      room.v = (room.v || 0) + 1;
      S.room = room; S.match = room.match || null;
      return S.ref.set(room);
    }).then(null, function (e) { toast(e && e.soft ? e.soft : errMsg(e)); }).then(function () { S.busy = false; render(); });
  }

  /* ---------- starting and leaving ---------- */
  function setupOpts() { return { timer: S.setup.timer, brkNoWall: S.setup.n === 3 && !!S.setup.brkNoWall, undo: !!S.setup.undo }; }
  function startLocal(resume) {
    S.kind = "local"; S.view = "game"; S.ui = {}; S.stamp = ""; S.anim = null;
    if (resume && S.saved) { S.match = S.saved; S.match.turnAt = Date.now(); }
    else { S.match = WG.newMatch(S.setup.n, setupOpts()); S.match.turnAt = Date.now(); saveLocal(S.match); }
    render();
  }
  /* ---------- who is still here ----------
     S.pres.map says, per device id, whether that player still has the room open. The standalone site learns it from the
     database connection itself (closing the page or losing the network counts). Inside Claude there is no such signal,
     so a player is only marked away when they press 離開. */
  function startPresence() {
    stopPresence();
    S.pres = { map: {}, since: {}, shown: {}, dismissed: {}, stop: null };
    var code = S.code, id = S.myId, pres = S.pres;
    // presence only counts once the store has actually answered; until then nobody is reported away
    function got(map) { if (S.pres !== pres) return; pres.active = true; pres.map = map || {}; presenceTick(); }
    try {
      if (S.db.presence) pres.stop = S.db.presence(code, id + "", TAB, got);
      else if (S.db.collection) {
        var mine = S.db.doc("rooms/" + code + "/seen/" + id);
        mine.set({ here: true, at: Date.now() }).then(null, function () {});
        var un = S.db.collection("rooms/" + code + "/seen").onSnapshot(function (qs) {
          var map = {}; qs.docs.forEach(function (d) { var v = d.data() || {}; map[d.id] = v.here !== false; }); got(map);
        }, function () {});
        pres.known = true; // an id with no record here has simply never reported: treat it as present
        pres.stop = function () { try { un(); } catch (e) { /* ignore */ } mine.set({ here: false, at: Date.now() }).then(null, function () {}); };
      }
    } catch (e) { /* presence is a convenience; play goes on without it */ }
  }
  function stopPresence() { if (S.pres && S.pres.stop) { try { S.pres.stop(); } catch (e) { /* ignore */ } } S.pres = null; }
  function isAway(id) {
    var pr = S.pres;
    if (!pr || !pr.active || !id || id === S.myId) return false;
    if (pr.known) return pr.map[id] === false;
    return !pr.map[id];
  }
  function idLabel(id) {
    var m = S.match, ps = m && m.game ? m.game.order : [];
    for (var i = 0; i < ps.length; i++) if (seatOf(ps[i]) === id) return label(ps[i]);
    return (S.names[id] || "一位玩家");
  }
  // Called twice a second: notice players going away (after a few seconds, so a page refresh does not count) and coming back.
  function presenceTick() {
    var pr = S.pres;
    if (!pr || S.kind !== "online" || !S.room || !S.match) return;
    var changed = false, now = Date.now();
    S.room.seats.forEach(function (id) {
      if (!id || id === S.myId) return;
      if (isAway(id)) {
        if (!pr.since[id]) pr.since[id] = now;
        if (!pr.shown[id] && now - pr.since[id] > 4000) { pr.shown[id] = true; changed = true; }
      } else if (pr.since[id]) {
        if (pr.shown[id]) { toast(idLabel(id) + " 回來了。"); changed = true; }
        delete pr.since[id]; delete pr.shown[id]; delete pr.dismissed[id];
      }
    });
    if (changed) render();
  }
  function awayIds() {
    var pr = S.pres, out = [];
    if (pr && S.room) S.room.seats.forEach(function (id) { if (id && pr.shown[id] && out.indexOf(id) < 0) out.push(id); });
    return out;
  }
  window.addEventListener("pagehide", function () { if (S.pres && S.pres.stop) { try { S.pres.stop(); } catch (e) { /* ignore */ } } });

  function leave() {
    stopPresence();
    if (S.unsub) { try { S.unsub(); } catch (e) { /* ignore */ } }
    clearTimeout(S.loadT);
    S.unsub = null; S.kind = null; S.room = null; S.match = null; S.code = null; S.ref = null;
    S.view = "home"; S.ui = {}; S.busy = false; S.missing = false; S.slow = false;
    S.saved = loadSaved(); setHash(""); render();
  }
  // Standalone site only: publish the typed nickname before taking part.
  function syncNick() {
    if (!S.user || !S.user.setName) return;
    var n = S.nick.trim().slice(0, 12);
    if (S.myId) S.names[S.myId] = n;
    S.user.setName(n);
  }
  function newCode() {
    var a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789", s = "";
    for (var i = 0; i < 4; i++) s += a[Math.floor(Math.random() * a.length)];
    return s;
  }
  function createRoom(tries) {
    if (S.busy) return;
    S.busy = true; render();
    var code = newCode(), ref = S.db.doc("rooms/" + code);
    ref.get().then(function (snap) {
      if (snap.exists) { if ((tries || 0) > 5) throw { soft: "暫時產生不了房號，請再試一次。" }; S.busy = false; return createRoom((tries || 0) + 1); }
      var seats = []; for (var i = 0; i < S.setup.n; i++) seats.push(i === 0 ? S.myId : "");
      return ref.set({ code: code, n: S.setup.n, opts: setupOpts(), seats: seats, match: null, v: 1, at: Date.now() })
        .then(function () { S.busy = false; enterRoom(code); });
    }).then(null, function (e) { S.busy = false; toast(e && e.soft ? e.soft : errMsg(e)); render(); });
  }
  function enterRoom(code) {
    if (S.unsub) { try { S.unsub(); } catch (e) { /* ignore */ } }
    S.kind = "online"; S.code = code; S.ref = S.db.doc("rooms/" + code);
    S.room = null; S.match = null; S.view = "room"; S.ui = {}; S.missing = false; S.slow = false; S.stamp = ""; S.anim = null;
    setHash("r-" + code);
    clearTimeout(S.loadT);
    S.loadT = setTimeout(function () { S.slow = true; render(); }, 10000);
    startPresence();
    S.unsub = S.ref.onSnapshot(function (snap) {
      if (!snap.metadata || !snap.metadata.fromCache) { clearTimeout(S.loadT); S.slow = false; }
      if (!snap.exists) { if (!snap.metadata || !snap.metadata.fromCache) { S.missing = true; S.room = null; S.match = null; render(); } return; }
      var data = snap.data();
      if (S.room && (data.v || 0) < (S.room.v || 0)) return;
      S.missing = false; S.room = data; S.match = data.match || null;
      askNames(); render();
    }, function (e) { clearTimeout(S.loadT); toast(errMsg(e)); S.slow = true; render(); });
    render();
  }

  /* ---------- animation ----------
     Played only in room play, on every device in the room when a turn is finished: the piece travels, a broken wall
     shatters as the piece hits it, then the new wall is laid brick by brick.
     S.anim = {t0, place:[r,c], move:{pi, from, path}, broke:key, hit:{k, dr, dc}, wall:key}.
     Every part starts at a time on one shared clock; a redraw mid-way resumes it with a negative delay. */
  var D_MOVE = 650, D_SHARD = 620, D_WALL = 1000, D_PLACE = 900, BRICK_GAP = 75;
  function animPlan(an) {
    var p = { move: 0, hit: 0, wall: an.move ? D_MOVE : 0 };
    if (an.broke && an.hit) p.hit = D_MOVE * (an.hit.k + 0.5) / an.move.path.length;
    p.end = an.place ? D_PLACE : Math.max(an.move ? D_MOVE : 0, an.wall ? p.wall + D_WALL : 0, an.broke ? p.hit + D_SHARD : 0);
    return p;
  }
  function setAnim(an) { S.anim = S.animOn && an ? an : null; if (S.anim) S.anim.t0 = Date.now(); }
  function liveAnim() {
    var an = S.anim;
    if (!an) return null;
    if (Date.now() - an.t0 > animPlan(an).end + 80) { S.anim = null; return null; }
    return an;
  }
  function delayCss(an, start) { return "animation-delay:" + Math.round(start - (Date.now() - an.t0)) + "ms;"; }
  function lastAnim(last) {
    if (!last) return null;
    if (last.kind === "place") return { place: last.to };
    var an = { move: { pi: last.pi, from: last.from, path: last.path || [last.to] }, broke: last.broke || null, wall: last.wall || null, hit: null };
    if (an.broke) { // which step of the path runs into the broken wall, and in which direction
      var prev = last.from;
      an.move.path.forEach(function (cell, k) {
        for (var d = 0; d < 4; d++) if (prev[0] + WG.DIRS[d][0] === cell[0] && prev[1] + WG.DIRS[d][1] === cell[1] && WG.edgeKey(prev[0], prev[1], d) === an.broke)
          an.hit = { k: k, dr: WG.DIRS[d][0], dc: WG.DIRS[d][1] };
        prev = cell;
      });
      if (!an.hit) an.hit = { k: 0, dr: 0, dc: 0 };
    }
    return an;
  }
  try { var sv = localStorage.getItem("wg2-anim"); S.animOn = sv === null ? !(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) : sv === "1"; } catch (e) { /* keep default */ }

  // A wall as small blocks along its length: [x, y, w, h] each. offset=true shifts the row by half a block, like a second course of bricks.
  function wallBlocks(l, n, offset) {
    var horiz = l[1] === l[3], a0 = (horiz ? l[0] : l[1]) + 6, len = C - 12, unit = len / n, out = [], T = 7;
    var cuts = [];
    if (!offset) for (var i = 0; i <= n; i++) cuts.push(i * unit);
    else { cuts.push(0); for (var j = 0; j < n; j++) cuts.push((j + 0.5) * unit); cuts.push(len); }
    for (var k = 0; k < cuts.length - 1; k++) {
      var s = a0 + cuts[k] + 0.6, w = cuts[k + 1] - cuts[k] - 1.2;
      out.push(horiz ? [s, l[1] - T / 2, w, T] : [l[0] - T / 2, s, T, w]);
    }
    return out;
  }
  function blockSvg(b, cls, style) { return '<rect class="' + cls + '" style="' + style + '" x="' + b[0].toFixed(1) + '" y="' + b[1].toFixed(1) + '" width="' + b[2].toFixed(1) + '" height="' + b[3].toFixed(1) + '" rx="1.2"/>'; }
  // New wall: a first course of bricks rises from the floor one by one, a second course is set on top, then the finished wall.
  function bricksSvg(l, an, start, cls) {
    var out = "", t = start;
    wallBlocks(l, 4, false).forEach(function (b) { out += blockSvg(b, "a-brick", delayCss(an, t)); t += BRICK_GAP; });
    t += 60;
    wallBlocks(l, 4, true).forEach(function (b) { out += blockSvg(b, "a-brick l2", delayCss(an, t)); t += BRICK_GAP; });
    return out + lineSvg(l, cls + " a-wallin", delayCss(an, start + D_WALL - 200));
  }
  // Broken wall: it stands until the piece reaches it, then bursts into shards thrown the way the piece is travelling.
  var SPREAD = [-20, 14, -8, 22, -16, 6, 18, -12], REACH = [38, 56, 30, 48, 60, 34, 46, 52], SPIN = [-220, 160, 300, -140, 240, -280, 120, -190];
  function shardsSvg(l, an, at) {
    var out = lineSvg(l, "a-hold", delayCss(an, at)), h = an.hit;
    wallBlocks(l, 8, false).forEach(function (b, i) {
      var fx = h.dc * REACH[i] + (h.dr ? SPREAD[i] : SPREAD[i] * 0.35), fy = h.dr * REACH[i] + (h.dc ? SPREAD[i] : SPREAD[i] * 0.35);
      out += blockSvg(b, "a-shard", "--fx:" + fx.toFixed(0) + "px;--fy:" + fy.toFixed(0) + "px;--fr:" + SPIN[i] + "deg;" + delayCss(an, at + (i % 3) * 25));
    });
    return out + '<circle class="a-ring" style="' + delayCss(an, at) + '" cx="' + (l[0] + l[2]) / 2 + '" cy="' + (l[1] + l[3]) / 2 + '" r="16"/>';
  }

  /* ---------- the board ---------- */
  function X(c) { return P + c * C; }
  function sideLine(r, c, d) {
    var x1 = X(c), y1 = X(r), x2 = X(c + 1), y2 = X(r + 1);
    if (d === 0) return [x1, y1, x2, y1];
    if (d === 2) return [x1, y2, x2, y2];
    if (d === 1) return [x2, y1, x2, y2];
    return [x1, y1, x1, y2];
  }
  function keyLine(k) {
    var m = /^([hv])(\d)_(\d)$/.exec(k);
    return sideLine(+m[2], +m[3], m[1] === "h" ? 2 : 1);
  }
  function lineSvg(l, cls, style) {
    var horiz = l[1] === l[3], i = 6;
    return '<line class="wall ' + cls + '"' + (style ? ' style="' + style + '"' : "") + ' x1="' + (l[0] + (horiz ? i : 0)) + '" y1="' + (l[1] + (horiz ? 0 : i)) +
      '" x2="' + (l[2] - (horiz ? i : 0)) + '" y2="' + (l[3] - (horiz ? 0 : i)) + '"/>';
  }
  // A wall drawn as a rounded bar, for the sides on offer and the one being previewed.
  function barSvg(l, cls) {
    var horiz = l[1] === l[3], i = 7, T = 8;
    var x = horiz ? l[0] + i : l[0] - T / 2, y = horiz ? l[1] - T / 2 : l[1] + i, w = horiz ? C - 2 * i : T, h = horiz ? T : C - 2 * i;
    return '<rect class="' + cls + '" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="4"/>';
  }
  function hitSvg(l, attrs) {
    var horiz = l[1] === l[3], t = 17;
    var x = horiz ? l[0] + 8 : l[0] - t, y = horiz ? l[1] - t : l[1] + 8;
    var w = horiz ? C - 16 : t * 2, h = horiz ? t * 2 : C - 16;
    return '<rect class="hit" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" ' + attrs + "/>";
  }
  function cellHit(r, c, attrs) { return '<rect class="hit" x="' + X(c) + '" y="' + X(r) + '" width="' + C + '" height="' + C + '" ' + attrs + "/>"; }
  function pieceSvg(pc, r, c, extra, style) {
    var cx = X(c) + C / 2, cy = X(r) + C / 2, cls = "pc p" + pc.p + (extra ? " " + extra : "") + '"' + (style ? ' style="' + style : "");
    return pc.t === "s"
      ? '<rect class="' + cls + '" x="' + (cx - 18) + '" y="' + (cy - 18) + '" width="36" height="36" rx="6"/>'
      : '<circle class="' + cls + '" cx="' + cx + '" cy="' + cy + '" r="19"/>';
  }

  function boardSvg(g, act) {
    var ui = S.ui, out = [], hits = [], r, c, i;
    var regs = WG.regions(g), own = {};
    var dead = {}; // sealed areas with no piece inside: nobody's territory
    regs.forEach(function (rg) {
      if (rg.owners.length === 1) rg.cells.forEach(function (cl) { own[cl[0] + "," + cl[1]] = rg.owners[0]; });
      else if (rg.owners.length === 0 && regs.length > 1) rg.cells.forEach(function (cl) { dead[cl[0] + "," + cl[1]] = true; });
    });
    out.push('<defs><pattern id="deadfill" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      '<rect class="dead-bg" width="8" height="8"/><line class="dead-ln" x1="0" y1="0" x2="0" y2="8"/></pattern></defs>');
    var last = g.last || {};
    for (r = 0; r < N; r++) for (c = 0; c < N; c++) {
      var k = r + "," + c, cls = "cell" + (own[k] !== undefined ? " own" + own[k] : dead[k] ? " dead" : "");
      if (last.from && last.from[0] === r && last.from[1] === c) cls += " from";
      out.push('<rect class="' + cls + '" x="' + (X(c) + 2) + '" y="' + (X(r) + 2) + '" width="' + (C - 4) + '" height="' + (C - 4) + '" rx="5"/>');
    }
    var pend = ui.pend || null, an = liveAnim(), plan = an ? animPlan(an) : null;
    Object.keys(g.walls).forEach(function (wk) {
      var cl = pend && pend.brk === wk ? "gone" : (last.wall === wk ? "new" : "");
      if (an && an.wall === wk) out.push(bricksSvg(keyLine(wk), an, plan.wall, cl));
      else out.push(lineSvg(keyLine(wk), cl));
    });
    var overlay = an && an.broke ? shardsSvg(keyLine(an.broke), an, plan.hit) : ""; // drawn above the pieces
    out.push('<rect class="frame" x="' + P + '" y="' + P + '" width="' + C * N + '" height="' + C * N + '" rx="4"/>');
    // the clock: the board's own frame, lit in colour and burning down as time runs out
    if (g.phase !== "over" && S.match && S.match.opts && S.match.opts.timer)
      out.push('<rect class="tframe" id="tframe" pathLength="100" stroke-dasharray="100 100" x="' + P + '" y="' + P + '" width="' + C * N + '" height="' + C * N + '" rx="4"/>');

    var cur = WG.current(g), moves = [], movable = {};
    if (g.phase === "play" && act) {
      moves = WG.legalMoves(g, cur);
      moves.forEach(function (m) { movable[m.pi] = true; });
      var keys = Object.keys(movable);
      if (ui.sel === undefined && !pend && keys.length === 1) ui.sel = +keys[0];
    }
    // pieces
    g.pieces.forEach(function (pc, pi) {
      var pr = pc.r, pcn = pc.c;
      if (pend && pend.pi === pi) {
        out.push(pieceSvg(pc, pc.r, pc.c, "")); hits.push(cellHit(pc.r, pc.c, 'data-a="back" aria-label="收回這一步"'));
        var pts = [[pc.r, pc.c]].concat(pend.path).map(function (q) { return (X(q[1]) + C / 2) + "," + (X(q[0]) + C / 2); }).join(" ");
        out.push('<polyline class="trail" style="stroke:var(--p' + pc.p + ')" points="' + pts + '"/>');
        out.push(pieceSvg(pc, pend.to[0], pend.to[1], "pre"));
        if (!WG.needsWall(g, pend)) hits.push(cellHit(pend.to[0], pend.to[1], 'data-a="confirm" data-pre="1" aria-label="再點一次確定"'));
        return;
      }
      var sealed = own[pc.r + "," + pc.c] !== undefined && g.phase === "play" && !(g.round === 1 && g.brk[pc.p]);
      var pcls = sealed ? "locked" : "", pst = "";
      if (an && an.move && an.move.pi === pi) {
        var mid = an.move.path.length > 1 ? an.move.path[0] : [(an.move.from[0] + pr) / 2, (an.move.from[1] + pcn) / 2];
        pcls += " a-move";
        pst = "--x0:" + (an.move.from[1] - pcn) * C + "px;--y0:" + (an.move.from[0] - pr) * C + "px;--x1:" + (mid[1] - pcn) * C + "px;--y1:" + (mid[0] - pr) * C + "px;" + delayCss(an, plan.move);
      } else if (an && an.place && an.place[0] === pr && an.place[1] === pcn) {
        pcls += " a-pop"; pst = delayCss(an, 0);
        out.push('<circle class="a-ripple" style="stroke:var(--p' + pc.p + ');' + delayCss(an, 330) + '" cx="' + (X(pcn) + C / 2) + '" cy="' + (X(pr) + C / 2) + '" r="30"/>');
      }
      out.push(pieceSvg(pc, pr, pcn, pcls, pst));
      var cx = X(pcn) + C / 2, cy = X(pr) + C / 2;
      if ((ui.sel === pi && !pend) || (pend && pend.pi === pi)) out.push('<circle class="ring" cx="' + cx + '" cy="' + cy + '" r="26"/>');
      else if (movable[pi] && !pend) out.push('<circle class="ring can" cx="' + cx + '" cy="' + cy + '" r="26"/>');
      if (movable[pi] && !pend) hits.push(cellHit(pc.r, pc.c, 'data-a="pc" data-i="' + pi + '" aria-label="選這枚棋子"'));
    });
    // placement spots
    var pp = g.phase === "place" && act ? ui.pplace : null;
    if (pp) {
      out.push(pieceSvg({ p: cur, t: pp.t }, pp.r, pp.c, "pre", ""));
      hits.push(cellHit(pp.r, pp.c, 'data-a="cell" data-pre="1" data-r="' + pp.r + '" data-c="' + pp.c + '" aria-label="再點一次確定"'));
    }
    if (g.phase === "place" && act) {
      for (r = 0; r < N; r++) for (c = 0; c < N; c++) if (WG.pieceAt(g, r, c) < 0 && !(pp && pp.r === r && pp.c === c)) {
        out.push('<circle class="spot" cx="' + (X(c) + C / 2) + '" cy="' + (X(r) + C / 2) + '" r="5"/>');
        hits.push(cellHit(r, c, 'data-a="cell" data-r="' + r + '" data-c="' + c + '"'));
      }
    }
    // destinations for the selected piece
    S.dests = [];
    if (g.phase === "play" && act && !pend && ui.sel !== undefined && ui.sel !== null && !ui.brkOpts) {
      var by = {};
      moves.forEach(function (m) { if (m.pi !== ui.sel) return; var dk = m.to.join(","); (by[dk] = by[dk] || []).push(m); });
      Object.keys(by).forEach(function (dk) {
        var list = by[dk], free = list.filter(function (m) { return !m.brk; });
        var opts = free.length ? [free[0]] : list.filter(function (m, ix) { return list.findIndex(function (o) { return o.brk === m.brk; }) === ix; });
        var to = list[0].to, idx = S.dests.push({ to: to, opts: opts }) - 1;
        out.push('<circle class="dest' + (free.length ? "" : " b") + '" cx="' + (X(to[1]) + C / 2) + '" cy="' + (X(to[0]) + C / 2) + '" r="10"/>');
        hits.push(cellHit(to[0], to[1], 'data-a="dest" data-i="' + idx + '"'));
      });
    }
    // which wall to break, when two different walls lead to the same cell
    if (ui.brkOpts) ui.brkOpts.forEach(function (m, ix) {
      var l = keyLine(m.brk); out.push(lineSvg(l, "brk")); hits.push(hitSvg(l, 'data-a="brk" data-i="' + ix + '"'));
    });
    // where the new wall can go
    if (pend && WG.needsWall(g, pend)) WG.wallSides(g, pend).forEach(function (d) {
      var l = sideLine(pend.to[0], pend.to[1], d);
      if (ui.pwall === d) { out.push(barSvg(l, "wallpre")); hits.push(hitSvg(l, 'data-a="wall" data-pre="1" data-d="' + d + '" aria-label="再點一次確定蓋牆"')); return; }
      out.push(barSvg(l, "wallcand" + (ui.pwall !== undefined ? " dim" : ""))); hits.push(hitSvg(l, 'data-a="wall" data-d="' + d + '" aria-label="在這一邊蓋牆"'));
    });
    return '<svg class="board" id="board" viewBox="0 0 ' + SIZE + " " + SIZE + '" role="img" aria-label="7 乘 7 棋盤">' + out.join("") + overlay + hits.join("") + "</svg>";
  }

  /* ---------- views ---------- */
  function seg(id, opts, val) {
    return '<span class="seg" id="' + id + '">' + opts.map(function (o) {
      return '<button type="button" data-v="' + o[0] + '" aria-pressed="' + (String(o[0]) === String(val)) + '">' + o[1] + "</button>";
    }).join("") + "</span>";
  }
  // One row of the setup form: formal name, a help button after it, the choices, and the explanation when opened.
  var HELP = {
    n: "三人局：三位玩家同場，領地最大者直接晉級，其餘兩位再進行一對一決勝局，敗者淘汰。雙人對局：直接進行一對一，紅方先手。",
    t: "每手限時 90 秒。棋盤外框即為計時條，會隨時間縮短；剩 30 秒轉為橘色，最後 10 秒轉紅並閃爍。逾時由系統隨機落子。",
    b: "僅適用於三人局。使用破牆的那一手，移動後是否仍須蓋一道牆。節目原始規則未能查證，請依雙方共識選擇。",
    u: "二次點擊確認：第一次點擊僅為預覽（以虛線顯示），再次點擊同一位置才生效；生效前可改選或復原。單次點擊：點擊即生效，無法更改。",
    a: "線上對局時，每回合結束後在所有裝置播放落子、移動、破牆與蓋牆的動畫。此設定僅影響本裝置；本機對局不播放動畫。"
  };
  function setRow(key, name, control) {
    var open = S.help === key;
    return '<div class="set"><div class="set-name"><span>' + name + '</span><button class="help" type="button" data-help="' + key + '" aria-expanded="' + open +
      '" aria-label="' + name + "說明" + '">?</button></div><div class="set-ctl">' + control + "</div>" +
      (open ? '<p class="set-help">' + HELP[key] + "</p>" : "") + "</div>";
  }
  function homeHtml() {
    var h = '<section class="panel"><h2>對局設定</h2><div class="sets">' +
      setRow("n", "對局人數", seg("segN", [[3, "三人局（含決勝局）"], [2, "雙人對局"]], S.setup.n)) +
      setRow("t", "思考時間", seg("segT", [[90, "每手 90 秒"], [0, "不限時"]], S.setup.timer)) +
      (S.setup.n === 3 ? setRow("b", "破牆後蓋牆", seg("segB", [[0, "需要蓋牆"], [1, "不蓋牆"]], S.setup.brkNoWall ? 1 : 0)) : "") +
      setRow("u", "落子確認", seg("segU", [[1, "二次點擊確認"], [0, "單次點擊"]], S.setup.undo ? 1 : 0)) +
      setRow("a", "回合動畫", seg("segA", [[1, "開啟"], [0, "關閉"]], S.animOn ? 1 : 0)) + "</div></section>";
    h += '<div class="modes"><section class="panel"><h2>本機對局</h2><p>所有玩家共用本裝置，輪流操作。</p><div class="btns">' +
      '<button class="primary" type="button" id="goLocal">開始對局</button>' +
      (S.saved && S.saved.game ? '<button type="button" id="goResume">繼續上次對局</button>' : "") + "</div></section>";
    h += '<section class="panel"><h2>線上對局</h2>';
    if (S.net === "loading") h += "<p>正在檢查連線功能……</p>";
    else if (S.net === "none") h += "<p>" + esc(window.WG_NET_NOTE || "目前無法使用線上對局。請登入 Claude 後，由頁面擁有者分享的連結開啟。本機對局不受影響。") + "</p>";
    else {
      h += "<p>每位玩家以各自的裝置開啟本頁；由房主建立房間後，將房間代碼或邀請連結提供給其他玩家。</p>" +
        (S.canWrite === false ? '<div class="warnbox">您目前為檢視權限，可進入房間觀戰，無法入座對局。</div>' : "") +
        (S.user && S.user.setName ? '<label class="fld" for="nickIn">玩家名稱（其他玩家可見）<input type="text" class="plain" id="nickIn" maxlength="12" autocomplete="off" value="' + esc(S.nick) + '"></label>' : "") +
        '<div class="btns"><button class="primary" type="button" id="goCreate"' + (S.busy || S.canWrite === false ? " disabled" : "") + ">建立房間</button></div>" +
        '<div class="join"><label class="fld" for="codeIn">房間代碼<input type="text" id="codeIn" maxlength="4" autocomplete="off" autocapitalize="characters" inputmode="text"></label>' +
        '<button type="button" id="goJoin">加入房間</button></div>';
    }
    return h + "</section></div>";
  }
  function roomHtml() {
    if (S.missing) return '<section class="panel"><h2>找不到房間 ' + esc(S.code) + '</h2><p>請確認房號，或請對方重新建立。</p><div class="row"><button type="button" id="goHome">回首頁</button></div></section>';
    if (!S.room) return '<section class="panel"><h2>正在進入房間 ' + esc(S.code) + "</h2><p>" + (S.slow ? "還連不上資料，請確認網路後稍候。" : "讀取中……") + "</p></section>";
    var room = S.room, full = room.seats.every(function (x) { return !!x; }), h = "";
    h += '<section class="panel"><p>房間代碼</p><div class="code">' + esc(room.code) + "</div>" +
      (window.WG_STANDALONE ? '<div class="row"><button class="small" type="button" id="goCopy">複製邀請連結</button></div>' : "") +
      "<p>請將房間代碼" + (window.WG_STANDALONE ? "或邀請連結" : "") + "提供給其他玩家；對方開啟本頁、輸入代碼後即可入座。" +
      "本房設定：" + (room.n === 3 ? "三人局（含決勝局）" : "雙人對局") + "、" + (room.opts && room.opts.timer ? "每手 " + room.opts.timer + " 秒" : "不限時") + (room.n === 3 ? "、破牆後" + (room.opts && room.opts.brkNoWall ? "不蓋牆" : "需要蓋牆") : "") + "、" + (room.opts && room.opts.undo ? "二次點擊確認" : "單次點擊") + "。</p></section>";
    h += '<section class="panel"><h2>座位</h2>' +
      (S.user && S.user.setName && !seated() ? '<div class="row"><label class="fld" for="nickIn">暱稱（對手看得到）<input type="text" class="plain" id="nickIn" maxlength="12" autocomplete="off" value="' + esc(S.nick) + '"></label></div>' : "") +
      '<div class="seats">';
    room.seats.forEach(function (id, i) {
      var mine = id && id === S.myId;
      h += '<div class="seat" style="--pc:var(--p' + i + ')"><span class="nm">' + (id ? esc(label(i)) : NAMES[i] + "　空位") + "</span>" +
        (!id ? '<button class="small" type="button" data-sit="' + i + '"' + (S.busy || S.canWrite === false ? " disabled" : "") + ">入座</button>"
          : mine ? '<button class="small ghost" type="button" data-unsit="' + i + '"' + (S.busy ? " disabled" : "") + ">離席</button>" : "") + "</div>";
    });
    h += "</div>";
    h += '<div class="row"><button class="primary" type="button" id="goStart"' + (full && seated() && !S.busy ? "" : " disabled") + ">開始對局</button>" +
      '<span class="note">' + (full ? (seated() ? "玩家已到齊。" : "您尚未入座，僅能觀戰。") : "待所有座位入座後即可開始。同一裝置可入座多個座位，供自行測試。") + "</span></div></section>";
    return h;
  }

  function statusText(g, cur, act) {
    var ui = S.ui;
    if (g.phase === "place") {
      var ts = WG.placeTypes(g);
      if (!act) return "等待 " + label(cur) + " 擺放棋子";
      if (ui.pplace) return label(cur) + "：再點一次同一格確定，或點別格改位置";
      return label(cur) + "：點一個空格，擺放" + (ts.length === 1 ? TYPE[ts[0]] : "") + "棋子";
    }
    if (!act) return "等待 " + label(cur) + " 下棋";
    var undoOn = !!(g.opts && g.opts.undo);
    if (ui.pend && ui.pwall !== undefined) return label(cur) + "：再點一次同一道牆確定，或點別邊改位置";
    if (ui.pend) return label(cur) + (WG.needsWall(g, ui.pend) ? "：點棋子旁淡色的邊，選一邊蓋牆" + (undoOn ? "" : "（點了就結束回合）") : "：這一手破牆後不蓋牆，再點一次棋子確定");
    if (ui.brkOpts) return label(cur) + "：點要拆掉的牆";
    if (ui.sel !== undefined && ui.sel !== null) return label(cur) + "：選目的地" + (g.round === 1 && g.brk[cur] ? "（橘點要用掉破牆）" : "");
    return label(cur) + "：選一枚棋子";
  }
  function resultHtml(m) {
    var v = WG.verdict(m), g = m.game, h = '<section class="panel" id="result"><h2>' + (m.stage === "r1" ? "三人局結果" : (m.n === 3 ? "決勝局結果" : "對局結果")) + "</h2>";
    h += '<table class="rank"><thead><tr><th>名次</th><th>玩家</th><th>領地</th><th>最大區塊</th></tr></thead><tbody>';
    v.rank.forEach(function (x, i) {
      h += "<tr><td>" + (i + 1) + '</td><td><span class="sw" style="--pc:var(--p' + x.p + ')"></span>' + esc(label(x.p)) + '</td><td class="num">' + x.total + "</td><td>" + x.best + "</td></tr>";
    });
    h += "</tbody></table>";
    if (g.stalemate) h += "<p>沒有人能再移動。混在同一區塊的棋子，各算腳下 1 格。</p>";
    var can = seated() && !S.busy;
    if (v.kind === "tie") h += "<p>前兩名完全同分，將交換順序重新對局。</p>" + '<div class="row"><button class="primary" type="button" id="goNext"' + (can ? "" : " disabled") + ">重新對局</button></div>";
    else if (v.kind === "toDuel") h += "<p>" + esc(label(v.safe)) + " 晉級。" + esc(label(v.duel[0])) + " 與 " + esc(label(v.duel[1])) + " 進入決勝局：" + esc(label(v.duel[0])) + " 改執紅棋先手，" + esc(label(v.duel[1])) + " 改執藍棋。</p>" +
      '<div class="row"><button class="primary" type="button" id="goNext"' + (can ? "" : " disabled") + ">進入決勝局</button></div>";
    else h += "<p>" + esc(label(v.winner)) + " 獲勝，" + esc(label(v.out)) + " 淘汰。" + (m.safe !== null && m.safe !== undefined ? esc(seatLabel(m.safe)) + " 已於三人局晉級。" : "") + "</p>" +
      '<div class="row"><button class="primary" type="button" id="goAgain"' + (can ? "" : " disabled") + ">再開一局</button></div>";
    return h + "</section>";
  }
  // Small pictograms for the in-game rules card. 48 x 48, drawn from the same tokens as the board.
  function ico(inner) { return '<svg class="ico" viewBox="0 0 48 48" aria-hidden="true">' + inner + "</svg>"; }
  var ARW = '<marker id="ar" markerWidth="6" markerHeight="6" refX="4.5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" class="i-arf"/></marker>';
  var ICON = {
    sq: ico("<defs>" + ARW + '</defs><rect class="i-pc" x="3" y="17" width="14" height="14" rx="3"/><line class="i-ar" x1="20" y1="24" x2="43" y2="24" marker-end="url(#ar)"/><circle class="i-dot" cx="28" cy="24" r="3"/><circle class="i-dot" cx="38" cy="24" r="3"/>'),
    rd: ico("<defs>" + ARW + '</defs><circle class="i-pc" cx="10" cy="36" r="7"/><path class="i-ar" d="M19 36 H34 V10" marker-end="url(#ar)"/><circle class="i-dot" cx="34" cy="36" r="3"/><circle class="i-dot" cx="34" cy="18" r="3"/>'),
    wall: ico('<rect class="i-cell" x="9" y="9" width="30" height="30" rx="4"/><rect class="i-pc" x="17" y="17" width="14" height="14" rx="3"/><line class="i-wall" x1="39" y1="10" x2="39" y2="38"/><line class="i-slot" x1="12" y1="9" x2="36" y2="9"/><line class="i-slot" x1="12" y1="39" x2="36" y2="39"/><line class="i-slot" x1="9" y1="12" x2="9" y2="36"/>'),
    brk: ico("<defs>" + ARW + '</defs><line class="i-wall" x1="26" y1="4" x2="26" y2="15"/><line class="i-wall" x1="26" y1="33" x2="26" y2="44"/><rect class="i-shard" x="30" y="16" width="5" height="4" transform="rotate(25 32 18)"/><rect class="i-shard" x="33" y="26" width="5" height="4" transform="rotate(-30 35 28)"/><rect class="i-shard" x="29" y="22" width="4" height="4" transform="rotate(50 31 24)"/><rect class="i-pc" x="3" y="17" width="14" height="14" rx="3"/><line class="i-ar" x1="19" y1="24" x2="43" y2="24" marker-end="url(#ar)"/>'),
    area: ico('<defs><pattern id="ih" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="dead-bg" width="5" height="5"/><line class="dead-ln" x1="0" y1="0" x2="0" y2="5"/></pattern></defs><rect class="i-own" x="4" y="12" width="18" height="24" rx="3"/><circle class="i-pc" cx="13" cy="24" r="5"/><rect x="26" y="12" width="18" height="24" rx="3" fill="url(#ih)"/><line class="i-wall" x1="24" y1="9" x2="24" y2="39"/>'),
    win: ico('<rect class="i-own" x="6" y="10" width="14" height="30" rx="3"/><rect class="i-own2" x="28" y="24" width="14" height="16" rx="3"/><path class="i-crown" d="M7 7 l3 -4 l3 3 l3 -3 l3 4 z"/>')
  };
  function rulesCard(g, m) {
    var items = [
      [ICON.sq, "方形棋", "沿單一方向直行 1 或 2 格。"],
      [ICON.rd, "圓形棋", "移動 1 格；或移動 1 格後轉向，再移動 1 格。"],
      [ICON.wall, "蓋牆", "每手移動後，須於棋子所在格的四邊擇一蓋牆。"]
    ];
    if (g.round === 1) items.push([ICON.brk, "破牆（每人一次）", "可拆除擋在移動路徑上的一道牆" + (g.opts && g.opts.brkNoWall ? "；該手不另蓋牆。" : "，之後仍須蓋牆。")]);
    items.push([ICON.area, "領地與死區", "僅有己方棋子的封閉區域為領地；沒有棋子的封閉區域為死區（斜線），不計分。"]);
    items.push([ICON.win, "勝負", g.round === 1 ? "所有棋子被隔開即結束；領地最大者晉級，其餘兩位進入決勝局。" : "所有棋子被隔開即結束；領地格數多者獲勝。"]);
    var wide = window.matchMedia && matchMedia("(orientation: landscape) and (min-width: 700px)").matches;
    var open = S.rulesOpen === undefined ? wide : S.rulesOpen;
    return '<details class="rcard" id="rcard"' + (open ? " open" : "") + "><summary>規則速覽</summary><ul>" + items.map(function (it) {
      return "<li>" + it[0] + "<div><b>" + it[1] + "</b><span>" + it[2] + "</span></div></li>";
    }).join("") + "</ul></details>";
  }
  function gameHtml() {
    var m = S.match, g = m.game, cur = WG.current(g), act = canAct(cur), sc = WG.scores(g), h = "";
    // reset the half-made move whenever the position changes underneath us
    var stamp = [S.code, m.stage, m.replays, g.phase, g.moveNo, g.queue.length, cur].join("|");
    if (stamp !== S.stamp) {
      var fresh = !S.stamp || S.stamp.split("|")[0] !== String(S.code || ""); // first sight of this game: nothing to replay
      var mode = S.nextAnim || "full"; S.nextAnim = null;
      S.stamp = stamp; S.ui = {};
      void mode; setAnim(fresh || S.kind !== "online" ? null : lastAnim(g.last)); // room play: everyone, the mover included, sees the finished turn
    }
    var ids = g.round === 1 ? [0, 1, 2] : [0, 1];
    h += '<div class="game"><div class="g-top"><div class="scores">';
    ids.forEach(function (p) {
      var inGame = g.order.indexOf(p) >= 0, sub;
      if (!inGame) sub = "已晉級";
      else if (g.round === 1) sub = "破牆 " + (g.brk[p] ? "可用" : "已用");
      else sub = g.order[0] === p ? "先手" : "後手";
      if (inGame && S.kind === "online" && awayIds().indexOf(seatOf(p)) >= 0) sub = "已離線";
      h += '<div class="chip' + (cur === p ? " turn" : "") + (inGame ? "" : " dim") + '" style="--pc:var(--p' + p + ')"><span class="n">' + (inGame ? sc[p].total : "–") +
        '</span><span class="who">' + esc(label(p)) + '</span><span class="sub">' + sub + "</span></div>";
    });
    h += "</div>";
    var boardHtml = boardSvg(g, act && g.phase !== "over"); // also auto-selects a lone movable piece
    if (g.phase !== "over") {
      h += '<div class="status"><span class="dot" style="--pc:var(--p' + cur + ')"></span><span class="msg" id="msg">' + esc(statusText(g, cur, act)) + "</span>" +
        (m.opts && m.opts.timer ? '<span class="timer" id="timer">--</span>' : "") + "</div>";
    }
    h += '</div><div class="boardarea"><div class="boardbox">' + boardHtml + '</div></div><div class="g-bottom">';
    var gone = S.kind === "online" ? awayIds().filter(function (id) { return !S.pres.dismissed[id]; }) : [];
    if (gone.length) h += '<div class="warnbox" id="awayBox"><b>' + gone.map(function (id) { return esc(idLabel(id)); }).join("、") + " 離開了房間或斷線了。</b>" +
      "可以等對方回來接著下，或是離開房間。" + (m.opts && m.opts.timer ? "對方的時間照常倒數。" : "") +
      '<div class="row" style="margin-top:8px"><button type="button" id="goWait">繼續等待</button><button type="button" id="goQuit">離開房間</button></div></div>';
    if (g.phase !== "over") {
      var ui = S.ui, stage = g.round === 1 ? "三人局" : (m.n === 3 ? "決勝局" : "雙人對局");
      h += '<section class="acts"><div class="acts-head"><span>' + stage + (g.round === 2 && m.safe !== null && m.safe !== undefined ? "｜" + esc(seatLabel(m.safe)) + " 已晉級" : "") + "</span></div>";
      if (g.phase === "place" && act && WG.placeTypes(g).length > 1)
        h += '<div class="acts-row"><span class="note">落子棋種</span>' + seg("segP", [["s", "方形棋"], ["r", "圓形棋"]], S.ui.ptype || "s") + "</div>";
      h += '<div class="acts-grid">' +
        '<button type="button" id="goUndo"' + (act && (ui.pplace || ui.pend || ui.brkOpts) ? "" : " disabled") + ">復原上一步</button>" +
        (S.kind === "online" ? '<button type="button" id="goAnim" aria-pressed="' + S.animOn + '">回合動畫：' + (S.animOn ? "開啟" : "關閉") + "</button>" : "") +
        '<button class="hidden wide" type="button" id="goForce">對手逾時：代為隨機落子</button></div></section>';
      h += rulesCard(g, m);
    } else h += resultHtml(m);
    return h + "</div></div>";
  }

  function render() {
    var tag = $("tag");
    if (S.kind === "online" && S.code) { tag.innerHTML = "房間 <b>" + esc(S.code) + "</b>"; tag.classList.remove("hidden"); }
    else if (S.kind === "local") { tag.textContent = "本機對局"; tag.classList.remove("hidden"); }
    else tag.classList.add("hidden");
    $("btnLeave").classList.toggle("hidden", S.view === "home");
    var ae = document.activeElement, keepId = ae && (ae.id === "codeIn" || ae.id === "nickIn") ? ae.id : null;
    var keepCode = $("codeIn") ? $("codeIn").value : "";
    var inGame = S.view !== "home" && !(S.kind === "online" && !S.match);
    view.className = inGame ? "v-game" : "v-list";
    document.body.classList.toggle("in-game", inGame);
    if (S.view === "home") view.innerHTML = homeHtml();
    else if (!inGame) view.innerHTML = roomHtml();
    else view.innerHTML = gameHtml();
    if ($("codeIn")) $("codeIn").value = keepCode;
    if (keepId && $(keepId)) { var kel = $(keepId); kel.focus(); try { kel.setSelectionRange(kel.value.length, kel.value.length); } catch (e) { /* ignore */ } }
    tick();
  }

  /* ---------- actions ---------- */
  // mode "none": this device made the move itself, so there is nothing to replay; "full": it was made for the player (a timeout).
  function placeType() { var ts = WG.placeTypes(S.match.game); return ts.length === 1 ? ts[0] : (S.ui.ptype || "s"); }
  function doPlace(r, c, t, mode) {
    var m = WG.clone(S.match); m.game = WG.place(S.match.game, t || placeType(), r, c); S.nextAnim = mode || "none"; commit(m);
  }
  function doTurn(mv, d, mode) {
    var m = WG.clone(S.match); m.game = WG.applyTurn(S.match.game, mv, d); S.nextAnim = mode || "none"; commit(m);
  }
  function undoOn() { var m = S.match; return !!(m && m.opts && m.opts.undo); }
  // Finish the turn from whatever has been laid out so far.
  function endTurn() {
    var g = S.match.game, ui = S.ui;
    try {
      if (g.phase === "place" && ui.pplace) doPlace(ui.pplace.r, ui.pplace.c, ui.pplace.t, "none");
      else if (g.phase === "play" && ui.pend) doTurn(ui.pend, WG.needsWall(g, ui.pend) ? ui.pwall : null, "none");
    } catch (err) { S.ui = {}; render(); }
  }
  // Step back one action inside the turn: the wall first, then the move (and any wall it broke), then a placed piece.
  function undoStep() {
    var ui = S.ui;
    if (ui.pwall !== undefined) delete ui.pwall;
    else if (ui.pend || ui.brkOpts) { ui.pend = null; ui.brkOpts = null; }
    else if (ui.pplace) delete ui.pplace;
    render();
  }
  function autoPlay() {
    var g = S.match.game;
    if (g.phase === "place") {
      var free = [];
      for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) if (WG.pieceAt(g, r, c) < 0) free.push([r, c]);
      var f = free[Math.floor(Math.random() * free.length)];
      if (S.ui.pplace) doPlace(S.ui.pplace.r, S.ui.pplace.c, S.ui.pplace.t, "none"); else doPlace(f[0], f[1], null, "full");
    } else if (g.phase === "play") {
      if (S.ui.pend) {
        var ws = WG.wallSides(g, S.ui.pend), had = S.ui.pwall !== undefined;
        doTurn(S.ui.pend, !WG.needsWall(g, S.ui.pend) ? null : had ? S.ui.pwall : ws[Math.floor(Math.random() * ws.length)], "none");
      }
      else { var t = WG.randomTurn(g); doTurn(t.mv, t.wall, "full"); }
    }
  }
  function setAnimOn(on) {
    S.animOn = !!on; if (!on) S.anim = null;
    try { localStorage.setItem("wg2-anim", on ? "1" : "0"); } catch (e) { /* optional */ }
  }
  function tick() {
    var m = S.match, el = $("timer");
    if (!m || !m.game || m.game.phase === "over" || !(m.opts && m.opts.timer) || S.view === "home") { presenceTick(); return; }
    var rem = m.opts.timer - (Date.now() - (m.turnAt || Date.now())) / 1000, cur = WG.current(m.game);
    var warn = rem <= Math.min(30, m.opts.timer / 3), crit = rem <= 10, mine = isMine(cur);
    [el, $("tframe")].forEach(function (x) {
      if (!x) return;
      x.classList.toggle("warn", warn && !crit); x.classList.toggle("crit", crit); x.classList.toggle("mine", mine);
    });
    if (el) { var s = Math.max(0, Math.ceil(rem)); el.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
    var bd = $("board");
    if (bd) { bd.classList.toggle("t-crit", crit); bd.classList.toggle("t-mine", mine); }
    var tf = $("tframe");
    if (tf) tf.setAttribute("stroke-dasharray", Math.max(0, Math.min(100, rem / m.opts.timer * 100)).toFixed(1) + " 100");
    if (rem <= 0 && canAct(cur)) { toast(label(cur) + " 逾時，隨機下一手。"); autoPlay(); return; }
    presenceTick();
    var fb = $("goForce");
    if (fb) fb.classList.toggle("hidden", !(S.kind === "online" && rem <= -10 && seated() && !isMine(cur) && !S.busy));
  }
  setInterval(tick, 500);

  // Lay a move out on the board without committing it, and show it happening.
  function pickMove(mv) {
    var pc = S.match.game.pieces[mv.pi];
    void pc; S.ui.pend = mv; delete S.ui.pwall;
  }
  view.addEventListener("click", function (e) {
    var t = e.target, el;
    if ((el = t.closest("[data-a]"))) {
      var a = el.getAttribute("data-a"), ui = S.ui;
      if (a === "pc") { S.ui = { sel: +el.getAttribute("data-i"), ptype: ui.ptype }; render(); }
      else if (a === "cell") {
        var pr = +el.getAttribute("data-r"), pc = +el.getAttribute("data-c");
        if (undoOn() && ui.pplace && ui.pplace.r === pr && ui.pplace.c === pc) endTurn(); // second tap on the same cell
        else if (undoOn()) { ui.pplace = { t: placeType(), r: pr, c: pc }; render(); }
        else doPlace(pr, pc, null, "none");
      }
      else if (a === "dest") {
        var d = S.dests[+el.getAttribute("data-i")];
        if (d.opts.length === 1) pickMove(d.opts[0]); else ui.brkOpts = d.opts;
        render();
      }
      else if (a === "confirm") endTurn();
      else if (a === "back") { S.ui = { sel: ui.pend ? ui.pend.pi : undefined, ptype: ui.ptype }; render(); }
      else if (a === "brk") { var bo = ui.brkOpts[+el.getAttribute("data-i")]; ui.brkOpts = null; pickMove(bo); render(); }
      else if (a === "wall") {
        var wd = +el.getAttribute("data-d");
        if (undoOn() && ui.pwall === wd) endTurn(); // second tap on the same side
        else if (undoOn()) { ui.pwall = wd; render(); }
        else { try { doTurn(ui.pend, wd, "none"); } catch (err) { S.ui = {}; render(); } }
      }
      return;
    }
    if ((el = t.closest("[data-help]"))) { var hk = el.getAttribute("data-help"); S.help = S.help === hk ? null : hk; render(); return; }
    if ((el = t.closest(".seg"))) {
      var b = t.closest("button"); if (!b) return;
      var v = b.getAttribute("data-v");
      if (el.id === "segN") S.setup.n = +v; else if (el.id === "segT") S.setup.timer = +v; else if (el.id === "segB") S.setup.brkNoWall = v === "1"; else if (el.id === "segU") S.setup.undo = v === "1";
      else if (el.id === "segA") setAnimOn(v === "1");
      else if (el.id === "segP") { S.ui.ptype = v; if (S.ui.pplace) S.ui.pplace.t = v; }
      render(); return;
    }
    if ((el = t.closest("button"))) {
      var id = el.id;
      if (id === "goCreate" || id === "goJoin" || el.hasAttribute("data-sit")) syncNick();
      if (id === "goLocal") startLocal(false);
      else if (id === "goResume") startLocal(true);
      else if (id === "goCreate") createRoom(0);
      else if (id === "goJoin") {
        var code = ($("codeIn").value || "").trim().toUpperCase();
        if (!/^[A-Z0-9]{4}$/.test(code)) toast("房號是 4 個英數字。"); else enterRoom(code);
      }
      else if (id === "goHome") leave();
      else if (id === "goCopy") {
        var url = location.href.split("#")[0] + "#r-" + S.code;
        try { navigator.clipboard.writeText(url).then(function () { toast("已複製邀請連結。"); }, function () { toast("複製失敗，請直接告訴對方房號 " + S.code + "。"); }); }
        catch (err) { toast("複製失敗，請直接告訴對方房號 " + S.code + "。"); }
      }
      else if (id === "goEnd") endTurn();
      else if (id === "goUndo") undoStep();
      else if (id === "goWait") { awayIds().forEach(function (x) { S.pres.dismissed[x] = true; }); render(); }
      else if (id === "goQuit") leave();
      else if (id === "goAnim") { setAnimOn(!S.animOn); render(); }
      else if (id === "goForce") forceTurn();
      else if (id === "goNext") commit(WG.nextStage(S.match));
      else if (id === "goAgain") { var nm = WG.newMatch(S.match.n, S.match.opts); commit(nm); }
      else if (id === "goStart") lobby(function (room) {
        if (room.match) return null;
        if (!room.seats.every(function (x) { return !!x; })) return "還有空位。";
        room.match = WG.newMatch(room.n, room.opts); room.match.turnAt = Date.now(); return null;
      });
      else if (el.hasAttribute("data-sit")) {
        var i = +el.getAttribute("data-sit");
        lobby(function (room) { if (room.seats[i]) return "這個位子剛被坐走了。"; room.seats[i] = S.myId; return null; });
      }
      else if (el.hasAttribute("data-unsit")) {
        var j = +el.getAttribute("data-unsit");
        lobby(function (room) { if (room.match) return "對局已經開始。"; if (room.seats[j] === S.myId) room.seats[j] = ""; return null; });
      }
    }
  });
  // A seated player may move for an opponent who has run well past the clock.
  function forceTurn() {
    var m = S.match, g = m.game, rem = m.opts.timer - (Date.now() - m.turnAt) / 1000;
    if (rem > -10 || g.phase === "over") return;
    S.ui = {}; autoPlay();
  }

  view.addEventListener("toggle", function (e) { if (e.target && e.target.id === "rcard") S.rulesOpen = e.target.open; }, true);
  view.addEventListener("input", function (e) { if (e.target && e.target.id === "nickIn") S.nick = e.target.value; });
  $("btnRules").addEventListener("click", function () { $("rules").classList.toggle("hidden"); });
  $("btnRulesClose").addEventListener("click", function () { $("rules").classList.add("hidden"); });
  $("btnLeave").addEventListener("click", leave);
  // Full screen, where the surrounding app allows it.
  (function () {
    var el = document.documentElement, btn = $("btnFull");
    var req = el.requestFullscreen || el.webkitRequestFullscreen;
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    function on() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
    if (!req || document.fullscreenEnabled === false) return;
    btn.classList.remove("hidden");
    function sync() { btn.textContent = on() ? "離開全螢幕" : "全螢幕"; }
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    btn.addEventListener("click", function () {
      var fail = function () { toast("這個畫面不允許全螢幕。請改用瀏覽器直接開啟頁面連結。"); };
      try {
        var p = on() ? exit.call(document) : req.call(el);
        if (p && p.then) p.then(null, fail);
      } catch (e) { fail(); }
    });
  })();

  /* ---------- shared store ---------- */
  function hashRoom() { var m = /^#r-([A-Za-z0-9]{4})$/.exec(location.hash || ""); return m ? m[1].toUpperCase() : null; }
  function initNet(waited) {
    if (!window.claude || typeof window.claude.use !== "function") {
      if ((waited || 0) > 3000) { S.net = "none"; render(); return; }
      setTimeout(function () { initNet((waited || 0) + 150); }, 150); return;
    }
    Promise.all([window.claude.use("db"), window.claude.use("user")]).then(function (r) {
      S.db = r[0]; S.user = r[1];
      if (!S.db || !S.user) { S.net = "none"; render(); return null; }
      return Promise.all([S.user.id(), S.user.can ? S.user.can("data.write") : null]).then(function (x) {
        S.myId = x[0]; S.canWrite = x[1];
        if (S.user.name) { S.nick = S.user.name() || ""; if (S.myId) S.names[S.myId] = S.nick; }
        S.net = S.myId ? "ok" : "none"; render();
        var code = hashRoom();
        if (S.net === "ok" && code && S.view === "home") enterRoom(code);
      });
    }).then(null, function () { S.net = "none"; render(); });
  }
  window.addEventListener("hashchange", function () {
    var code = hashRoom();
    if (code && S.net === "ok" && code !== S.code) enterRoom(code);
  });

  S.saved = loadSaved();
  render();
  initNet(0);
})();
