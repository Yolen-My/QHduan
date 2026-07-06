/// <reference path="../pb_data/types.d.ts" />
// 防止并发/弱网重试导致的重复提交：
// - bingo/story/elimination：每个玩家每个 gameKey 只允许1条记录。
// - quiz：每个玩家每个 gameKey+quizSessionIndex（sector）只允许1条记录，
//   quiz 本身允许一个玩家有最多5条记录，所以不能跟其它三个游戏用同一条 UNIQUE 约束。
migrate((app) => {
  const statements = [
    "CREATE UNIQUE INDEX IF NOT EXISTS `idx_results_unique_non_quiz` ON `game_results` (`player`, `gameKey`) WHERE `gameKey` != 'quiz'",
    "CREATE UNIQUE INDEX IF NOT EXISTS `idx_results_unique_quiz_sector` ON `game_results` (`player`, `gameKey`, `quizSessionIndex`) WHERE `gameKey` = 'quiz'"
  ];
  for (const stmt of statements) {
    try {
      app.db().newQuery(stmt).execute();
    } catch (err) {
      // 如果已有历史脏数据导致唯一索引建不出来，只跳过打日志，不阻断启动，
      // 但这种情况需要人工去查一遍 game_results 里是否有需要清理的重复记录。
      console.log("[unique-result-index] skip:", stmt, "->", String(err && err.message ? err.message : err));
    }
  }
}, (app) => {
  const drops = [
    "DROP INDEX IF EXISTS `idx_results_unique_non_quiz`",
    "DROP INDEX IF EXISTS `idx_results_unique_quiz_sector`"
  ];
  for (const stmt of drops) {
    try { app.db().newQuery(stmt).execute(); } catch (err) {}
  }
});
