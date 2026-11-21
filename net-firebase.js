/* Connects the page to a Firebase Realtime Database so friends can play with no account.
   It offers the same small surface the page already uses: doc(path).get/set/onSnapshot/acquire and user.id/profiles. */
(function () {
  "use strict";
  window.WG_STANDALONE = true;
  function off(note) { window.WG_NET_NOTE = note; window.claude = { use: function () { return Promise.resolve(null); } }; }
  var cfg = window.WG_FIREBASE;
  if (!cfg || !cfg.databaseURL) return off("這個網站還沒有設定連線資料庫，暫時只能同機輪流。");
  if (typeof firebase === "undefined") return off("連線元件載入失敗，請檢查網路後重新整理。同機輪流不受影響。");
  var rdb;
  try { firebase.initializeApp(cfg); rdb = firebase.database(); } catch (e) { return off("連線資料庫設定有誤，暫時只能同機輪流。"); }

  // This device's identity: a random id kept in the browser. No account, no personal data.
  var myId = null, myName = "";
  try { myId = localStorage.getItem("wg2-id"); myName = localStorage.getItem("wg2-name") || ""; } catch (e) { /* private mode */ }
  if (!myId) {
    myId = "d" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    try { localStorage.setItem("wg2-id", myId); } catch (e) { /* keep it for this visit only */ }
  }

  function fail(e) { return Promise.reject({ code: e && /permission/i.test(e.code || e.message || "") ? "invalid_argument" : "unavailable", message: String(e && e.message || e) }); }
  function snapOf(id, s) {
    var v = s.val(), data = null;
    if (v && typeof v.json === "string") { try { data = JSON.parse(v.json); } catch (e) { data = null; } }
    return { id: id, exists: !!data, data: function () { return data || undefined; }, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  var db = {
    // Presence comes from the connection itself: the server clears our mark when this page closes or drops off the network.
    presence: function (code, id, tab, cb) {
      var all = rdb.ref("presence/" + code), me = all.child(id).child(tab), conn = rdb.ref(".info/connected");
      var onConn = conn.on("value", function (s) { if (s.val()) me.onDisconnect().remove().then(function () { return me.set(true); }).then(null, function () {}); });
      var onAll = all.on("value", function (s) { var v = s.val() || {}, map = {}; Object.keys(v).forEach(function (k) { map[k] = true; }); cb(map); }, function () {});
      return function () { conn.off("value", onConn); all.off("value", onAll); me.remove().then(null, function () {}); };
    },
    doc: function (path) {
      var seg = path.split("/"), code = seg[1], id = seg[seg.length - 1];
      var ref = rdb.ref("rooms/" + code), lock = rdb.ref("locks/" + code);
      return {
        id: id, path: path,
        get: function () { return ref.once("value").then(function (s) { return snapOf(id, s); }, fail); },
        // The whole room travels as one JSON string, so empty lists and nulls survive the database unchanged.
        set: function (d) { return ref.set({ v: d.v || 0, json: JSON.stringify(d), at: firebase.database.ServerValue.TIMESTAMP }).then(function () {}, fail); },
        onSnapshot: function (next, err) {
          var h = ref.on("value", function (s) { next(snapOf(id, s)); }, function (e) { if (err) err({ code: "unavailable", message: String(e && e.message || e) }); });
          return function () { ref.off("value", h); };
        },
        acquire: function (o) {
          return lock.transaction(function (cur) {
            var now = Date.now();
            if (cur && cur.exp > now && cur.holder !== o.holder) return; // someone else holds it
            return { holder: o.holder, exp: now + (o.ttlMs || 30000) };
          }).then(function (r) { return { acquired: !!r.committed }; }, fail);
        }
      };
    }
  };
  var user = {
    id: function () { return Promise.resolve(myId); },
    can: function () { return Promise.resolve(true); },
    name: function () { return myName; },
    setName: function (n) {
      n = String(n || "").trim().slice(0, 12);
      if (n === myName) return Promise.resolve();
      myName = n;
      try { localStorage.setItem("wg2-name", n); } catch (e) { /* optional */ }
      return rdb.ref("names/" + myId).set(n).then(function () {}, function () {});
    },
    profiles: function (ids) {
      return Promise.all(ids.map(function (i) { return rdb.ref("names/" + i).once("value").then(function (s) { return s.val(); }, function () { return ""; }); }))
        .then(function (vals) { var o = {}; ids.forEach(function (i, k) { o[i] = { name: typeof vals[k] === "string" ? vals[k] : "" }; }); return o; });
    }
  };
  window.claude = { use: function (n) { return Promise.resolve(n === "db" ? db : n === "user" ? user : null); } };
})();
