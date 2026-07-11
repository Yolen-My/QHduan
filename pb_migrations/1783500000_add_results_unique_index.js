/// <reference path="../pb_data/types.d.ts" />

// game_results 并发去重的 DB 级兜底:同一玩家、同一游戏、同一 quiz 分组只能有一条成绩。
// 应用层 submitGameResult 已有 check-then-create 校验,但那是 TOCTOU 竞态(读-判-写非原子),
// 同一玩家毫秒级并发重复提交可能双写导致重复计分。此唯一索引把去重下沉到 SQLite,彻底兜底。
//
// COALESCE(quizSessionIndex, -1):
//  - quiz 有 5 个分组(0~4),各不相同 → 允许一名玩家提交 5 条 quiz 成绩;
//  - 非 quiz(bingo/story/elimination)不带 quizSessionIndex(NULL)→ 归并为 -1,
//    使「同玩家同游戏」唯一,阻止重复提交;不同 gameKey 天然不冲突。
//
// 与既有 safe 迁移一致:try/catch 非致命,幂等(IF NOT EXISTS),
// 单条失败(如历史脏数据已有重复)只记录日志,不阻断 PocketBase 启动。
migrate((app) => {
  try {
    app.db()
      .newQuery("CREATE UNIQUE INDEX IF NOT EXISTS idx_results_unique_player_game_session ON game_results (player, gameKey, COALESCE(quizSessionIndex, -1))")
      .execute();
  } catch (err) {
    console.log("idx_results_unique_player_game_session skipped (可能存在历史重复数据):", err);
  }
}, (app) => {
  try {
    app.db().newQuery("DROP INDEX IF EXISTS idx_results_unique_player_game_session").execute();
  } catch (err) {}
});
