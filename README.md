# 牆壁圍棋 II

同好自製的練習用棋盤，與節目製作單位無關。

- `index.html`、`app.js`：畫面與操作
- `engine.js`：規則（走法、蓋牆、破牆、計分）
- `net-firebase.js`：連線對戰，接 Firebase Realtime Database
- `config.js`：Firebase 網頁應用程式設定（公開識別資料，不是密碼）
- `database.rules.json`：要貼到 Firebase 資料庫「規則」分頁的內容

同機輪流不需要任何設定。連線對戰要先在 `config.js` 填入 Firebase 設定。
