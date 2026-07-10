/// <reference path="../pb_data/types.d.ts" />

// quiz 按 (player, gameKey, quizSessionIndex) 查重的覆盖索引
migrate((app) => {
  try {
    app.db()
      .newQuery("CREATE INDEX IF NOT EXISTS idx_results_player_game_session ON game_results (player, gameKey, quizSessionIndex)")
      .execute();
  } catch (err) {
    console.log("idx_results_player_game_session skipped:", err);
  }
}, (app) => {
  try {
    app.db().newQuery("DROP INDEX IF EXISTS idx_results_player_game_session").execute();
  } catch (err) {}
});
