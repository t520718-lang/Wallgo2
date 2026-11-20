/* Wall Go II rules engine. Pure functions over JSON state, shared by the page and the tests. */
(function (root) {
  "use strict";
  var N = 7;
  var DIRS = [[-1, 0], [0, 1], [1, 0], [0, -1]]; // up, right, down, left

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function inside(r, c) { return r >= 0 && r < N && c >= 0 && c < N; }

  // Edge on side d of cell (r,c); null when that side is the board border.
  function edgeKey(r, c, d) {
    if (d === 0) return r > 0 ? "h" + (r - 1) + "_" + c : null;
    if (d === 2) return r < N - 1 ? "h" + r + "_" + c : null;
    if (d === 1) return c < N - 1 ? "v" + r + "_" + c : null;
    return c > 0 ? "v" + r + "_" + (c - 1) : null;
  }
  function pieceAt(s, r, c) {
    for (var i = 0; i < s.pieces.length; i++) if (s.pieces[i].r === r && s.pieces[i].c === c) return i;
    return -1;
  }

  function newGame(round, order, opts) {
    var s = {
      round: round, order: order.slice(), pieces: [], walls: {}, phase: "place",
      queue: [], turn: 0, brk: {}, moveNo: 0, last: null, stalemate: false,
      opts: opts || {}
    };
    var i;
    if (round === 1) {
      for (i = 0; i < order.length; i++) { s.queue.push({ p: order[i], t: null }); s.brk[order[i]] = true; }
      for (i = order.length - 1; i >= 0; i--) s.queue.push({ p: order[i], t: null });
    } else {
      var a = order[0], b = order[1];
      s.pieces.push({ p: a, t: "r", r: 1, c: 1 }, { p: a, t: "r", r: 5, c: 5 },
                    { p: b, t: "r", r: 1, c: 5 }, { p: b, t: "r", r: 5, c: 1 });
      s.queue.push({ p: a, t: "s" }, { p: b, t: "s" }, { p: a, t: "s" }, { p: b, t: "s" });
      s.brk[a] = false; s.brk[b] = false;
    }
    return s;
  }

  // Which piece types the player at the head of the placement queue may put down.
  function placeTypes(s) {
    var q = s.queue[0];
    if (!q) return [];
    if (q.t) return [q.t];
    var has = {};
    s.pieces.forEach(function (x) { if (x.p === q.p) has[x.t] = true; });
    return ["s", "r"].filter(function (t) { return !has[t]; });
  }

  function place(s0, t, r, c) {
    var s = clone(s0), q = s.queue[0];
    if (s.phase !== "place" || !q) throw new Error("not placing");
    if (placeTypes(s).indexOf(t) < 0) throw new Error("bad type");
    if (!inside(r, c) || pieceAt(s, r, c) >= 0) throw new Error("bad cell");
    s.pieces.push({ p: q.p, t: t, r: r, c: c });
    s.queue.shift();
    s.last = { kind: "place", p: q.p, to: [r, c] };
    if (!s.queue.length) { s.phase = "play"; s.turn = 0; settle(s, true); }
    return s;
  }

  // Connected areas bounded by walls and the border.
  function regions(s) {
    var seen = [], out = [], r, c;
    for (r = 0; r < N; r++) seen.push([0, 0, 0, 0, 0, 0, 0]);
    for (r = 0; r < N; r++) for (c = 0; c < N; c++) {
      if (seen[r][c]) continue;
      var cells = [], stack = [[r, c]], owners = {}, pcs = [];
      seen[r][c] = 1;
      while (stack.length) {
        var cur = stack.pop(); cells.push(cur);
        var pi = pieceAt(s, cur[0], cur[1]);
        if (pi >= 0) { owners[s.pieces[pi].p] = true; pcs.push(pi); }
        for (var d = 0; d < 4; d++) {
          var nr = cur[0] + DIRS[d][0], nc = cur[1] + DIRS[d][1];
          if (!inside(nr, nc) || seen[nr][nc]) continue;
          if (s.walls[edgeKey(cur[0], cur[1], d)] !== undefined) continue;
          seen[nr][nc] = 1; stack.push([nr, nc]);
        }
      }
      out.push({ cells: cells, owners: Object.keys(owners).map(Number), pieces: pcs });
    }
    return out;
  }

  function separated(s) {
    return regions(s).every(function (g) { return g.owners.length <= 1; });
  }

  function scores(s) {
    var res = {};
    s.order.forEach(function (p) { res[p] = { total: 0, best: 0 }; });
    regions(s).forEach(function (g) {
      if (g.owners.length === 1) {
        var o = res[g.owners[0]];
        o.total += g.cells.length; o.best = Math.max(o.best, g.cells.length);
      } else if (g.owners.length > 1 && s.phase === "over" && s.stalemate) {
        g.pieces.forEach(function (pi) {
          var o2 = res[s.pieces[pi].p]; o2.total += 1; o2.best = Math.max(o2.best, 1);
        });
      }
    });
    return res;
  }

  // Players best first; tie flags mark equal total and equal largest area.
  function ranking(s) {
    var sc = scores(s);
    var list = s.order.map(function (p, i) { return { p: p, total: sc[p].total, best: sc[p].best, seat: i }; });
    list.sort(function (a, b) { return b.total - a.total || b.best - a.best || a.seat - b.seat; });
    for (var i = 1; i < list.length; i++)
      list[i].tied = list[i].total === list[i - 1].total && list[i].best === list[i - 1].best;
    return list;
  }

  function movesForPiece(s, pi, regs) {
    var pc = s.pieces[pi], out = [];
    var canBreak = s.round === 1 && !!s.brk[pc.p];
    regs = regs || regions(s);
    var mine = null;
    for (var i = 0; i < regs.length && !mine; i++) if (regs[i].pieces.indexOf(pi) >= 0) mine = regs[i];
    // A piece sealed inside its own territory is finished, unless its owner can still break out.
    if (mine && mine.owners.length === 1 && !canBreak) return out;

    function step(r, c, d, broken) {
      var nr = r + DIRS[d][0], nc = c + DIRS[d][1];
      if (!inside(nr, nc) || pieceAt(s, nr, nc) >= 0) return null;
      var k = edgeKey(r, c, d);
      if (s.walls[k] !== undefined) {
        if (!canBreak || broken) return null;
        return { r: nr, c: nc, brk: k };
      }
      return { r: nr, c: nc, brk: broken || null };
    }
    for (var d = 0; d < 4; d++) {
      var a = step(pc.r, pc.c, d, null);
      if (!a) continue;
      out.push({ pi: pi, to: [a.r, a.c], path: [[a.r, a.c]], brk: a.brk });
      var seconds = pc.t === "s" ? [d] : [(d + 1) % 4, (d + 3) % 4];
      for (var j = 0; j < seconds.length; j++) {
        var b = step(a.r, a.c, seconds[j], a.brk);
        if (b) out.push({ pi: pi, to: [b.r, b.c], path: [[a.r, a.c], [b.r, b.c]], brk: b.brk });
      }
    }
    return out;
  }

  function legalMoves(s, p) {
    var out = [], regs = regions(s);
    if (s.phase !== "play") return out;
    s.pieces.forEach(function (pc, pi) { if (pc.p === p) out = out.concat(movesForPiece(s, pi, regs)); });
    return out;
  }

  // Sides of the destination where a wall may go after this move.
  function wallSides(s, mv) {
    var out = [], r = mv.to[0], c = mv.to[1];
    for (var d = 0; d < 4; d++) {
      var k = edgeKey(r, c, d);
      if (k === null) continue;
      if (s.walls[k] !== undefined && k !== mv.brk) continue;
      out.push(d);
    }
    return out;
  }

  // House option: a move that breaks a wall may be set to end without building one.
  function needsWall(s, mv) { return !(mv.brk && s.opts && s.opts.brkNoWall); }

  function current(s) { return s.phase === "place" ? (s.queue[0] ? s.queue[0].p : null) : s.phase === "play" ? s.order[s.turn] : null; }

  // After any change: end the game, or pass the turn to the next player who can move.
  function settle(s, keepTurn) {
    if (separated(s)) { s.phase = "over"; s.stalemate = false; return; }
    var n = s.order.length, start = keepTurn ? s.turn : (s.turn + 1) % n;
    for (var i = 0; i < n; i++) {
      var t = (start + i) % n;
      if (legalMoves(s, s.order[t]).length) { s.turn = t; return; }
    }
    s.phase = "over"; s.stalemate = true;
  }

  function sameMove(a, b) {
    return a.pi === b.pi && a.brk === b.brk && JSON.stringify(a.path) === JSON.stringify(b.path);
  }

  function applyTurn(s0, mv, wallDir) {
    if (s0.phase !== "play") throw new Error("not playing");
    var p = s0.order[s0.turn];
    var legal = legalMoves(s0, p).filter(function (m) { return sameMove(m, mv); })[0];
    if (!legal) throw new Error("illegal move");
    var build = needsWall(s0, legal);
    if (build && wallSides(s0, legal).indexOf(wallDir) < 0) throw new Error("illegal wall");
    var s = clone(s0), pc = s.pieces[legal.pi];
    var from = [pc.r, pc.c];
    if (legal.brk) { delete s.walls[legal.brk]; s.brk[p] = false; }
    pc.r = legal.to[0]; pc.c = legal.to[1];
    var wk = build ? edgeKey(pc.r, pc.c, wallDir) : null;
    if (wk) s.walls[wk] = p;
    s.moveNo++;
    s.last = { kind: "move", p: p, pi: legal.pi, from: from, to: legal.to.slice(), wall: wk, broke: legal.brk };
    settle(s, false);
    return s;
  }

  function randomTurn(s, rnd) {
    rnd = rnd || Math.random;
    var ms = legalMoves(s, s.order[s.turn]);
    var mv = ms[Math.floor(rnd() * ms.length)];
    var ws = wallSides(s, mv);
    return { mv: mv, wall: needsWall(s, mv) ? ws[Math.floor(rnd() * ws.length)] : null };
  }

  /* ---- Match: three-player round, then the one-on-one decider ---- */

  function shuffle(a, rnd) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor((rnd || Math.random)() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  function newMatch(n, opts, rnd) {
    var ids = n === 3 ? [0, 1, 2] : [0, 1];
    var order = n === 3 ? shuffle(ids, rnd) : ids; // a straight one-on-one always starts with red
    return {
      n: n, opts: opts || {}, stage: n === 3 ? "r1" : "r2", replays: 0,
      game: newGame(n === 3 ? 1 : 2, order, opts), safe: null, out: null, winner: null,
      duel: n === 3 ? null : [0, 1] // in a one-on-one, duel[0] plays red and moves first, duel[1] plays blue
    };
  }

  // What the finished game decided: {kind:"tie"} | {kind:"toDuel", safe, duel:[first, second]} | {kind:"done", winner, out}
  function verdict(m) {
    if (m.game.phase !== "over") return null;
    var rk = ranking(m.game);
    if (rk[1].tied) return { kind: "tie", rank: rk };
    if (m.stage === "r1") return { kind: "toDuel", rank: rk, safe: rk[0].p, duel: [rk[1].p, rk[2].p] };
    return { kind: "done", rank: rk, winner: rk[0].p, out: rk[1].p };
  }

  function nextStage(m0) {
    var v = verdict(m0);
    if (!v) throw new Error("game not over");
    var m = clone(m0);
    if (v.kind === "tie") {
      m.replays++;
      if (m.game.round === 1) m.game = newGame(1, m.game.order.slice().reverse(), m.opts);
      else { m.duel.reverse(); m.game = newGame(2, [0, 1], m.opts); } // swap who holds red, red still starts
    } else if (v.kind === "toDuel") {
      m.stage = "r2"; m.safe = v.safe; m.duel = v.duel;
      m.game = newGame(2, [0, 1], m.opts); // a fresh red-versus-blue game; the higher-ranked player takes red
    } else {
      m.stage = "done"; m.winner = m.duel[v.winner]; m.out = m.duel[v.out];
    }
    return m;
  }

  var WG = {
    N: N, DIRS: DIRS, edgeKey: edgeKey, pieceAt: pieceAt, newGame: newGame, placeTypes: placeTypes, place: place,
    regions: regions, separated: separated, scores: scores, ranking: ranking, movesForPiece: movesForPiece,
    legalMoves: legalMoves, wallSides: wallSides, needsWall: needsWall, current: current, applyTurn: applyTurn, randomTurn: randomTurn,
    newMatch: newMatch, verdict: verdict, nextStage: nextStage, clone: clone
  };
  root.WG = WG;
  if (typeof module !== "undefined" && module.exports) module.exports = WG;
})(typeof window !== "undefined" ? window : globalThis);
