/// <reference path="../pb_data/types.d.ts" />
// 性能索引（幂等 / 防崩版）。替代旧的 1782300000_add_performance_indexes.js。
//
// 为什么用这个版本：
// 1) 原版用 collection.indexes + app.save() 重建索引，在「索引已存在但迁移未记录为已应用」
//    的库上会因 "index already exists" 报错，导致 PocketBase 启动崩溃。
// 2) SQLite 原生支持 `CREATE INDEX IF NOT EXISTS`，无论索引在不在都不报错（幂等）。
// 3) 每条语句各自 try/catch：即便某条失败（例如 phone 有重复值，唯一索引建不出来），
//    也只跳过该条并打日志，绝不会让服务启动失败。
// 4) 时间戳排在 1782630801_created_* 之后，确保在「集合重建」迁移之后运行，索引不会被冲掉。
//
// 注意：这些是裸 SQL 索引，PocketBase Admin UI 不会在集合 schema 里展示它们。
// 若日后在后台编辑并保存这些集合，需留意索引是否被覆盖（可重新跑本迁移恢复）。
migrate((app) => {
  const statements = [
    // 注册查重 / 登录；唯一索引同时在 DB 层防并发注册产生重复手机号。
    "CREATE UNIQUE INDEX IF NOT EXISTS `idx_players_phone` ON `players` (`phone`)",
    // 排行榜按分排序。
    "CREATE INDEX IF NOT EXISTS `idx_players_totalScore` ON `players` (`totalScore`)",
    // 大厅按玩家拉取结果。
    "CREATE INDEX IF NOT EXISTS `idx_results_player` ON `game_results` (`player`)",
    // 按游戏过滤（Bingo 判分等）。
    "CREATE INDEX IF NOT EXISTS `idx_results_gameKey` ON `game_results` (`gameKey`)",
    // 提交时的重复校验（覆盖索引）。
    "CREATE INDEX IF NOT EXISTS `idx_results_player_game` ON `game_results` (`player`, `gameKey`)"
  ];

  for (let i = 0; i < statements.length; i++) {
    try {
      app.db().newQuery(statements[i]).execute();
    } catch (err) {
      // 单条失败不阻断启动（例如 phone 存在重复值导致唯一索引建失败）。
      console.log("[perf-index] skip:", statements[i], "->", String(err && err.message ? err.message : err));
    }
  }
}, (app) => {
  const drops = [
    "DROP INDEX IF EXISTS `idx_players_phone`",
    "DROP INDEX IF EXISTS `idx_players_totalScore`",
    "DROP INDEX IF EXISTS `idx_results_player`",
    "DROP INDEX IF EXISTS `idx_results_gameKey`",
    "DROP INDEX IF EXISTS `idx_results_player_game`"
  ];
  for (let i = 0; i < drops.length; i++) {
    try { app.db().newQuery(drops[i]).execute(); } catch (err) {}
  }
});
