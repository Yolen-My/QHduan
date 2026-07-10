/// <reference path="../pb_data/types.d.ts" />

// 服务端批量 Bingo 判分:单事务完成 pending 判分 + 未提交玩家补空记录 +
// 全员 totalScore/completedGames/finalSubmitted 重算 + 关闭 Bingo。
// 替代旧的浏览器端 triggerBingoScore(~600 次串行 update + 全员广播风暴)。
//
// JSVM 修正说明:goja 执行环境中,routerAdd 回调运行在独立作用域内,
// 模块顶层声明的 function/var 对回调不可见(会报 ReferenceError)。
// 修正:将所有辅助函数内联到各 routerAdd 回调内部。

routerAdd("POST", "/api/bingo-score", function(e) {
  // --- 辅助函数(内联,避免 goja 跨作用域 ReferenceError)---
  function requireAdmin(ev) {
    var expected = $os.getenv("ADMIN_API_TOKEN") || "";
    var token = ev.request.header.get("X-Admin-Token") || "";
    return expected !== "" && token === expected;
  }

  function parseJsonSafe(raw, fallback) {
    try {
      var v = JSON.parse(raw);
      return v === null || v === undefined ? fallback : v;
    } catch (err) {
      return fallback;
    }
  }

  function recordAnswers(r) {
    // r.getString("answers") 对 JSON 字段可能返回 "[object Object]" 或序列化字符串
    // 先尝试 getString,若解析失败则降级到 JSON.stringify(r.get("answers"))
    var raw = r.getString("answers");
    var parsed = parseJsonSafe(raw, null);
    if (parsed === null || typeof parsed !== "object") {
      parsed = parseJsonSafe(JSON.stringify(r.get("answers")), {});
    }
    return parsed || {};
  }

  if (!requireAdmin(e)) {
    e.json(401, { ok: false, error: "unauthorized" });
    return;
  }

  var GAME_ORDER = ["bingo", "quiz", "story", "elimination"];

  // Bingo 题库与目标词(移植 lib/bingo-scoring.ts 的 calculateBingoSelection)
  var questionRecords = e.app.findRecordsByFilter("questions", "gameKey = 'bingo' && isActive = true", "order", 500, 0);
  var questionsById = {};
  var targetWords = [];
  for (var qi = 0; qi < questionRecords.length; qi++) {
    var q = questionRecords[qi];
    var title = q.getString("title");
    var correct = q.getString("correctAnswer");
    var decoded = parseJsonSafe(correct, correct);
    if (typeof decoded === "string") correct = decoded.trim();
    var isCorrect = correct === title;
    questionsById[q.id] = { title: title, isCorrect: isCorrect };
    if (isCorrect) targetWords.push(title);
  }

  function scoreSelection(answers) {
    var ids = Array.isArray(answers.selectedQuestionIds)
      ? answers.selectedQuestionIds.filter(function(x) { return typeof x === "string"; })
      : [];
    var picked = ids.map(function(id) { return questionsById[id]; }).filter(Boolean);
    var selectedWords = picked.length > 0
      ? picked.map(function(q2) { return q2.title; })
      : (Array.isArray(answers.selectedWords)
          ? answers.selectedWords.filter(function(x) { return typeof x === "string"; })
          : []);
    var correctCount;
    if (picked.length > 0) {
      var hit = picked.filter(function(q2) { return q2.isCorrect; }).length;
      correctCount = hit + (picked.length === 9 && hit === picked.length ? 1 : 0);
    } else {
      var hit2 = selectedWords.filter(function(w) { return targetWords.indexOf(w) >= 0; }).length;
      correctCount = hit2 + (selectedWords.length === 9 && hit2 === selectedWords.length ? 1 : 0);
    }
    var score = Math.max(0, Math.min(100, correctCount * 10));
    return { selectedWords: selectedWords, targetWords: targetWords, correctCount: correctCount, score: score };
  }

  var settled = 0;
  var created = 0;

  e.app.runInTransaction(function(tx) {
    var nowIso = new Date().toISOString();
    var resultsCol = tx.findCollectionByNameOrId("game_results");

    // 全表读一次,内存分组(几千行,事务内瞬时完成)
    var allResults = tx.findRecordsByFilter("game_results", "id != ''", "", 100000, 0);
    var byPlayer = {};
    var hasBingo = {};
    for (var ri = 0; ri < allResults.length; ri++) {
      var r = allResults[ri];
      var pid = r.getString("player");
      if (!byPlayer[pid]) byPlayer[pid] = [];
      byPlayer[pid].push(r);
      if (r.getString("gameKey") === "bingo") hasBingo[pid] = true;
    }

    // 1) 判分所有 pending Bingo
    for (var ri2 = 0; ri2 < allResults.length; ri2++) {
      var r2 = allResults[ri2];
      if (r2.getString("gameKey") !== "bingo") continue;
      var answers2 = recordAnswers(r2);
      var pending = r2.getBool("pendingBingoScore") || answers2.pendingBingoScore === true;
      if (!pending) continue;
      var s = scoreSelection(answers2);
      answers2.selectedWords = s.selectedWords;
      answers2.targetWords = s.targetWords;
      answers2.correctCount = s.correctCount;
      answers2.pendingBingoScore = false;
      r2.set("answers", answers2);
      r2.set("score", s.score);
      r2.set("pendingBingoScore", false);
      tx.save(r2);
      settled++;
    }

    // 2) 未提交 Bingo 的玩家补空记录(review 页可显示正确答案)
    var players = tx.findRecordsByFilter("players", "id != ''", "", 100000, 0);
    for (var pi = 0; pi < players.length; pi++) {
      var p = players[pi];
      if (hasBingo[p.id]) continue;
      var s2 = scoreSelection({});
      var rec = new Record(resultsCol);
      rec.set("player", p.id);
      rec.set("gameKey", "bingo");
      rec.set("answers", { selectedWords: s2.selectedWords, targetWords: s2.targetWords, correctCount: s2.correctCount });
      rec.set("score", 0);
      rec.set("maxScore", 100);
      rec.set("completedAt", nowIso);
      rec.set("pendingBingoScore", false);
      tx.save(rec);
      byPlayer[p.id] = byPlayer[p.id] || [];
      byPlayer[p.id].push(rec);
      created++;
    }

    // 3) 重算每个玩家(与 lib/pb-storage.ts getCompletedGamesForPlayer 语义一致)
    for (var pi2 = 0; pi2 < players.length; pi2++) {
      var p2 = players[pi2];
      var list = byPlayer[p2.id] || [];
      var total = 0;
      var completed = {};
      var quizGroups = {};
      for (var li = 0; li < list.length; li++) {
        var lr = list[li];
        var la = recordAnswers(lr);
        var lpending = lr.getBool("pendingBingoScore") || la.pendingBingoScore === true;
        if (lpending) continue;
        total += lr.getFloat("score");
        var lkey = lr.getString("gameKey");
        if (lkey === "quiz") {
          quizGroups[String(lr.getInt("quizSessionIndex"))] = true;
        } else {
          completed[lkey] = true;
        }
      }
      if (Object.keys(quizGroups).length >= 5) completed["quiz"] = true;
      var completedGames = GAME_ORDER.filter(function(k) { return completed[k]; });
      var finalSubmitted = GAME_ORDER.every(function(k) { return completed[k]; });
      p2.set("totalScore", total);
      p2.set("completedGames", completedGames);
      p2.set("finalSubmitted", finalSubmitted);
      if (finalSubmitted && !p2.getString("finalCompletedAt")) p2.set("finalCompletedAt", nowIso);
      tx.save(p2);
    }

    // 4) 判分后关闭 Bingo
    try {
      var bingo = tx.findFirstRecordByFilter("games", "key = 'bingo'");
      if (bingo) {
        bingo.set("isOpen", false);
        bingo.set("bingoScored", true);
        bingo.set("bingoPhase", "closed");
        tx.save(bingo);
      }
    } catch (bingoErr) {
      // games 表记录不存在时跳过
      console.log("[bingo-score] games lookup skipped:", String(bingoErr));
    }
  });

  e.json(200, { ok: true, settled: settled, created: created });
});

// 演示数据重置:替代浏览器端 resetDemoData 的逐条删除循环。
routerAdd("POST", "/api/reset-demo", function(e) {
  function requireAdmin(ev) {
    var expected = $os.getenv("ADMIN_API_TOKEN") || "";
    var token = ev.request.header.get("X-Admin-Token") || "";
    return expected !== "" && token === expected;
  }

  if (!requireAdmin(e)) {
    e.json(401, { ok: false, error: "unauthorized" });
    return;
  }

  e.app.runInTransaction(function(tx) {
    var results = tx.findRecordsByFilter("game_results", "id != ''", "", 100000, 0);
    for (var i = 0; i < results.length; i++) tx.delete(results[i]);
    var players = tx.findRecordsByFilter("players", "id != ''", "", 100000, 0);
    for (var j = 0; j < players.length; j++) tx.delete(players[j]);
    var games = tx.findRecordsByFilter("games", "id != ''", "", 100, 0);
    for (var k = 0; k < games.length; k++) {
      var g = games[k];
      var key = g.getString("key");
      g.set("isOpen", false);
      if (key === "bingo") {
        g.set("bingoScored", false);
        g.set("bingoPhase", "open");
      }
      if (key === "quiz") g.set("quizCurrentGroup", 0);
      if (key === "quiz" || key === "story" || key === "elimination") g.set("quizOpenGroups", []);
      tx.save(g);
    }
  });

  e.json(200, { ok: true });
});
