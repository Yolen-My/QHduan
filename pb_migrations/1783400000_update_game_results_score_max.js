/// <reference path="../pb_data/types.d.ts" />
// 将 game_results 集合的 score 和 maxScore 字段上限从 100 提升到 200，
// 以支持守卫者之夜（elimination）满分 200 的计分规则。
migrate((app) => {
  try {
    const col = app.findCollectionByNameOrId("game_results");
    if (!col) {
      console.log("game_results collection not found, skipping");
      return;
    }

    let changed = false;
    for (const field of col.fields) {
      if (field.name === "score" || field.name === "maxScore") {
        if (field.options && field.options.max !== 200) {
          field.options.max = 200;
          changed = true;
          console.log(`Updated ${field.name} max to 200`);
        }
      }
    }

    if (changed) {
      app.save(col);
      console.log("game_results schema updated successfully");
    } else {
      console.log("game_results schema already up to date");
    }
  } catch (err) {
    console.log("migration error (non-fatal):", err);
  }
}, (app) => {
  // 回滚：将上限恢复为 100
  try {
    const col = app.findCollectionByNameOrId("game_results");
    if (!col) return;
    let changed = false;
    for (const field of col.fields) {
      if (field.name === "score" || field.name === "maxScore") {
        if (field.options) {
          field.options.max = 100;
          changed = true;
        }
      }
    }
    if (changed) app.save(col);
  } catch (err) {
    console.log("rollback error (non-fatal):", err);
  }
});
