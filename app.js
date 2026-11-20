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
    setup: { n: 3, timer: 90 },
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
  function startLocal(resume) {
    S.kind = "local"; S.view = "game"; S.ui = {};
    if (resume && S.saved) { S.match = S.saved; S.match.turnAt = Date.now(); }
    else { S.match = WG.newMatch(S.setup.n, { timer: S.setup.timer }); S.match.turnAt = Date.now(); saveLocal(S.match); }
    render();
  }
  function leave() {
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
      return ref.set({ code: code, n: S.setup.n, opts: { timer: S.setup.timer }, seats: seats, match: null, v: 1, at: Date.now() })
        .then(function () { S.busy = false; enterRoom(code); });
    }).then(null, function (e) { S.busy = false; toast(e && e.soft ? e.soft : errMsg(e)); render(); });
  }
  function enterRoom(code) {
    if (S.unsub) { try { S.unsub(); } catch (e) { /* ignore */ } }
    S.kind = "online"; S.code = code; S.ref = S.db.doc("rooms/" + code);
    S.room = null; S.match = null; S.view = "room"; S.ui = {}; S.missing = false; S.slow = false;
    setHash("r-" + code);
    clearTimeout(S.loadT);
    S.loadT = setTimeout(function () { S.slow = true; render(); }, 10000);
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
  function lineSvg(l, cls) {
    var horiz = l[1] === l[3], i = 6;
    return '<line class="wall ' + cls + '" x1="' + (l[0] + (horiz ? i : 0)) + '" y1="' + (l[1] + (horiz ? 0 : i)) +
      '" x2="' + (l[2] - (horiz ? i : 0)) + '" y2="' + (l[3] - (horiz ? 0 : i)) + '"/>';
  }
  function hitSvg(l, attrs) {
    var horiz = l[1] === l[3], t = 17;
    var x = horiz ? l[0] + 8 : l[0] - t, y = horiz ? l[1] - t : l[1] + 8;
    var w = horiz ? C - 16 : t * 2, h = horiz ? t * 2 : C - 16;
    return '<rect class="hit" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" ' + attrs + "/>";
  }
  function cellHit(r, c, attrs) { return '<rect class="hit" x="' + X(c) + '" y="' + X(r) + '" width="' + C + '" height="' + C + '" ' + attrs + "/>"; }
  function pieceSvg(pc, r, c, extra) {
    var cx = X(c) + C / 2, cy = X(r) + C / 2, cls = "pc p" + pc.p + (extra ? " " + extra : "");
    return pc.t === "s"
      ? '<rect class="' + cls + '" x="' + (cx - 18) + '" y="' + (cy - 18) + '" width="36" height="36" rx="6"/>'
      : '<circle class="' + cls + '" cx="' + cx + '" cy="' + cy + '" r="19"/>';
  }

  function boardSvg(g, act) {
    var ui = S.ui, out = [], hits = [], r, c, i;
    var regs = WG.regions(g), own = {};
    regs.forEach(function (rg) { if (rg.owners.length === 1) rg.cells.forEach(function (cl) { own[cl[0] + "," + cl[1]] = rg.owners[0]; }); });
    var last = g.last || {};
    for (r = 0; r < N; r++) for (c = 0; c < N; c++) {
      var k = r + "," + c, cls = "cell" + (own[k] !== undefined ? " own" + own[k] : "");
      if (last.from && last.from[0] === r && last.from[1] === c) cls += " from";
      out.push('<rect class="' + cls + '" x="' + (X(c) + 2) + '" y="' + (X(r) + 2) + '" width="' + (C - 4) + '" height="' + (C - 4) + '" rx="5"/>');
    }
    var pend = ui.pend || null;
    Object.keys(g.walls).forEach(function (wk) {
      var cl = pend && pend.brk === wk ? "gone" : (last.wall === wk ? "new" : "");
      out.push(lineSvg(keyLine(wk), cl));
    });
    out.push('<rect class="frame" x="' + P + '" y="' + P + '" width="' + C * N + '" height="' + C * N + '" rx="4"/>');

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
      if (pend && pend.pi === pi) { out.push(pieceSvg(pc, pc.r, pc.c, "ghost")); pr = pend.to[0]; pcn = pend.to[1]; }
      var sealed = own[pc.r + "," + pc.c] !== undefined && g.phase === "play" && !(g.round === 1 && g.brk[pc.p]);
      out.push(pieceSvg(pc, pr, pcn, sealed ? "locked" : ""));
      var cx = X(pcn) + C / 2, cy = X(pr) + C / 2;
      if ((ui.sel === pi && !pend) || (pend && pend.pi === pi)) out.push('<circle class="ring" cx="' + cx + '" cy="' + cy + '" r="26"/>');
      else if (movable[pi] && !pend) out.push('<circle class="ring can" cx="' + cx + '" cy="' + cy + '" r="26"/>');
      if (movable[pi] && !pend) hits.push(cellHit(pc.r, pc.c, 'data-a="pc" data-i="' + pi + '" aria-label="選這枚棋子"'));
    });
    // placement spots
    if (g.phase === "place" && act) {
      for (r = 0; r < N; r++) for (c = 0; c < N; c++) if (WG.pieceAt(g, r, c) < 0) {
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
    if (pend) WG.wallSides(g, pend).forEach(function (d) {
      var l = sideLine(pend.to[0], pend.to[1], d);
      out.push(lineSvg(l, "cand")); hits.push(hitSvg(l, 'data-a="wall" data-d="' + d + '" aria-label="在這一邊蓋牆"'));
    });
    return '<svg class="board" id="board" viewBox="0 0 ' + SIZE + " " + SIZE + '" role="img" aria-label="7 乘 7 棋盤">' + out.join("") + hits.join("") + "</svg>";
  }

  /* ---------- views ---------- */
  function seg(id, opts, val) {
    return '<span class="seg" id="' + id + '">' + opts.map(function (o) {
      return '<button type="button" data-v="' + o[0] + '" aria-pressed="' + (String(o[0]) === String(val)) + '">' + o[1] + "</button>";
    }).join("") + "</span>";
  }
  function homeHtml() {
    var h = '<section class="panel"><h2>對局設定</h2>' +
      '<div class="row"><span class="note">人數</span>' + seg("segN", [[3, "三人局接一對一"], [2, "只下一對一"]], S.setup.n) + "</div>" +
      '<div class="row"><span class="note">每步限時</span>' + seg("segT", [[90, "90 秒"], [0, "不限時"]], S.setup.timer) + "</div></section>";
    h += '<section class="panel"><h2>同機輪流</h2><p>大家共用這台裝置，輪到誰就把裝置交給誰。</p><div class="row">' +
      '<button class="primary" type="button" id="goLocal">開始新對局</button>' +
      (S.saved && S.saved.game ? '<button type="button" id="goResume">接著下上一局</button>' : "") + "</div></section>";
    h += '<section class="panel"><h2>連線對戰</h2>';
    if (S.net === "loading") h += "<p>正在檢查連線功能……</p>";
    else if (S.net === "none") h += "<p>" + esc(window.WG_NET_NOTE || "這個畫面目前用不了連線對戰。請登入 Claude 後，從頁面擁有者分享的連結開啟。同機輪流不受影響。") + "</p>";
    else {
      h += "<p>每個人用自己的裝置打開這一頁。開房的人把房號告訴對手。</p>" +
        (S.user && S.user.setName ? '<div class="row"><label class="fld" for="nickIn">暱稱（對手看得到）<input type="text" class="plain" id="nickIn" maxlength="12" autocomplete="off" value="' + esc(S.nick) + '"></label></div>' : "") +
        (S.canWrite === false ? '<div class="warnbox">你目前是檢視權限，可以進房間觀戰，不能入座下棋。</div>' : "") +
        '<div class="row"><button class="primary" type="button" id="goCreate"' + (S.busy || S.canWrite === false ? " disabled" : "") + ">建立房間</button></div>" +
        '<div class="row"><label class="fld" for="codeIn">房號<input type="text" id="codeIn" maxlength="4" autocomplete="off" autocapitalize="characters" inputmode="text"></label>' +
        '<button type="button" id="goJoin" style="align-self:flex-end">加入房間</button></div>';
    }
    return h + "</section>";
  }
  function roomHtml() {
    if (S.missing) return '<section class="panel"><h2>找不到房間 ' + esc(S.code) + '</h2><p>請確認房號，或請對方重新建立。</p><div class="row"><button type="button" id="goHome">回首頁</button></div></section>';
    if (!S.room) return '<section class="panel"><h2>正在進入房間 ' + esc(S.code) + "</h2><p>" + (S.slow ? "還連不上資料，請確認網路後稍候。" : "讀取中……") + "</p></section>";
    var room = S.room, full = room.seats.every(function (x) { return !!x; }), h = "";
    h += '<section class="panel"><p>房號</p><div class="code">' + esc(room.code) + "</div>" +
      (window.WG_STANDALONE ? '<div class="row"><button class="small" type="button" id="goCopy">複製邀請連結</button></div>' : "") +
      "<p>把房號" + (window.WG_STANDALONE ? "或邀請連結" : "") + "告訴對手，請他們打開這一頁，輸入房號後入座。" +
      (room.n === 3 ? "三人局接一對一" : "只下一對一") + "，" + (room.opts && room.opts.timer ? "每步 " + room.opts.timer + " 秒。" : "不限時。") + "</p></section>";
    h += '<section class="panel"><h2>座位</h2>' +
      (S.user && S.user.setName && !seated() ? '<div class="row"><label class="fld" for="nickIn">暱稱（對手看得到）<input type="text" class="plain" id="nickIn" maxlength="12" autocomplete="off" value="' + esc(S.nick) + '"></label></div>' : "") +
      '<div class="seats">';
    room.seats.forEach(function (id, i) {
      var mine = id && id === S.myId;
      h += '<div class="seat" style="--pc:var(--p' + i + ')"><span class="nm">' + (id ? esc(label(i)) : NAMES[i] + "　空位") + "</span>" +
        (!id ? '<button class="small" type="button" data-sit="' + i + '"' + (S.busy || S.canWrite === false ? " disabled" : "") + ">入座</button>"
          : mine ? '<button class="small ghost" type="button" data-unsit="' + i + '"' + (S.busy ? " disabled" : "") + ">離座</button>" : "") + "</div>";
    });
    h += "</div>";
    h += '<div class="row"><button class="primary" type="button" id="goStart"' + (full && seated() && !S.busy ? "" : " disabled") + ">開始對局</button>" +
      '<span class="note">' + (full ? (seated() ? "人到齊了。" : "你沒有入座，只能觀戰。") : "等所有座位坐滿。同一台裝置可以坐多個位子，方便自己測試。") + "</span></div></section>";
    return h;
  }

  function statusText(g, cur, act) {
    var ui = S.ui;
    if (g.phase === "place") {
      var ts = WG.placeTypes(g);
      if (!act) return "等待 " + label(cur) + " 擺放棋子";
      return label(cur) + "：點一個空格，擺放" + (ts.length === 1 ? TYPE[ts[0]] : "") + "棋子";
    }
    if (!act) return "等待 " + label(cur) + " 下棋";
    if (ui.pend) return label(cur) + "：點虛線，選一邊蓋牆";
    if (ui.brkOpts) return label(cur) + "：點要拆掉的牆";
    if (ui.sel !== undefined && ui.sel !== null) return label(cur) + "：選目的地" + (g.round === 1 && g.brk[cur] ? "（橘點要用掉破牆）" : "");
    return label(cur) + "：選一枚棋子";
  }
  function resultHtml(m) {
    var v = WG.verdict(m), g = m.game, h = '<section class="panel" id="result"><h2>' + (m.stage === "r1" ? "三人局結果" : "一對一結果") + "</h2>";
    h += '<table class="rank"><thead><tr><th>名次</th><th>玩家</th><th>領地</th><th>最大區塊</th></tr></thead><tbody>';
    v.rank.forEach(function (x, i) {
      h += "<tr><td>" + (i + 1) + '</td><td><span class="sw" style="--pc:var(--p' + x.p + ')"></span>' + esc(label(x.p)) + '</td><td class="num">' + x.total + "</td><td>" + x.best + "</td></tr>";
    });
    h += "</tbody></table>";
    if (g.stalemate) h += "<p>沒有人能再移動。混在同一區塊的棋子，各算腳下 1 格。</p>";
    var can = seated() && !S.busy;
    if (v.kind === "tie") h += "<p>前兩名完全同分，交換順序重賽。</p>" + '<div class="row"><button class="primary" type="button" id="goNext"' + (can ? "" : " disabled") + ">重賽</button></div>";
    else if (v.kind === "toDuel") h += "<p>" + esc(label(v.safe)) + " 存活。" + esc(label(v.duel[0])) + " 與 " + esc(label(v.duel[1])) + " 另開一局一對一：" + esc(label(v.duel[0])) + " 改拿紅棋先手，" + esc(label(v.duel[1])) + " 改拿藍棋。</p>" +
      '<div class="row"><button class="primary" type="button" id="goNext"' + (can ? "" : " disabled") + ">開始一對一</button></div>";
    else h += "<p>" + esc(label(v.winner)) + " 存活，" + esc(label(v.out)) + " 淘汰。" + (m.safe !== null && m.safe !== undefined ? esc(seatLabel(m.safe)) + " 已在三人局存活。" : "") + "</p>" +
      '<div class="row"><button class="primary" type="button" id="goAgain"' + (can ? "" : " disabled") + ">再來一局</button></div>";
    return h + "</section>";
  }
  function gameHtml() {
    var m = S.match, g = m.game, cur = WG.current(g), act = canAct(cur), sc = WG.scores(g), h = "";
    // reset the half-made move whenever the position changes underneath us
    var stamp = [S.code, m.stage, m.replays, g.phase, g.moveNo, g.queue.length, cur].join("|");
    if (stamp !== S.stamp) { S.stamp = stamp; S.ui = {}; }
    var ids = g.round === 1 ? [0, 1, 2] : [0, 1];
    h += '<div class="game"><div class="g-top"><div class="scores">';
    ids.forEach(function (p) {
      var inGame = g.order.indexOf(p) >= 0, sub;
      if (!inGame) sub = "已存活";
      else if (g.round === 1) sub = "破牆 " + (g.brk[p] ? "可用" : "已用");
      else sub = g.order[0] === p ? "先手" : "後手";
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
    if (g.phase !== "over") {
      h += '<div class="controls">';
      if (g.phase === "place" && act && WG.placeTypes(g).length > 1)
        h += '<span class="note">要擺的棋子</span>' + seg("segP", [["s", "方形"], ["r", "圓形"]], S.ui.ptype || "s");
      if (g.phase === "play" && act && (S.ui.pend || S.ui.brkOpts)) h += '<button type="button" id="goCancel">重選這一步</button>';
      h += '<span class="grow"></span><button class="small hidden" type="button" id="goForce">對方逾時，代下隨機一手</button></div>';
      h += '<p class="note">' + (g.round === 1 ? "三人局" : "一對一") + (g.round === 2 && m.safe !== null && m.safe !== undefined ? "（" + esc(seatLabel(m.safe)) + " 已存活）" : "") + "　方形直走 1 或 2 格；圓形走 1 格，或走 1 格後轉彎再 1 格。</p>";
    } else h += resultHtml(m);
    return h + "</div></div>";
  }

  function render() {
    var tag = $("tag");
    if (S.kind === "online" && S.code) { tag.innerHTML = "房號 <b>" + esc(S.code) + "</b>"; tag.classList.remove("hidden"); }
    else if (S.kind === "local") { tag.textContent = "同機輪流"; tag.classList.remove("hidden"); }
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
  function doPlace(r, c) {
    var g = S.match.game, ts = WG.placeTypes(g);
    var t = ts.length === 1 ? ts[0] : (S.ui.ptype || "s");
    var m = WG.clone(S.match); m.game = WG.place(g, t, r, c); commit(m);
  }
  function doTurn(mv, d) {
    var m = WG.clone(S.match); m.game = WG.applyTurn(S.match.game, mv, d); commit(m);
  }
  function autoPlay() {
    var g = S.match.game;
    if (g.phase === "place") {
      var free = [];
      for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) if (WG.pieceAt(g, r, c) < 0) free.push([r, c]);
      var f = free[Math.floor(Math.random() * free.length)]; doPlace(f[0], f[1]);
    } else if (g.phase === "play") {
      if (S.ui.pend) { var ws = WG.wallSides(g, S.ui.pend); doTurn(S.ui.pend, ws[Math.floor(Math.random() * ws.length)]); }
      else { var t = WG.randomTurn(g); doTurn(t.mv, t.wall); }
    }
  }
  function tick() {
    var m = S.match, el = $("timer");
    if (!m || !m.game || m.game.phase === "over" || !(m.opts && m.opts.timer) || S.view === "home") return;
    var rem = m.opts.timer - (Date.now() - (m.turnAt || Date.now())) / 1000, cur = WG.current(m.game);
    if (el) { var s = Math.max(0, Math.ceil(rem)); el.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); el.classList.toggle("low", rem <= 15); }
    if (rem <= 0 && canAct(cur)) { toast(label(cur) + " 逾時，隨機下一手。"); autoPlay(); return; }
    var fb = $("goForce");
    if (fb) fb.classList.toggle("hidden", !(S.kind === "online" && rem <= -10 && seated() && !isMine(cur) && !S.busy));
  }
  setInterval(tick, 500);

  view.addEventListener("click", function (e) {
    var t = e.target, el;
    if ((el = t.closest("[data-a]"))) {
      var a = el.getAttribute("data-a"), ui = S.ui;
      if (a === "pc") { S.ui = { sel: +el.getAttribute("data-i"), ptype: ui.ptype }; render(); }
      else if (a === "cell") doPlace(+el.getAttribute("data-r"), +el.getAttribute("data-c"));
      else if (a === "dest") {
        var d = S.dests[+el.getAttribute("data-i")];
        if (d.opts.length === 1) ui.pend = d.opts[0]; else ui.brkOpts = d.opts;
        render();
      }
      else if (a === "brk") { ui.pend = ui.brkOpts[+el.getAttribute("data-i")]; ui.brkOpts = null; render(); }
      else if (a === "wall") { try { doTurn(ui.pend, +el.getAttribute("data-d")); } catch (err) { S.ui = {}; render(); } }
      return;
    }
    if ((el = t.closest(".seg"))) {
      var b = t.closest("button"); if (!b) return;
      var v = b.getAttribute("data-v");
      if (el.id === "segN") S.setup.n = +v; else if (el.id === "segT") S.setup.timer = +v; else if (el.id === "segP") S.ui.ptype = v;
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
      else if (id === "goCancel") { S.ui = { ptype: S.ui.ptype }; render(); }
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
