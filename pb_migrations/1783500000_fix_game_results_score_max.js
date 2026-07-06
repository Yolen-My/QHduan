/// <reference path="../pb_data/types.d.ts" />
// 修复：1783400000_update_game_results_score_max.js 迁移未生效。
//
// 原因：该迁移使用 field.options.max 修改字段上限，但 PocketBase v0.23+
// 字段属性已扁平化，max 直接在 field 对象上（field.max），而非 field.options 下。
// 迁移虽标记为已执行，但实际未修改任何内容。
//
// 本迁移使用 new Field({...}) + addAt() 正确更新字段，与已验证可用的
// 1783311592_updated_games.js 迁移使用相同方式。
migrate((app) => {
  // 1. 修复 game_results: score 和 maxScore 上限 100 → 200
  try {
    const col = app.findCollectionByNameOrId("game_results");
    if (!col) {
      console.log("[fix-score-max] game_results collection not found, skipping");
    } else {
      let changed = false;
      for (let i = 0; i < col.fields.length; i++) {
        const field = col.fields[i];
        if (field.name === "score" && field.max !== 200) {
          col.fields.addAt(i, new Field({
            "help": field.help || "",
            "hidden": field.hidden || false,
            "id": field.id,
            "max": 200,
            "min": field.min !== undefined ? field.min : 0,
            "name": "score",
            "onlyInt": field.onlyInt || false,
            "presentable": field.presentable || false,
            "required": field.required || false,
            "system": false,
            "type": "number"
          }));
          changed = true;
          console.log("[fix-score-max] game_results.score max → 200");
        } else if (field.name === "maxScore" && field.max !== 200) {
          col.fields.addAt(i, new Field({
            "help": field.help || "",
            "hidden": field.hidden || false,
            "id": field.id,
            "max": 200,
            "min": field.min !== undefined ? field.min : 0,
            "name": "maxScore",
            "onlyInt": field.onlyInt || false,
            "presentable": field.presentable || false,
            "required": field.required !== undefined ? field.required : true,
            "system": false,
            "type": "number"
          }));
          changed = true;
          console.log("[fix-score-max] game_results.maxScore max → 200");
        }
      }
      if (changed) {
        app.save(col);
        console.log("[fix-score-max] game_results saved");
      } else {
        console.log("[fix-score-max] game_results already up to date");
      }
    }
  } catch (err) {
    console.log("[fix-score-max] game_results error (non-fatal):", String(err));
  }

  // 2. 修复 players: totalScore 上限 400 → 500
  //    四个游戏满分总和：100(bingo) + 100(quiz) + 100(story) + 200(elimination) = 500
  try {
    const col = app.findCollectionByNameOrId("players");
    if (!col) {
      console.log("[fix-score-max] players collection not found, skipping");
    } else {
      let changed = false;
      for (let i = 0; i < col.fields.length; i++) {
        const field = col.fields[i];
        if (field.name === "totalScore" && field.max !== 500) {
          col.fields.addAt(i, new Field({
            "help": field.help || "",
            "hidden": field.hidden || false,
            "id": field.id,
            "max": 500,
            "min": field.min !== undefined ? field.min : 0,
            "name": "totalScore",
            "onlyInt": field.onlyInt || false,
            "presentable": field.presentable || false,
            "required": field.required || false,
            "system": false,
            "type": "number"
          }));
          changed = true;
          console.log("[fix-score-max] players.totalScore max → 500");
        }
      }
      if (changed) {
        app.save(col);
        console.log("[fix-score-max] players saved");
      } else {
        console.log("[fix-score-max] players already up to date");
      }
    }
  } catch (err) {
    console.log("[fix-score-max] players error (non-fatal):", String(err));
  }
}, (app) => {
  // 回滚：恢复原有上限
  try {
    const col = app.findCollectionByNameOrId("game_results");
    if (col) {
      for (let i = 0; i < col.fields.length; i++) {
        const field = col.fields[i];
        if (field.name === "score" || field.name === "maxScore") {
          col.fields.addAt(i, new Field({
            "help": field.help || "",
            "hidden": field.hidden || false,
            "id": field.id,
            "max": 100,
            "min": field.min !== undefined ? field.min : 0,
            "name": field.name,
            "onlyInt": field.onlyInt || false,
            "presentable": field.presentable || false,
            "required": field.required || false,
            "system": false,
            "type": "number"
          }));
        }
      }
      app.save(col);
    }
  } catch (err) {
    console.log("[fix-score-max] rollback game_results error:", String(err));
  }
  try {
    const col = app.findCollectionByNameOrId("players");
    if (col) {
      for (let i = 0; i < col.fields.length; i++) {
        const field = col.fields[i];
        if (field.name === "totalScore") {
          col.fields.addAt(i, new Field({
            "help": field.help || "",
            "hidden": field.hidden || false,
            "id": field.id,
            "max": 400,
            "min": field.min !== undefined ? field.min : 0,
            "name": "totalScore",
            "onlyInt": field.onlyInt || false,
            "presentable": field.presentable || false,
            "required": field.required || false,
            "system": false,
            "type": "number"
          }));
        }
      }
      app.save(col);
    }
  } catch (err) {
    console.log("[fix-score-max] rollback players error:", String(err));
  }
});
