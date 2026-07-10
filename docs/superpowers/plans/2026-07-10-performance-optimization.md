# 年会小游戏性能优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将系统从「客户端全量轮询直连 PocketBase」改造为「实时网关 WS 推送 + Redis 缓存 + 精确查询」,支撑 500~1000 手机端并发。

**Architecture:** 三阶段:①止血(消灭 `loadState()` 全量拉库、Bingo 判分服务端单事务批量);②基建(Redis、realtime-gateway 作为全场唯一 PocketBase 订阅者计算快照并 WS 直推、Next API 个人数据层);③客户端切换(RealtimeProvider 单连接、删除全部轮询与通配订阅、k6 压测)。设计文档:`docs/superpowers/specs/2026-07-10-performance-optimization-design.md`。

**Tech Stack:** Next.js 16 (App Router) / React 19 / PocketBase 0.27 (SQLite + pb_hooks goja JSVM) / Node 24(原生 TS type-stripping,`node x.ts` 直接运行)/ `ws` / `ioredis` / k6。

## Global Constraints

- Node v24.15.0:测试命令形如 `node --test lib/xxx.test.ts`,直接运行 TS;相对导入**必须带 `.ts` 扩展名**(仓库既有风格,见 `lib/scoring.test.ts` 的 `from "./scoring.ts"`)。
- 测试框架:`node:test` + `node:assert/strict`(仓库既有风格,不引入 jest/vitest)。
- 每个任务完成后必须保证 `npm test` 与 `npm run build` 通过再提交。
- 阶段一(Task 1~6)不得依赖 Redis/网关——单独上线即可支撑 500 人。
- PocketBase 是唯一数据源;Redis 只放可重算派生数据;任何代码路径不得因 Redis 不可用而失败(必须有 PB 直查回退)。
- 客户端不再新增任何 `setInterval` 轮询,除非明确标注为"断线降级兜底"。
- 环境变量新增:`REDIS_URL`、`POCKETBASE_SERVER_URL`、`GATEWAY_PORT`、`NEXT_PUBLIC_WS_URL`、`ADMIN_API_TOKEN`(全部写入 `.env.example`)。
- 提交信息格式:`perf(scope): 描述` / `feat(scope): 描述`,git 分支为 `feat/i18n-bilingual`(当前分支,如需新分支由执行者与用户确认)。
- WS 消息协议(全计划统一):
  - client→server: `{"type":"hello","playerId":"<id>"}` (playerId 可为 null)
  - server→client: `{"type":"snapshot","key":"ranking","data":<RankingSnapshot>}`、`{"type":"snapshot","key":"games","data":<GamesSnapshot>}`、`{"type":"event","name":"bingo_scored"}`(广播)、`{"type":"event","name":"result_update","gameKey":"<key>"}`(定向)
- Redis 键(全计划统一):`snap:ranking`、`snap:games`、`snap:fullranking`、`snap:admin`(网关写入,JSON 字符串);`q:<gameKey>:<lang>`(题库缓存,TTL 60s)。

---

## 阶段一:止血(不依赖新进程)

### Task 1: pb-storage 读函数精确化(getGameResult / isGameOpen / getQuizSessionSnapshot)

**Files:**
- Modify: `lib/pb-storage.ts`(函数 `getGameResult` 约 605 行、`isGameOpen` 约 610 行、`getQuizSessionSnapshot` 约 1126 行;并在 `mapPendingBingoScore` 之后新增 `mapResultRecord` 辅助函数)

**Interfaces:**
- Produces: `mapResultRecord(record: any): GameResult`(模块内辅助,后续 Task 2 复用);三个导出函数签名不变。
- Consumes: 既有 `pb`、`mapPendingBingoScore`、`normalizeGameResult`、`normalizeQuizOpenGroups`、`checkPocketBase`。

- [ ] **Step 1: 新增 `mapResultRecord` 并重构 `loadStateFromPB` / `getLobbySnapshot` 中的内联映射**

在 `buildPlayerUpdate` 函数之后加入:

```ts
function mapResultRecord(record: any): GameResult {
  return normalizeGameResult({
    id: record.id,
    player: record.player,
    gameKey: record.gameKey,
    answers: record.answers,
    score: record.score,
    maxScore: record.maxScore,
    completedAt: record.completedAt,
    pendingBingoScore: mapPendingBingoScore(record),
    quizSessionIndex: record.quizSessionIndex,
    sectorKey: record.sectorKey || undefined,
    sectorName: record.sectorName || undefined
  });
}
```

将 `loadStateFromPB` 中的 `gameResults.map(r => ({...})).map(normalizeGameResult)` 与 `getLobbySnapshot` 中的 `playerResults.map((r) => ({...})).map(normalizeGameResult)` 均替换为 `.map(mapResultRecord)`。

- [ ] **Step 2: 重写三个读函数为精确查询**

```ts
export async function getGameResult(playerId: string, gameKey: GameKey): Promise<GameResult | null> {
  const available = await checkPocketBase();
  if (!available) return null;
  try {
    const record = await pb.collection("game_results").getFirstListItem(
      pb.filter("player = {:playerId} && gameKey = {:gameKey}", { playerId, gameKey })
    );
    return mapResultRecord(record);
  } catch {
    return null;
  }
}

export async function isGameOpen(gameKey: GameKey): Promise<boolean> {
  const available = await checkPocketBase();
  if (!available) return false;
  try {
    const record = await pb.collection("games").getFirstListItem(
      pb.filter("key = {:key}", { key: gameKey })
    );
    return Boolean(record.isOpen);
  } catch {
    return false;
  }
}

export async function getQuizSessionSnapshot(playerId: string): Promise<QuizSessionSnapshot> {
  const available = await checkPocketBase();
  if (!available) return { openGroups: [], completedGroups: [], results: [] };
  try {
    const [quizGame, records] = await Promise.all([
      pb.collection("games").getFirstListItem(pb.filter("key = 'quiz'")).catch(() => null),
      pb.collection("game_results").getFullList({
        filter: pb.filter("player = {:playerId} && gameKey = 'quiz'", { playerId })
      })
    ]);
    const results = records.map(mapResultRecord);
    return {
      openGroups: normalizeQuizOpenGroups(quizGame?.quizOpenGroups || []),
      completedGroups: normalizeQuizOpenGroups(results
        .map((result) => result.quizSessionIndex)
        .filter((index): index is number => Number.isInteger(index))),
      results
    };
  } catch {
    return { openGroups: [], completedGroups: [], results: [] };
  }
}
```

注意:三个函数不再调用 `loadState()`。`getGameResult` 语义与旧版一致(quiz 多条时返回任意一条,现有调用方仅用于 bingo/story/elimination 判断存在性)。

- [ ] **Step 3: 验证构建与既有测试**

Run: `npm test && npm run build`
Expected: 全部 PASS,build 成功。

- [ ] **Step 4: Commit**

```bash
git add lib/pb-storage.ts
git commit -m "perf(storage): getGameResult/isGameOpen/getQuizSessionSnapshot 改精确查询,消除全表拉取"
```

---

### Task 2: submitGameResult / persistGameResult 精确化

**Files:**
- Modify: `lib/pb-storage.ts`(`submitGameResult` 约 921 行起、`persistGameResult` 约 1006 行起,整体替换两个函数)

**Interfaces:**
- Produces: `submitGameResult(input): Promise<{ result: GameResult; player: Player; rank: number }>`(签名不变,内部不再 `loadState()`)。
- Consumes: Task 1 的 `mapResultRecord`;既有 `mapGameRecord`、`mapPlayerRecord`、`getCompletedGamesForPlayer`、`calculateBingoSelection`、`getQuestions`、`normalizeQuizOpenGroups`、`getQuizSectorDefaults`、`buildPlayerUpdate`、`createId`、`nowIso`。

- [ ] **Step 1: 整体替换 `submitGameResult` 与 `persistGameResult`**

```ts
export async function submitGameResult(input: {
  playerId: string;
  gameKey: GameKey;
  answers: Record<string, unknown>;
  score: number;
  pendingBingoScore?: boolean;
  quizSessionIndex?: number;
  sectorKey?: string;
  sectorName?: string;
  eliminated?: boolean;
}): Promise<{ result: GameResult; player: Player; rank: number }> {
  const available = await checkPocketBase();
  if (!available) throw new Error("PocketBase 不可用，已禁用本地兜底数据，请稍后重试");

  // 精确读取:目标游戏 1 行 + 玩家 1 行 + 该玩家全部成绩(player 已建索引,≤10 行)
  const [gameRecord, playerRecord, myResultRecords] = await Promise.all([
    pb.collection("games").getFirstListItem(pb.filter("key = {:key}", { key: input.gameKey })).catch(() => null),
    pb.collection("players").getOne(input.playerId).catch(() => null),
    pb.collection("game_results").getFullList({
      filter: pb.filter("player = {:playerId}", { playerId: input.playerId })
    })
  ]);
  if (!playerRecord) throw new Error("未找到当前用户，请重新注册");
  const game = gameRecord ? mapGameRecord(gameRecord) : null;
  const player = mapPlayerRecord(playerRecord);
  const myResults = myResultRecords.map(mapResultRecord);
  const sameGameResults = myResults.filter((r) => r.gameKey === input.gameKey);

  if (input.gameKey === "bingo") {
    const bingoPhase = game?.bingoPhase || "open";
    if (player.completedGames.includes("bingo")) throw new Error("该游戏已完成，不能重复提交");
    const existingBingoResult = sameGameResults[0] || null;
    if (existingBingoResult && !existingBingoResult.pendingBingoScore) throw new Error("该游戏已完成，不能重复提交");
    if (existingBingoResult && existingBingoResult.pendingBingoScore) throw new Error("已提交，等待 Boss 发言完成后判分");
    if (bingoPhase === "closed") throw new Error("Bingo 已结束");
    const isPending = bingoPhase === "open";
    return await persistGameResult(player, myResults, input, isPending);
  }

  if (input.gameKey === "quiz") {
    const quizSessionIndex = Number.isInteger(input.quizSessionIndex) ? input.quizSessionIndex as number : 0;
    if (quizSessionIndex < 0 || quizSessionIndex > 4) throw new Error("Quiz group index must be between 0 and 4");
    const openGroups = normalizeQuizOpenGroups(game?.quizOpenGroups || []);
    if (!game?.isOpen || !openGroups.includes(quizSessionIndex)) throw new Error("该游戏暂未开放");
    if (sameGameResults.some((result) =>
      (Number.isInteger(result.quizSessionIndex) ? result.quizSessionIndex : 0) === quizSessionIndex
    )) {
      throw new Error("该组 Quiz 已完成，不能重复提交");
    }
    const defaults = getQuizSectorDefaults(quizSessionIndex);
    return await persistGameResult(player, myResults, {
      ...input,
      quizSessionIndex,
      sectorKey: input.sectorKey || defaults.sectorKey,
      sectorName: input.sectorName || defaults.sectorName
    }, false);
  }

  if (!game?.isOpen) throw new Error("该游戏暂未开放");
  if (sameGameResults.length > 0) throw new Error("该游戏已完成，不能重复提交");
  return await persistGameResult(player, myResults, input, false);
}

async function persistGameResult(
  player: Player,
  myResults: GameResult[],
  input: {
    playerId: string;
    gameKey: GameKey;
    answers: Record<string, unknown>;
    score: number;
    pendingBingoScore?: boolean;
    quizSessionIndex?: number;
    sectorKey?: string;
    sectorName?: string;
    eliminated?: boolean;
  },
  isPending: boolean
): Promise<{ result: GameResult; player: Player; rank: number }> {
  // Bingo 判分需要题库(精确查询,仅 bingo 题)
  const bingoScore = input.gameKey === "bingo"
    ? calculateBingoSelection(await getQuestions("bingo"), input.answers, input.score)
    : null;
  const maxScore = input.gameKey === "elimination" ? 200 : 100;

  const result: GameResult = {
    id: createId("result"),
    player: input.playerId,
    gameKey: input.gameKey,
    answers: bingoScore
      ? { ...input.answers, selectedWords: bingoScore.selectedWords, targetWords: bingoScore.targetWords, correctCount: bingoScore.correctCount }
      : input.answers,
    score: Math.max(0, Math.min(maxScore, Math.round(bingoScore?.score ?? input.score))),
    maxScore,
    completedAt: nowIso(),
    pendingBingoScore: isPending,
    quizSessionIndex: input.quizSessionIndex,
    sectorKey: input.sectorKey,
    sectorName: input.sectorName
  };

  const created = await pb.collection("game_results").create({
    player: result.player,
    gameKey: result.gameKey,
    answers: result.answers,
    score: result.score,
    maxScore: result.maxScore,
    completedAt: result.completedAt,
    pendingBingoScore: isPending,
    quizSessionIndex: result.quizSessionIndex,
    sectorKey: result.sectorKey,
    sectorName: result.sectorName
  });
  result.id = created.id;

  if (isPending) {
    await saveState(getEmptyRuntimeState());
    return { result, player, rank: 0 };
  }

  // 已判分:基于「我的成绩」重算 player(无需全表)
  const settledResults = [...myResults.filter((r) => !r.pendingBingoScore), result];
  const totalScore = settledResults.reduce((sum, item) => sum + item.score, 0);
  const completedGames = getCompletedGamesForPlayer(player, settledResults, input.gameKey);
  const isEliminatedFinal = input.gameKey === "elimination" && Boolean(input.eliminated);
  const finalSubmitted = isEliminatedFinal || GAME_ORDER.every((key) => completedGames.includes(key));
  const updatedPlayer: Player = {
    ...player,
    totalScore,
    completedGames,
    finalSubmitted,
    finalCompletedAt: finalSubmitted ? (player.finalCompletedAt || nowIso()) : player.finalCompletedAt,
    updated: nowIso()
  };

  await pb.collection("players").update(updatedPlayer.id, buildPlayerUpdate(updatedPlayer));

  // 名次:count 查询(totalScore 已建索引),不再全表排序
  const ahead = await pb.collection("players").getList(1, 1, {
    filter: pb.filter("totalScore > {:score}", { score: totalScore }),
    fields: "id"
  }).catch(() => ({ totalItems: 0 } as { totalItems: number }));

  await saveState(getEmptyRuntimeState());
  return { result, player: updatedPlayer, rank: ahead.totalItems + 1 };
}
```

注意:`persistGameResult` 签名从 `(state, input, isPending)` 改为 `(player, myResults, input, isPending)`,它是模块私有函数,无外部调用方。pending 分支 rank 返回 0(Bingo pending 时前端展示"等待判分",不显示名次,行为与旧版一致——旧版此处返回的是过期 rank)。

- [ ] **Step 2: 验证构建与既有测试**

Run: `npm test && npm run build`
Expected: 全部 PASS(`lib/business.test.ts`、`lib/integration.test.ts` 若直接调用了 `submitGameResult` 的内部行为,按其断言修正 mock/期望——只允许改测试中对"全量 state"入参的构造,不允许放宽业务断言)。

- [ ] **Step 3: 本地冒烟(需本地 PocketBase)**

Run: `./pocketbase serve --http=127.0.0.1:8090 &` 后 `npm run dev`,浏览器注册新用户 → 提交一局 story → 确认成功且 result 页显示分数与名次。
Expected: 提交成功;PocketBase 日志中该次提交只出现 games/players/game_results 的精确查询,无 questions 全表(story 不查题库)。

- [ ] **Step 4: Commit**

```bash
git add lib/pb-storage.ts
git commit -m "perf(storage): submitGameResult 写前校验与重算改精确查询,名次改 count 查询"
```

---

### Task 3: 管理操作精确化 + 健康检查降频

**Files:**
- Modify: `lib/pb-storage.ts`(`toggleGameOpen` 约 615 行、`closeBingoGame` 约 799 行、`advanceQuizGroup` 约 825 行、`openQuizGroup` 约 853 行、`closeQuizGroup` 约 886 行、`HEALTH_CHECK_CACHE_MS` 第 12 行)
- Modify: `lib/storage.ts`(对应包装函数,签名同步为 `Promise<void>`)
- Modify: `hooks/use-game-data.ts`(`useAdminActions` 无需改动,透传即可)
- Modify: `app/admin-control/page.tsx`(如有 `const newState = await toggleGameOpen(...)` 形式的返回值使用,改为 `await toggleGameOpen(...); await refresh();`)

**Interfaces:**
- Produces: 五个管理函数签名统一为 `Promise<void>`;`triggerBingoScore` 本任务不动(Task 5 处理)。
- Consumes: 既有 `pb`、`normalizeQuizOpenGroups`、`getGroupMaxIndex`、`checkPocketBase`、`saveState`、`getEmptyRuntimeState`。

- [ ] **Step 1: 重写五个管理函数(模式统一:查 1 行 → 算 → update 1 行)**

```ts
export async function toggleGameOpen(gameKey: GameKey): Promise<void> {
  const available = await checkPocketBase();
  if (!available) throw new Error("PocketBase 不可用，已禁用本地兜底数据");
  const existing = await pb.collection("games").getFirstListItem(pb.filter("key = {:key}", { key: gameKey }));
  const isOpen = !existing.isOpen;
  const data: Record<string, any> = { isOpen };
  if (gameKey === "bingo" && isOpen) {
    data.bingoScored = false;
    data.bingoPhase = "open";
  }
  await pb.collection("games").update(existing.id, data);
  await saveState(getEmptyRuntimeState());
}

export async function closeBingoGame(): Promise<void> {
  const available = await checkPocketBase();
  if (!available) throw new Error("PocketBase 不可用，已禁用本地兜底数据");
  const bingo = await pb.collection("games").getFirstListItem(pb.filter("key = 'bingo'"));
  await pb.collection("games").update(bingo.id, { isOpen: false, bingoPhase: "closed" });
  await saveState(getEmptyRuntimeState());
}

export async function advanceQuizGroup(): Promise<void> {
  const available = await checkPocketBase();
  if (!available) throw new Error("PocketBase 不可用，已禁用本地兜底数据");
  const quiz = await pb.collection("games").getFirstListItem(pb.filter("key = 'quiz'"));
  const nextGroup = (quiz.quizCurrentGroup || 0) + 1;
  const openedGroup = Math.max(0, Math.min(4, nextGroup - 1));
  const quizOpenGroups = normalizeQuizOpenGroups([...(quiz.quizOpenGroups || []), openedGroup]);
  await pb.collection("games").update(quiz.id, { quizCurrentGroup: nextGroup, quizOpenGroups });
  await saveState(getEmptyRuntimeState());
}

export async function openQuizGroup(groupIndex: number, gameKey: GameKey = "quiz"): Promise<void> {
  const maxGroupIndex = getGroupMaxIndex(gameKey);
  if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > maxGroupIndex) {
    throw new Error(`${gameKey} group index must be between 0 and ${maxGroupIndex}`);
  }
  const available = await checkPocketBase();
  if (!available) throw new Error("PocketBase 不可用，已禁用本地兜底数据");
  const targetGame = await pb.collection("games").getFirstListItem(pb.filter("key = {:key}", { key: gameKey }));
  await pb.collection("games").update(targetGame.id, {
    isOpen: true,
    quizOpenGroups: normalizeQuizOpenGroups([...(targetGame.quizOpenGroups || []), groupIndex])
  });
  await saveState(getEmptyRuntimeState());
}

export async function closeQuizGroup(groupIndex: number, gameKey: GameKey = "quiz"): Promise<void> {
  const maxGroupIndex = getGroupMaxIndex(gameKey);
  if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > maxGroupIndex) {
    throw new Error(`${gameKey} group index must be between 0 and ${maxGroupIndex}`);
  }
  const available = await checkPocketBase();
  if (!available) throw new Error("PocketBase 不可用，已禁用本地兜底数据");
  const targetGame = await pb.collection("games").getFirstListItem(pb.filter("key = {:key}", { key: gameKey }));
  const quizOpenGroups = normalizeQuizOpenGroups(targetGame.quizOpenGroups || []).filter((index) => index !== groupIndex);
  await pb.collection("games").update(targetGame.id, { isOpen: quizOpenGroups.length > 0, quizOpenGroups });
  await saveState(getEmptyRuntimeState());
}
```

- [ ] **Step 2: 健康检查缓存 5s → 30s**

`lib/pb-storage.ts` 第 12 行:

```ts
const HEALTH_CHECK_CACHE_MS = 30000;
```

- [ ] **Step 3: 同步 `lib/storage.ts` 包装函数返回类型**

`lib/storage.ts` 中 `toggleGameOpen`/`closeBingoGame`/`advanceQuizGroup`/`openQuizGroup`/`closeQuizGroup` 的包装(约 400/436/451/468/491 行)返回类型同步改为 `Promise<void>`,函数体 `return await pbStorage.xxx(...)` 保持。

- [ ] **Step 4: 检查 admin-control 页面对返回值的使用**

Run: `grep -n "await toggleGameOpen\|await openQuizGroup\|await closeQuizGroup\|await closeBingoGame\|await advanceQuizGroup" app/admin-control/page.tsx`
若有 `const xxx = await ...` 使用返回值,改为调用后 `await refresh()`(页面已有 `refresh`)。

- [ ] **Step 5: 验证并提交**

Run: `npm test && npm run build`
Expected: PASS。

```bash
git add lib/pb-storage.ts lib/storage.ts app/admin-control/page.tsx
git commit -m "perf(storage): 管理开关操作精确化为单行 update,健康检查降频至 30s"
```

---

### Task 4: pb_hooks 服务端 Bingo 判分 + 重置接口 + quiz 查重索引

**Files:**
- Create: `pb_hooks/admin-actions.pb.js`
- Create: `pb_migrations/1783000000_add_quiz_session_index.js`

**Interfaces:**
- Produces: `POST {PB}/api/bingo-score`(header `X-Admin-Token`)→ `{ ok: true, settled: number, created: number }`;`POST {PB}/api/reset-demo`(同 header)→ `{ ok: true }`。Task 5 的 Next 转发路由消费这两个接口。
- Consumes: PocketBase JSVM API(`routerAdd`、`e.app.runInTransaction`、`findRecordsByFilter`、`new Record(collection)`);环境变量 `ADMIN_API_TOKEN`(通过 systemd/PM2 传给 PocketBase 进程)。

- [ ] **Step 1: 编写 `pb_hooks/admin-actions.pb.js`(完整文件)**

```js
/// <reference path="../pb_data/types.d.ts" />

// 服务端批量 Bingo 判分:单事务完成 pending 判分 + 未提交玩家补空记录 +
// 全员 totalScore/completedGames/finalSubmitted 重算 + 关闭 Bingo。
// 替代旧的浏览器端 triggerBingoScore(~600 次串行 update + 全员广播风暴)。
function requireAdmin(e) {
  const expected = $os.getenv("ADMIN_API_TOKEN") || "";
  const token = e.request.header.get("X-Admin-Token") || "";
  return expected !== "" && token === expected;
}

function parseJsonSafe(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : v;
  } catch (err) {
    return fallback;
  }
}

function recordAnswers(r) {
  return parseJsonSafe(r.getString("answers") || "{}", {});
}

routerAdd("POST", "/api/bingo-score", (e) => {
  if (!requireAdmin(e)) return e.json(401, { ok: false, error: "unauthorized" });

  const GAME_ORDER = ["bingo", "quiz", "story", "elimination"];

  // Bingo 题库与目标词(移植 lib/bingo-scoring.ts 的 calculateBingoSelection)
  const questionRecords = e.app.findRecordsByFilter("questions", "gameKey = 'bingo' && isActive = true", "order", 500, 0);
  const questionsById = {};
  const targetWords = [];
  for (const q of questionRecords) {
    const title = q.getString("title");
    let correct = q.getString("correctAnswer");
    const decoded = parseJsonSafe(correct, correct);
    if (typeof decoded === "string") correct = decoded.trim();
    const isCorrect = correct === title;
    questionsById[q.id] = { title: title, isCorrect: isCorrect };
    if (isCorrect) targetWords.push(title);
  }

  function scoreSelection(answers) {
    const ids = Array.isArray(answers.selectedQuestionIds)
      ? answers.selectedQuestionIds.filter(function (x) { return typeof x === "string"; })
      : [];
    const picked = ids.map(function (id) { return questionsById[id]; }).filter(Boolean);
    const selectedWords = picked.length > 0
      ? picked.map(function (q) { return q.title; })
      : (Array.isArray(answers.selectedWords)
          ? answers.selectedWords.filter(function (x) { return typeof x === "string"; })
          : []);
    let correctCount;
    if (picked.length > 0) {
      const hit = picked.filter(function (q) { return q.isCorrect; }).length;
      correctCount = hit + (picked.length === 9 && hit === picked.length ? 1 : 0);
    } else {
      const hit = selectedWords.filter(function (w) { return targetWords.indexOf(w) >= 0; }).length;
      correctCount = hit + (selectedWords.length === 9 && hit === selectedWords.length ? 1 : 0);
    }
    const score = Math.max(0, Math.min(100, correctCount * 10));
    return { selectedWords: selectedWords, targetWords: targetWords, correctCount: correctCount, score: score };
  }

  let settled = 0;
  let created = 0;

  e.app.runInTransaction((tx) => {
    const nowIso = new Date().toISOString();
    const resultsCol = tx.findCollectionByNameOrId("game_results");

    // 全表读一次,内存分组(几千行,事务内瞬时完成)
    const allResults = tx.findRecordsByFilter("game_results", "id != ''", "", 100000, 0);
    const byPlayer = {};
    const hasBingo = {};
    for (const r of allResults) {
      const pid = r.getString("player");
      if (!byPlayer[pid]) byPlayer[pid] = [];
      byPlayer[pid].push(r);
      if (r.getString("gameKey") === "bingo") hasBingo[pid] = true;
    }

    // 1) 判分所有 pending Bingo
    for (const r of allResults) {
      if (r.getString("gameKey") !== "bingo") continue;
      const answers = recordAnswers(r);
      const pending = r.getBool("pendingBingoScore") || answers.pendingBingoScore === true;
      if (!pending) continue;
      const s = scoreSelection(answers);
      answers.selectedWords = s.selectedWords;
      answers.targetWords = s.targetWords;
      answers.correctCount = s.correctCount;
      answers.pendingBingoScore = false;
      r.set("answers", answers);
      r.set("score", s.score);
      r.set("pendingBingoScore", false);
      tx.save(r);
      settled++;
    }

    // 2) 未提交 Bingo 的玩家补空记录(review 页可显示正确答案)
    const players = tx.findRecordsByFilter("players", "id != ''", "", 100000, 0);
    for (const p of players) {
      if (hasBingo[p.id]) continue;
      const s = scoreSelection({});
      const rec = new Record(resultsCol);
      rec.set("player", p.id);
      rec.set("gameKey", "bingo");
      rec.set("answers", { selectedWords: s.selectedWords, targetWords: s.targetWords, correctCount: s.correctCount });
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
    for (const p of players) {
      const list = byPlayer[p.id] || [];
      let total = 0;
      const completed = {};
      const quizGroups = {};
      for (const r of list) {
        const answers = recordAnswers(r);
        const pending = r.getBool("pendingBingoScore") || answers.pendingBingoScore === true;
        if (pending) continue;
        total += r.getFloat("score");
        const key = r.getString("gameKey");
        if (key === "quiz") {
          quizGroups[String(r.getInt("quizSessionIndex"))] = true;
        } else {
          completed[key] = true;
        }
      }
      if (Object.keys(quizGroups).length >= 5) completed["quiz"] = true;
      const completedGames = GAME_ORDER.filter(function (k) { return completed[k]; });
      const finalSubmitted = GAME_ORDER.every(function (k) { return completed[k]; });
      p.set("totalScore", total);
      p.set("completedGames", completedGames);
      p.set("finalSubmitted", finalSubmitted);
      if (finalSubmitted && !p.getString("finalCompletedAt")) p.set("finalCompletedAt", nowIso);
      tx.save(p);
    }

    // 4) 判分后关闭 Bingo
    const bingo = tx.findFirstRecordByFilter("games", "key = 'bingo'");
    if (bingo) {
      bingo.set("isOpen", false);
      bingo.set("bingoScored", true);
      bingo.set("bingoPhase", "closed");
      tx.save(bingo);
    }
  });

  return e.json(200, { ok: true, settled: settled, created: created });
});

// 演示数据重置:替代浏览器端 resetDemoData 的逐条删除循环。
routerAdd("POST", "/api/reset-demo", (e) => {
  if (!requireAdmin(e)) return e.json(401, { ok: false, error: "unauthorized" });

  e.app.runInTransaction((tx) => {
    const results = tx.findRecordsByFilter("game_results", "id != ''", "", 100000, 0);
    for (const r of results) tx.delete(r);
    const players = tx.findRecordsByFilter("players", "id != ''", "", 100000, 0);
    for (const p of players) tx.delete(p);
    const games = tx.findRecordsByFilter("games", "id != ''", "", 100, 0);
    for (const g of games) {
      const key = g.getString("key");
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

  return e.json(200, { ok: true });
});
```

注意:goja 环境不支持部分 ES2020+ 语法糖,保持 ES5 风格的 function 表达式(与既有 `ranking.pb.js` 一致)。若 `r.getString("answers")` 对 JSON 字段返回空,改用 `JSON.stringify(r.get("answers"))` 再 parse——在 Step 3 冒烟时验证并按实际行为修正 `recordAnswers`。

- [ ] **Step 2: 编写索引迁移 `pb_migrations/1783000000_add_quiz_session_index.js`**

```js
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
```

- [ ] **Step 3: 本地冒烟验证判分接口**

Run:
```bash
ADMIN_API_TOKEN=devtoken ./pocketbase serve --http=127.0.0.1:8090 &
# 造数:注册 2 个用户,一个提交 pending bingo,一个不提交(用现有前端或 scripts/test-trigger-bingo.js 造数)
curl -s -X POST -H "X-Admin-Token: devtoken" http://127.0.0.1:8090/api/bingo-score
```
Expected: 返回 `{"ok":true,"settled":1,"created":1}`;PocketBase Admin UI 中 pending 记录已判分、未提交玩家有 score=0 的空记录、bingo 游戏行 `bingoPhase=closed`;错误 token 返回 401。

- [ ] **Step 4: Commit**

```bash
git add pb_hooks/admin-actions.pb.js pb_migrations/1783000000_add_quiz_session_index.js
git commit -m "feat(pb_hooks): 服务端单事务批量 Bingo 判分与重置接口,新增 quiz 查重索引"
```

---

### Task 5: Next 管理转发路由 + 客户端判分/重置切换 + Bingo 等待降频

**Files:**
- Create: `app/api/admin/bingo-score/route.ts`
- Create: `app/api/admin/reset-demo/route.ts`
- Modify: `lib/pb-storage.ts`(`triggerBingoScore` 约 656 行、`resetDemoData` 约 1260 行)
- Modify: `app/game/bingo/page.tsx`(第 194 行 `window.setInterval(pollBingoResult, 1000)`)
- Modify: `.env.example`(追加 `ADMIN_API_TOKEN`、`POCKETBASE_SERVER_URL`)

**Interfaces:**
- Produces: `POST /api/admin/bingo-score` → `{ ok, settled, created }`;`POST /api/admin/reset-demo` → `{ ok }`。`triggerBingoScore(): Promise<AppState>` 签名不变(admin 页单客户端,内部保留一次 `loadStateFromPB()` 刷新)。
- Consumes: Task 4 的 PB 接口;环境变量 `ADMIN_API_TOKEN`、`POCKETBASE_SERVER_URL`。

- [ ] **Step 1: 编写两个转发路由(完整文件)**

`app/api/admin/bingo-score/route.ts`:

```ts
import { NextResponse } from "next/server";

const PB_URL = process.env.POCKETBASE_SERVER_URL || "http://127.0.0.1:8090";

export async function POST() {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "ADMIN_API_TOKEN 未配置" }, { status: 500 });
  }
  try {
    const res = await fetch(`${PB_URL}/api/bingo-score`, {
      method: "POST",
      headers: { "X-Admin-Token": token },
      cache: "no-store"
    });
    const body = await res.json().catch(() => ({ ok: false, error: "invalid response" }));
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json({ ok: false, error: "PocketBase 不可达" }, { status: 502 });
  }
}
```

`app/api/admin/reset-demo/route.ts`:

```ts
import { NextResponse } from "next/server";

const PB_URL = process.env.POCKETBASE_SERVER_URL || "http://127.0.0.1:8090";

export async function POST() {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "ADMIN_API_TOKEN 未配置" }, { status: 500 });
  }
  try {
    const res = await fetch(`${PB_URL}/api/reset-demo`, {
      method: "POST",
      headers: { "X-Admin-Token": token },
      cache: "no-store"
    });
    const body = await res.json().catch(() => ({ ok: false, error: "invalid response" }));
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json({ ok: false, error: "PocketBase 不可达" }, { status: 502 });
  }
}
```

- [ ] **Step 2: 替换 `triggerBingoScore` 与 `resetDemoData` 客户端实现**

`lib/pb-storage.ts` 中 `triggerBingoScore` 整体替换为:

```ts
export async function triggerBingoScore(): Promise<AppState> {
  const res = await fetch("/api/admin/bingo-score", { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error || "Bingo 判分失败，请重试");
  }
  await saveState(getEmptyRuntimeState());
  // admin 页是单客户端,判分后全量刷新一次用于展示
  return await loadStateFromPB();
}
```

`resetDemoData` 整体替换为:

```ts
export async function resetDemoData(): Promise<void> {
  if (!isBrowser()) return;
  const res = await fetch("/api/admin/reset-demo", { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error || "重置失败，请重试");
  }
  window.localStorage.removeItem("annual_game_demo_state_v3");
  window.localStorage.removeItem(PLAYER_ID_KEY);
  window.localStorage.removeItem(PLAYER_PHONE_KEY);
  window.localStorage.removeItem(PLAYER_CACHE_KEY);
}
```

保留 `export const completeBossAndEnableAutoScore = triggerBingoScore;` 别名。

- [ ] **Step 3: Bingo 等待判分轮询 1s → 5s(阶段三改为推送前的止血)**

`app/game/bingo/page.tsx` 第 194 行:

```ts
const timer = window.setInterval(pollBingoResult, 5000);
```

- [ ] **Step 4: 更新 `.env.example`**

追加:

```env
# 服务端专用(不要加 NEXT_PUBLIC_ 前缀)
POCKETBASE_SERVER_URL=http://127.0.0.1:8090
ADMIN_API_TOKEN=change-me-strong-token
```

- [ ] **Step 5: 验证并提交**

Run: `npm test && npm run build`,再按 Task 4 Step 3 环境从 admin-control 页面点击判分按钮走通全链路。
Expected: 判分秒级完成,页面刷新显示已判分。

```bash
git add app/api/admin lib/pb-storage.ts app/game/bingo/page.tsx .env.example
git commit -m "feat(admin): 判分/重置走 Next 转发路由调用服务端批量接口,Bingo 等待轮询降频 5s"
```

---

### Task 6: 阶段一收尾验证

**Files:**
- Modify: 无(纯验证)

- [ ] **Step 1: 全量回归**

Run: `npm test && npm run build`
Expected: PASS。

- [ ] **Step 2: 手工全流程冒烟(本地 PB + dev server)**

清单:注册 → lobby → 开启 bingo → 提交(pending)→ admin 判分 → review 页看答案 → 开 quiz 组 → 提交 quiz → ranking/screen 页正常刷新。
Expected: 全流程可用;浏览器 Network 面板中不再出现对 4 张表的并发 `getFullList` 组合请求(admin-control 页除外,其仍走 `useAppState`,阶段三处理)。

- [ ] **Step 3: Commit(如冒烟过程中有修正)**

```bash
git add -A && git commit -m "fix(phase1): 阶段一冒烟修正"
```

---

## 阶段二:基建(Redis + realtime-gateway + Next API 层)

### Task 7: 依赖与工程配置

**Files:**
- Modify: `package.json`(dependencies: `ws`、`ioredis`;devDependencies: `@types/ws`;scripts 增加 `"gateway": "node gateway/server.ts"`、`"test:gateway": "node --test gateway/snapshot.test.ts"`)
- Modify: `tsconfig.json`(`exclude` 数组追加 `"gateway"`——gateway 由 Node 直跑、带 `.ts` 扩展名导入,不参与 Next 的类型编译)
- Create: `gateway/tsconfig.json`

- [ ] **Step 1: 安装依赖**

Run: `npm install ws ioredis && npm install -D @types/ws`
Expected: package.json 更新,无 peer 冲突。

- [ ] **Step 2: tsconfig 配置**

根 `tsconfig.json` 的 `exclude` 追加 `"gateway"`。新建 `gateway/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["./**/*.ts", "../lib/ranking.ts", "../types/index.ts"]
}
```

- [ ] **Step 3: package.json scripts**

```json
"gateway": "node gateway/server.ts",
"test:gateway": "node --test gateway/snapshot.test.ts"
```

- [ ] **Step 4: 验证并提交**

Run: `npm run build`
Expected: Next 构建不受 gateway 目录影响,成功。

```bash
git add package.json package-lock.json tsconfig.json gateway/tsconfig.json
git commit -m "chore(gateway): 引入 ws/ioredis 依赖与 gateway 工程配置"
```

---

### Task 8: gateway 快照纯函数(TDD)

**Files:**
- Create: `gateway/snapshot.ts`
- Test: `gateway/snapshot.test.ts`

**Interfaces:**
- Produces:
  - `type RankingSnapshot = { top10: RankingItem[]; officeAverage: OfficeAverageItem[]; officeTop3: OfficeTop3Group[]; participantCount: number; cachedAt: number }`
  - `type GamesSnapshot = { games: Game[]; cachedAt: number }`
  - `type AdminSnapshot = { resultCounts: Record<string, number>; quizSectorCounts: number[]; pendingBingo: number; participantCount: number; cachedAt: number }`
  - `buildRankingSnapshot(players: Player[], now: number): RankingSnapshot`
  - `buildGamesSnapshot(games: Game[], now: number): GamesSnapshot`
  - `buildAdminSnapshot(players: Player[], results: ResultLite[], now: number): AdminSnapshot`,其中 `type ResultLite = { player: string; gameKey: string; pendingBingoScore: boolean; quizSessionIndex?: number }`
  - `buildFullRanking(players: Player[]): RankingItem[]`(供 Redis `snap:fullranking`)
  - `comparablePayload(snap: object): string`(去掉 `cachedAt` 后序列化,用于内容去重)
- Consumes: `../lib/ranking.ts` 的 `buildRanking/getTop10Ranking/getOfficeAverageRanking/getOfficeTop3`;`../types/index.ts` 类型。

- [ ] **Step 1: 写失败测试 `gateway/snapshot.test.ts`(完整文件)**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAdminSnapshot,
  buildFullRanking,
  buildGamesSnapshot,
  buildRankingSnapshot,
  comparablePayload
} from "./snapshot.ts";
import type { Player } from "../types/index.ts";

function makePlayer(id: string, score: number, office = "北京"): Player {
  return {
    id,
    name: `P${id}`,
    phone: `1390000${id}`,
    office,
    team: "Alpha",
    totalScore: score,
    completedGames: [],
    finalSubmitted: false,
    created: `2026-07-10T00:00:0${id}Z`,
    updated: `2026-07-10T00:00:0${id}Z`
  };
}

test("buildRankingSnapshot: top10 按分数降序且含人数", () => {
  const players = [makePlayer("1", 100), makePlayer("2", 300, "上海"), makePlayer("3", 200)];
  const snap = buildRankingSnapshot(players, 1_000);
  assert.equal(snap.participantCount, 3);
  assert.equal(snap.top10[0].playerId, "2");
  assert.equal(snap.top10[1].playerId, "3");
  assert.equal(snap.cachedAt, 1_000);
  assert.equal(snap.officeAverage[0].office, "上海");
});

test("buildFullRanking: 返回全量有序名单", () => {
  const players = [makePlayer("1", 100), makePlayer("2", 300)];
  const full = buildFullRanking(players);
  assert.equal(full.length, 2);
  assert.equal(full[0].rank, 1);
  assert.equal(full[0].playerId, "2");
});

test("comparablePayload: cachedAt 不参与内容比较", () => {
  const players = [makePlayer("1", 100)];
  const a = buildRankingSnapshot(players, 1);
  const b = buildRankingSnapshot(players, 2);
  assert.equal(comparablePayload(a), comparablePayload(b));
  const c = buildRankingSnapshot([makePlayer("1", 999)], 3);
  assert.notEqual(comparablePayload(a), comparablePayload(c));
});

test("buildAdminSnapshot: 统计各游戏完成数/quiz 分组人数/pending 数", () => {
  const players = [makePlayer("1", 0), makePlayer("2", 0)];
  const results = [
    { player: "1", gameKey: "bingo", pendingBingoScore: true },
    { player: "2", gameKey: "bingo", pendingBingoScore: false },
    { player: "1", gameKey: "quiz", pendingBingoScore: false, quizSessionIndex: 0 },
    { player: "2", gameKey: "quiz", pendingBingoScore: false, quizSessionIndex: 0 },
    { player: "1", gameKey: "quiz", pendingBingoScore: false, quizSessionIndex: 2 }
  ];
  const snap = buildAdminSnapshot(players, results, 5);
  assert.equal(snap.resultCounts.bingo, 2);
  assert.equal(snap.resultCounts.quiz, 3);
  assert.equal(snap.pendingBingo, 1);
  assert.deepEqual(snap.quizSectorCounts, [2, 0, 1, 0, 0]);
  assert.equal(snap.participantCount, 2);
});

test("buildGamesSnapshot: 原样携带 games 与时间戳", () => {
  const snap = buildGamesSnapshot([], 7);
  assert.deepEqual(snap.games, []);
  assert.equal(snap.cachedAt, 7);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:gateway`
Expected: FAIL(`Cannot find module './snapshot.ts'`)。

- [ ] **Step 3: 实现 `gateway/snapshot.ts`(完整文件)**

```ts
import { buildRanking, getOfficeAverageRanking, getOfficeTop3, getTop10Ranking } from "../lib/ranking.ts";
import type { Game, OfficeAverageItem, OfficeTop3Group, Player, RankingItem } from "../types/index.ts";

export type RankingSnapshot = {
  top10: RankingItem[];
  officeAverage: OfficeAverageItem[];
  officeTop3: OfficeTop3Group[];
  participantCount: number;
  cachedAt: number;
};

export type GamesSnapshot = { games: Game[]; cachedAt: number };

export type ResultLite = {
  player: string;
  gameKey: string;
  pendingBingoScore: boolean;
  quizSessionIndex?: number;
};

export type AdminSnapshot = {
  resultCounts: Record<string, number>;
  quizSectorCounts: number[];
  pendingBingo: number;
  participantCount: number;
  cachedAt: number;
};

export function buildRankingSnapshot(players: Player[], now: number): RankingSnapshot {
  return {
    top10: getTop10Ranking(players),
    officeAverage: getOfficeAverageRanking(players),
    officeTop3: getOfficeTop3(players),
    participantCount: players.length,
    cachedAt: now
  };
}

export function buildFullRanking(players: Player[]): RankingItem[] {
  return buildRanking(players);
}

export function buildGamesSnapshot(games: Game[], now: number): GamesSnapshot {
  return { games: [...games].sort((a, b) => a.order - b.order), cachedAt: now };
}

export function buildAdminSnapshot(players: Player[], results: ResultLite[], now: number): AdminSnapshot {
  const resultCounts: Record<string, number> = { bingo: 0, quiz: 0, story: 0, elimination: 0 };
  const quizSectorPlayers: Array<Set<string>> = [new Set(), new Set(), new Set(), new Set(), new Set()];
  let pendingBingo = 0;
  for (const r of results) {
    if (resultCounts[r.gameKey] !== undefined) resultCounts[r.gameKey] += 1;
    if (r.gameKey === "bingo" && r.pendingBingoScore) pendingBingo += 1;
    if (r.gameKey === "quiz") {
      const idx = Number.isInteger(r.quizSessionIndex) ? (r.quizSessionIndex as number) : 0;
      if (idx >= 0 && idx <= 4) quizSectorPlayers[idx].add(r.player);
    }
  }
  return {
    resultCounts,
    quizSectorCounts: quizSectorPlayers.map((s) => s.size),
    pendingBingo,
    participantCount: players.length,
    cachedAt: now
  };
}

export function comparablePayload(snap: object): string {
  const { cachedAt: _cachedAt, ...rest } = snap as { cachedAt?: number };
  return JSON.stringify(rest);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run test:gateway`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add gateway/snapshot.ts gateway/snapshot.test.ts
git commit -m "feat(gateway): 快照纯函数与内容去重(TDD)"
```

---

### Task 9: gateway 核心状态机(内存态 + PB 订阅 + 防抖节流 + Redis)

**Files:**
- Create: `gateway/core.ts`

**Interfaces:**
- Produces:
  ```ts
  type GatewayEvents = {
    onSnapshot: (key: "ranking" | "games", data: RankingSnapshot | GamesSnapshot) => void;
    onPersonalResult: (playerId: string, gameKey: string) => void;
    onBingoScored: () => void;
  };
  class GatewayCore {
    constructor(opts: { pbUrl: string; redisUrl: string; events: GatewayEvents });
    start(): Promise<void>;                       // 全量加载 + 订阅(失败则降级 2s 轮询)
    getSnapshot(key: "ranking" | "games"): RankingSnapshot | GamesSnapshot | null;
  }
  ```
- Consumes: Task 8 全部导出;`pocketbase` SDK(Node 24 全局 `EventSource` 可用);`ioredis`。

- [ ] **Step 1: 实现 `gateway/core.ts`(完整文件)**

```ts
import PocketBase from "pocketbase";
import Redis from "ioredis";
import {
  buildAdminSnapshot,
  buildFullRanking,
  buildGamesSnapshot,
  buildRankingSnapshot,
  comparablePayload,
  type GamesSnapshot,
  type RankingSnapshot,
  type ResultLite
} from "./snapshot.ts";
import type { Game, Player } from "../types/index.ts";

const DEBOUNCE_MS = 300;         // 事件合并窗口
const MIN_PUSH_INTERVAL_MS = 1500; // 快照最小推送间隔(带宽预算的核心闸门)
const FALLBACK_POLL_MS = 2000;   // realtime 订阅失败时网关自身的兜底轮询(全场仍只有这一处轮询)

type GatewayEvents = {
  onSnapshot: (key: "ranking" | "games", data: RankingSnapshot | GamesSnapshot) => void;
  onPersonalResult: (playerId: string, gameKey: string) => void;
  onBingoScored: () => void;
};

function mapPlayer(r: any): Player {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone || "",
    office: r.office,
    team: r.team,
    totalScore: r.totalScore || 0,
    completedGames: r.completedGames || [],
    finalSubmitted: Boolean(r.finalSubmitted),
    created: r.created,
    updated: r.updated || r.created,
    finalCompletedAt: r.finalCompletedAt || undefined
  };
}

function mapGame(r: any): Game {
  let bingoPhase = r.bingoPhase;
  if (r.key === "bingo" && !bingoPhase) bingoPhase = r.bingoScored ? "auto_score" : "open";
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    maxScore: r.key === "elimination" ? 200 : r.maxScore,
    isOpen: Boolean(r.isOpen),
    order: r.order,
    bingoScored: Boolean(r.bingoScored),
    bingoPhase,
    quizCurrentGroup: r.quizCurrentGroup || 0,
    quizOpenGroups: Array.isArray(r.quizOpenGroups) ? r.quizOpenGroups : [],
    created: r.created,
    updated: r.updated
  };
}

function mapResult(r: any): ResultLite & { id: string } {
  return {
    id: r.id,
    player: r.player,
    gameKey: r.gameKey,
    pendingBingoScore: typeof r.pendingBingoScore === "boolean"
      ? r.pendingBingoScore
      : Boolean(r.answers?.pendingBingoScore),
    quizSessionIndex: r.quizSessionIndex
  };
}

export class GatewayCore {
  private pb: PocketBase;
  private redis: Redis;
  private events: GatewayEvents;
  private players = new Map<string, Player>();
  private games = new Map<string, Game>();
  private results = new Map<string, ResultLite & { id: string }>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastPushAt = 0;
  private pendingRecompute = false;
  private lastPayload: Record<string, string> = {};
  private snapshots: { ranking: RankingSnapshot | null; games: GamesSnapshot | null } = { ranking: null, games: null };
  private lastBingoScored = false;

  constructor(opts: { pbUrl: string; redisUrl: string; events: GatewayEvents }) {
    this.pb = new PocketBase(opts.pbUrl);
    this.pb.autoCancellation(false);
    this.redis = new Redis(opts.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    this.events = opts.events;
  }

  getSnapshot(key: "ranking" | "games") {
    return this.snapshots[key];
  }

  async start(): Promise<void> {
    try {
      await this.redis.connect();
    } catch (err) {
      console.warn("[gateway] Redis 不可用,以内存模式继续:", (err as Error).message);
    }
    await this.loadAll();
    this.recompute(true);
    const subscribed = await this.subscribe();
    if (!subscribed) {
      console.warn("[gateway] realtime 订阅失败,降级为网关内部轮询", FALLBACK_POLL_MS, "ms");
      setInterval(() => {
        this.loadAll().then(() => this.scheduleRecompute()).catch((e) => console.error("[gateway] poll fail", e));
      }, FALLBACK_POLL_MS);
    }
  }

  private async loadAll(): Promise<void> {
    const [players, games, results] = await Promise.all([
      this.pb.collection("players").getFullList(),
      this.pb.collection("games").getFullList({ sort: "order" }),
      this.pb.collection("game_results").getFullList({ fields: "id,player,gameKey,pendingBingoScore,quizSessionIndex" })
    ]);
    this.players = new Map(players.map((r) => [r.id, mapPlayer(r)]));
    this.games = new Map(games.map((r) => [r.id, mapGame(r)]));
    this.results = new Map(results.map((r) => [r.id, mapResult(r)]));
    this.lastBingoScored = [...this.games.values()].some((g) => g.key === "bingo" && Boolean(g.bingoScored));
  }

  private async subscribe(): Promise<boolean> {
    try {
      await this.pb.collection("players").subscribe("*", (e) => {
        if (e.action === "delete") this.players.delete(e.record.id);
        else this.players.set(e.record.id, mapPlayer(e.record));
        this.scheduleRecompute();
      });
      await this.pb.collection("games").subscribe("*", (e) => {
        if (e.action === "delete") this.games.delete(e.record.id);
        else this.games.set(e.record.id, mapGame(e.record));
        const bingo = [...this.games.values()].find((g) => g.key === "bingo");
        const scoredNow = Boolean(bingo?.bingoScored);
        if (scoredNow && !this.lastBingoScored) this.events.onBingoScored();
        this.lastBingoScored = scoredNow;
        this.scheduleRecompute();
      });
      await this.pb.collection("game_results").subscribe("*", (e) => {
        if (e.action === "delete") {
          this.results.delete(e.record.id);
        } else {
          const mapped = mapResult(e.record);
          this.results.set(e.record.id, mapped);
          this.events.onPersonalResult(mapped.player, mapped.gameKey);
        }
        this.scheduleRecompute();
      });
      return true;
    } catch (err) {
      console.error("[gateway] subscribe error:", err);
      return false;
    }
  }

  private scheduleRecompute(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      const now = Date.now();
      const wait = this.lastPushAt + MIN_PUSH_INTERVAL_MS - now;
      if (wait > 0) {
        if (!this.pendingRecompute) {
          this.pendingRecompute = true;
          setTimeout(() => {
            this.pendingRecompute = false;
            this.recompute(false);
          }, wait);
        }
        return;
      }
      this.recompute(false);
    }, DEBOUNCE_MS);
  }

  private recompute(force: boolean): void {
    const now = Date.now();
    const players = [...this.players.values()];
    const games = [...this.games.values()];
    const results = [...this.results.values()];

    const ranking = buildRankingSnapshot(players, now);
    const gamesSnap = buildGamesSnapshot(games, now);
    const admin = buildAdminSnapshot(players, results, now);
    const full = buildFullRanking(players);

    this.persist("snap:admin", JSON.stringify(admin));
    this.persist("snap:fullranking", JSON.stringify({ items: full, cachedAt: now }));

    for (const [key, snap] of [["ranking", ranking], ["games", gamesSnap]] as const) {
      const payload = comparablePayload(snap);
      if (!force && this.lastPayload[key] === payload) continue; // 内容未变不推送
      this.lastPayload[key] = payload;
      this.snapshots[key] = snap as any;
      this.persist(`snap:${key}`, JSON.stringify(snap));
      this.events.onSnapshot(key, snap);
      this.lastPushAt = now;
    }
  }

  private persist(key: string, value: string): void {
    if (this.redis.status !== "ready") return;
    this.redis.set(key, value).catch((e) => console.warn("[gateway] redis set fail", key, e.message));
  }
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc -p gateway/tsconfig.json`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add gateway/core.ts
git commit -m "feat(gateway): 内存态+唯一订阅+防抖节流+Redis 持久化核心"
```

---

### Task 10: gateway WS 服务入口

**Files:**
- Create: `gateway/server.ts`

**Interfaces:**
- Produces: WS 服务监听 `GATEWAY_PORT`(默认 8100),协议见 Global Constraints;连接建立即下发两份快照。
- Consumes: Task 9 `GatewayCore`;`ws` 包。

- [ ] **Step 1: 实现 `gateway/server.ts`(完整文件)**

```ts
import { WebSocketServer, WebSocket } from "ws";
import { GatewayCore } from "./core.ts";

const PORT = Number(process.env.GATEWAY_PORT || 8100);
const PB_URL = process.env.POCKETBASE_SERVER_URL || "http://127.0.0.1:8090";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const HEARTBEAT_MS = 30000;

type ClientMeta = { playerId: string | null; alive: boolean };
const clients = new Map<WebSocket, ClientMeta>();

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: object): void {
  const data = JSON.stringify(msg);
  for (const ws of clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

const core = new GatewayCore({
  pbUrl: PB_URL,
  redisUrl: REDIS_URL,
  events: {
    onSnapshot: (key, data) => broadcast({ type: "snapshot", key, data }),
    onPersonalResult: (playerId, gameKey) => {
      for (const [ws, meta] of clients) {
        if (meta.playerId === playerId) send(ws, { type: "event", name: "result_update", gameKey });
      }
    },
    onBingoScored: () => broadcast({ type: "event", name: "bingo_scored" })
  }
});

const wss = new WebSocketServer({ port: PORT, perMessageDeflate: true });

wss.on("connection", (ws) => {
  clients.set(ws, { playerId: null, alive: true });

  const ranking = core.getSnapshot("ranking");
  const games = core.getSnapshot("games");
  if (ranking) send(ws, { type: "snapshot", key: "ranking", data: ranking });
  if (games) send(ws, { type: "snapshot", key: "games", data: games });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg?.type === "hello") {
        const meta = clients.get(ws);
        if (meta) meta.playerId = typeof msg.playerId === "string" ? msg.playerId : null;
      }
    } catch {}
  });

  ws.on("pong", () => {
    const meta = clients.get(ws);
    if (meta) meta.alive = true;
  });

  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

setInterval(() => {
  for (const [ws, meta] of clients) {
    if (!meta.alive) {
      ws.terminate();
      clients.delete(ws);
      continue;
    }
    meta.alive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

core.start()
  .then(() => console.log(`[gateway] listening ws://0.0.0.0:${PORT}, pb=${PB_URL}`))
  .catch((err) => {
    console.error("[gateway] start failed:", err);
    process.exit(1);
  });
```

- [ ] **Step 2: 本地联调验证**

Run(三个终端):
```bash
./pocketbase serve --http=127.0.0.1:8090
redis-server --port 6379          # 或 docker run -p 6379:6379 redis:7
npm run gateway
```
第四个终端用 Node 一行客户端验证:
```bash
node -e '
const ws = new (require("ws"))("ws://127.0.0.1:8100");
ws.on("open", () => ws.send(JSON.stringify({type:"hello",playerId:null})));
ws.on("message", (m) => { console.log(String(m).slice(0, 200)); });
setTimeout(() => process.exit(0), 3000);'
```
Expected: 立即收到 `{"type":"snapshot","key":"ranking",...}` 与 `key":"games"` 两条消息;在 PB Admin UI 手改一个玩家分数后 ≤2s 收到新 ranking 快照;`redis-cli get snap:ranking` 有值。

- [ ] **Step 3: Commit**

```bash
git add gateway/server.ts
git commit -m "feat(gateway): WS 服务入口(hello/心跳/快照下发/个人事件)"
```

---

### Task 11: Next 服务端数据层(Redis 客户端 + 4 个 API 路由)

**Files:**
- Create: `lib/server/redis.ts`
- Create: `lib/server/pb.ts`
- Create: `app/api/state/route.ts`
- Create: `app/api/lobby/[playerId]/route.ts`
- Create: `app/api/questions/[gameKey]/route.ts`
- Create: `app/api/admin/stats/route.ts`

**Interfaces:**
- Produces:
  - `GET /api/state?playerId=<id?>` → `{ ranking: RankingSnapshot|null, games: GamesSnapshot|null, context: PlayerContext|null }`(context 仅在传 playerId 时返回,由 `snap:fullranking` 计算,形状与 `lib/ranking.ts getPlayerRankingContext` 返回值一致)
  - `GET /api/lobby/<playerId>` → `{ player, rank, results, quizProgress, games }`(字段语义与 `pb-storage.getLobbySnapshot` 一致,`state` 包装层去掉)
  - `GET /api/questions/<gameKey>?lang=zh|en`(gameKey 可为 `all`)→ `{ questions: Question[] }`
  - `GET /api/admin/stats` → `AdminSnapshot | { ok: false }`
- Consumes: Redis 键 `snap:*`(Task 9 写入);PocketBase REST(回退路径);`lib/ranking.ts`。

- [ ] **Step 1: 实现 `lib/server/redis.ts`**

```ts
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const globalForRedis = globalThis as unknown as { __redis?: Redis };

export function getRedis(): Redis {
  if (!globalForRedis.__redis) {
    globalForRedis.__redis = new Redis(REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false
    });
    globalForRedis.__redis.on("error", (e) => console.warn("[redis]", e.message));
  }
  return globalForRedis.__redis;
}

export async function redisGetJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await getRedis().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // Redis 不可用时上层走 PB 回退
  }
}
```

- [ ] **Step 2: 实现 `lib/server/pb.ts`**

```ts
import PocketBase from "pocketbase";

const PB_URL = process.env.POCKETBASE_SERVER_URL || "http://127.0.0.1:8090";

const globalForPB = globalThis as unknown as { __serverPB?: PocketBase };

export function getServerPB(): PocketBase {
  if (!globalForPB.__serverPB) {
    globalForPB.__serverPB = new PocketBase(PB_URL);
    globalForPB.__serverPB.autoCancellation(false);
  }
  return globalForPB.__serverPB;
}
```

- [ ] **Step 3: 实现 `app/api/state/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { redisGetJson } from "@/lib/server/redis";
import type { RankingItem } from "@/types";

export const dynamic = "force-dynamic";

type FullRanking = { items: RankingItem[]; cachedAt: number };

// 同版本 fullranking 只 JSON.parse 一次(1000 人高频请求下的 CPU 闸门)
let fullCache: { cachedAt: number; items: RankingItem[] } | null = null;

function buildContext(items: RankingItem[], playerId: string) {
  const playerIndex = items.findIndex((item) => item.playerId === playerId);
  const player = items[playerIndex] || null;
  const top10 = items.slice(0, 10);
  const top10Last = top10[9] || null;
  const previousPlayer = playerIndex > 0 ? items[playerIndex - 1] : null;
  return {
    player,
    rank: player?.rank || 0,
    top10,
    distanceToTop10: player && top10Last && player.rank > 10 ? Math.max(0, top10Last.totalScore - player.totalScore + 1) : null,
    previousPlayer,
    distanceToPrevious: player && previousPlayer ? Math.max(0, previousPlayer.totalScore - player.totalScore + 1) : null
  };
}

export async function GET(request: NextRequest) {
  const playerId = request.nextUrl.searchParams.get("playerId");
  const [ranking, games] = await Promise.all([
    redisGetJson<object>("snap:ranking"),
    redisGetJson<object>("snap:games")
  ]);

  let context = null;
  if (playerId) {
    const full = await redisGetJson<FullRanking>("snap:fullranking");
    if (full) {
      if (!fullCache || fullCache.cachedAt !== full.cachedAt) {
        fullCache = { cachedAt: full.cachedAt, items: full.items };
      }
      context = buildContext(fullCache.items, playerId);
    }
  }

  return NextResponse.json({ ranking, games, context });
}
```

(注:`redisGetJson` 每次请求已 parse 一次;`fullCache` 的意义在 Step 3 实现里体现为后续按 `cachedAt` 复用已 parse 的 items——如实现时发现两次 parse 不可避免,可将 `snap:fullranking` 的读取改为 `get` 原始字符串 + 模块级 `{raw, parsed}` 缓存,保持行为一致即可,不改变对外形状。)

- [ ] **Step 4: 实现 `app/api/lobby/[playerId]/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { redisGetJson } from "@/lib/server/redis";
import { getServerPB } from "@/lib/server/pb";
import type { GameResult, RankingItem } from "@/types";

export const dynamic = "force-dynamic";

function normalizeGroups(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 7))].sort((a, b) => a - b);
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ playerId: string }> }) {
  const { playerId } = await params;
  const pb = getServerPB();

  try {
    const [playerRecord, resultRecords, gamesSnap] = await Promise.all([
      pb.collection("players").getOne(playerId),
      pb.collection("game_results").getFullList({
        filter: pb.filter("player = {:playerId}", { playerId }),
        sort: "completedAt"
      }),
      redisGetJson<{ games: unknown[] }>("snap:games")
    ]);

    const games = gamesSnap?.games
      ?? await pb.collection("games").getFullList({ sort: "order" }); // Redis 回退

    const results: GameResult[] = resultRecords.map((r: any) => ({
      id: r.id,
      player: r.player,
      gameKey: r.gameKey,
      answers: r.answers,
      score: r.score,
      maxScore: r.maxScore,
      completedAt: r.completedAt,
      pendingBingoScore: typeof r.pendingBingoScore === "boolean" ? r.pendingBingoScore : Boolean(r.answers?.pendingBingoScore),
      quizSessionIndex: r.quizSessionIndex,
      sectorKey: r.sectorKey || undefined,
      sectorName: r.sectorName || undefined
    }));

    // 名次:优先 Redis 全量榜,回退 count 查询
    let rank = 0;
    const full = await redisGetJson<{ items: RankingItem[] }>("snap:fullranking");
    if (full) {
      rank = full.items.find((item) => item.playerId === playerId)?.rank || 0;
    } else {
      const ahead = await pb.collection("players").getList(1, 1, {
        filter: pb.filter("totalScore > {:score}", { score: playerRecord.totalScore || 0 }),
        fields: "id"
      });
      rank = ahead.totalItems + 1;
    }

    const quizGame: any = (games as any[]).find((g) => g.key === "quiz");
    const openGroups = normalizeGroups(quizGame?.quizOpenGroups);
    const settledQuiz = results.filter((r) => r.gameKey === "quiz" && !r.pendingBingoScore);
    const completedGroups = normalizeGroups(settledQuiz.map((r) => r.quizSessionIndex));
    const completedSet = new Set(completedGroups);

    return NextResponse.json({
      player: {
        id: playerRecord.id,
        name: playerRecord.name,
        phone: playerRecord.phone,
        office: playerRecord.office,
        team: playerRecord.team,
        totalScore: playerRecord.totalScore || 0,
        completedGames: playerRecord.completedGames || [],
        finalSubmitted: Boolean(playerRecord.finalSubmitted),
        created: playerRecord.created,
        updated: playerRecord.updated || playerRecord.created,
        finalCompletedAt: playerRecord.finalCompletedAt || undefined
      },
      rank,
      results,
      quizProgress: {
        completedCount: completedGroups.length,
        totalCount: 5,
        score: settledQuiz.reduce((sum, r) => sum + r.score, 0),
        maxScore: 100,
        openGroups,
        availableGroups: openGroups.filter((g) => !completedSet.has(g)),
        completedGroups
      },
      games
    });
  } catch {
    return NextResponse.json({ player: null, rank: 0, results: [], quizProgress: null, games: [] }, { status: 404 });
  }
}
```

- [ ] **Step 5: 实现 `app/api/questions/[gameKey]/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/server/redis";

export const dynamic = "force-dynamic";

const PB_URL = process.env.POCKETBASE_SERVER_URL || "http://127.0.0.1:8090";
const TTL_SECONDS = 60;
const VALID_KEYS = new Set(["bingo", "quiz", "story", "elimination", "all"]);

export async function GET(request: NextRequest, { params }: { params: Promise<{ gameKey: string }> }) {
  const { gameKey } = await params;
  const lang = request.nextUrl.searchParams.get("lang") === "en" ? "en" : "zh";
  if (!VALID_KEYS.has(gameKey)) {
    return NextResponse.json({ questions: [] }, { status: 400 });
  }

  const cacheKey = `q:${gameKey}:${lang}`;
  try {
    const cached = await getRedis().get(cacheKey);
    if (cached) {
      return new NextResponse(cached, { headers: { "content-type": "application/json" } });
    }
  } catch {}

  const filter = gameKey === "all"
    ? encodeURIComponent("isActive = true")
    : encodeURIComponent(`gameKey = '${gameKey}' && isActive = true`);
  const url = `${PB_URL}/api/collections/questions/records?perPage=500&sort=order&filter=${filter}`;
  const res = await fetch(url, { headers: { ua: lang }, cache: "no-store" });
  if (!res.ok) return NextResponse.json({ questions: [] }, { status: 502 });
  const data = await res.json();
  const body = JSON.stringify({ questions: data.items || [] });

  try {
    await getRedis().set(cacheKey, body, "EX", TTL_SECONDS);
  } catch {}

  return new NextResponse(body, { headers: { "content-type": "application/json" } });
}
```

(`ua` 请求头与 `pb_hooks/questions.pb.js` 的语言协议一致。)

- [ ] **Step 6: 实现 `app/api/admin/stats/route.ts`**

```ts
import { NextResponse } from "next/server";
import { redisGetJson } from "@/lib/server/redis";

export const dynamic = "force-dynamic";

export async function GET() {
  const stats = await redisGetJson<object>("snap:admin");
  if (!stats) return NextResponse.json({ ok: false }, { status: 503 });
  return NextResponse.json(stats);
}
```

- [ ] **Step 7: 验证**

Run: PB + Redis + gateway + `npm run dev` 全开,依次:
```bash
curl -s "http://127.0.0.1:3000/api/state" | head -c 300
curl -s "http://127.0.0.1:3000/api/state?playerId=<某玩家id>" | head -c 300
curl -s "http://127.0.0.1:3000/api/lobby/<某玩家id>" | head -c 300
curl -s "http://127.0.0.1:3000/api/questions/quiz?lang=en" | head -c 300
curl -s "http://127.0.0.1:3000/api/admin/stats"
```
Expected: 均返回 200 与正确 JSON;停掉 Redis 后 `/api/lobby` 仍能返回(走 PB 回退),`/api/state` 的 ranking/games 为 null(客户端此时靠 WS 或降级)。

- [ ] **Step 8: Commit**

```bash
git add lib/server app/api/state app/api/lobby app/api/questions app/api/admin/stats
git commit -m "feat(api): Next 服务端数据层(state/lobby/questions/admin-stats + Redis 回退)"
```

---

### Task 12: 部署编排文档与配置

**Files:**
- Create: `docs/superpowers/deploy/2026-07-10-deploy.md`
- Create: `ecosystem.config.js`(PM2)
- Modify: `.env.example`(补全全部新变量)

- [ ] **Step 1: `ecosystem.config.js`**

```js
module.exports = {
  apps: [
    {
      name: "qhduan-frontend",
      script: "npm",
      args: "start",
      env: { NODE_ENV: "production" }
    },
    {
      name: "realtime-gateway",
      script: "gateway/server.ts",
      interpreter: "node",
      env: {
        GATEWAY_PORT: "8100",
        POCKETBASE_SERVER_URL: "http://127.0.0.1:8090",
        REDIS_URL: "redis://127.0.0.1:6379"
      }
    }
  ]
};
```

- [ ] **Step 2: `.env.example` 最终形态**

```env
NEXT_PUBLIC_POCKETBASE_URL=/pb
NEXT_PUBLIC_APP_NAME=Annual Game
NEXT_PUBLIC_WS_URL=/ws

# 服务端专用
POCKETBASE_SERVER_URL=http://127.0.0.1:8090
REDIS_URL=redis://127.0.0.1:6379
GATEWAY_PORT=8100
ADMIN_API_TOKEN=change-me-strong-token
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me
```

- [ ] **Step 3: 部署文档 `docs/superpowers/deploy/2026-07-10-deploy.md`(完整内容)**

````markdown
# 部署手册(性能优化版)

## 1. Redis
```bash
sudo apt install -y redis-server
sudo sed -i 's/^# bind .*/bind 127.0.0.1/' /etc/redis/redis.conf
sudo systemctl enable --now redis-server
redis-cli ping   # PONG
```

## 2. PocketBase(传入 ADMIN_API_TOKEN)
systemd 单元 `/etc/systemd/system/pocketbase.service` 的 `[Service]` 段加:
```ini
Environment=ADMIN_API_TOKEN=<与 .env 一致的强 token>
```
然后 `sudo systemctl daemon-reload && sudo systemctl restart pocketbase`。

## 3. Nginx(新增 /ws 与 /pb 反代)
在 server 块内追加:
```nginx
# WebSocket 网关
location /ws {
    proxy_pass http://127.0.0.1:8100;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}

# PocketBase(去 /pb 前缀;SSE 需关缓冲)
location /pb/ {
    proxy_pass http://127.0.0.1:8090/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```
`sudo nginx -t && sudo systemctl reload nginx`

## 4. 应用
```bash
npm ci && npm run build
pm2 start ecosystem.config.js
pm2 save
```

## 5. 生产 .env 要点
- `NEXT_PUBLIC_POCKETBASE_URL=/pb`(浏览器经 Nginx 走 PocketBase,不再跨端口直连 :8090)
- `NEXT_PUBLIC_WS_URL=/ws`(客户端自动拼 `wss://<host>/ws`)

## 6. 验证清单
- `redis-cli get snap:ranking` 有值
- `wscat -c wss://<域名>/ws` 收到两条 snapshot
- `curl https://<域名>/pb/api/health` 返回 200
- 手机页面 Network 无到 `:8090` 的直连请求
````

注意:`NEXT_PUBLIC_POCKETBASE_URL=/pb` 为相对路径,`lib/pocketbase.ts` 的 `new PocketBase("/pb")` 在浏览器可用(SDK 支持相对 base);dev 环境保持 `http://localhost:8090` 不变。

- [ ] **Step 4: Commit**

```bash
git add ecosystem.config.js .env.example docs/superpowers/deploy/2026-07-10-deploy.md
git commit -m "chore(deploy): PM2 编排、Nginx /ws 与 /pb 反代、部署手册"
```

---

## 阶段三:客户端切换 + 压测

### Task 13: RealtimeProvider(WS 客户端单连接 + 断线降级)

**Files:**
- Create: `components/RealtimeProvider.tsx`
- Modify: `app/layout.jsx`(用 RealtimeProvider 包裹 children,置于 LanguageProvider 内层)

**Interfaces:**
- Produces:
  ```ts
  type RealtimeContextValue = {
    connected: boolean;
    ranking: RankingSnapshot | null;        // 形状同 Task 8
    games: Game[] | null;
    lastPersonalEventAt: number;            // result_update / bingo_scored 触发时间戳
    subscribePersonal: (cb: (name: string, gameKey?: string) => void) => () => void;
  };
  export function useRealtime(): RealtimeContextValue;
  export default function RealtimeProvider({ children }): JSX.Element;
  ```
- Consumes: WS 协议(Global Constraints);`GET /api/state`(降级轮询);localStorage `PLAYER_ID_KEY`。

- [ ] **Step 1: 实现 `components/RealtimeProvider.tsx`(完整文件)**

```tsx
"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { PLAYER_ID_KEY } from "@/lib/constants";
import type { Game, OfficeAverageItem, OfficeTop3Group, RankingItem } from "@/types";

export type RankingSnapshot = {
  top10: RankingItem[];
  officeAverage: OfficeAverageItem[];
  officeTop3: OfficeTop3Group[];
  participantCount: number;
  cachedAt: number;
};

type PersonalListener = (name: string, gameKey?: string) => void;

type RealtimeContextValue = {
  connected: boolean;
  ranking: RankingSnapshot | null;
  games: Game[] | null;
  lastPersonalEventAt: number;
  subscribePersonal: (cb: PersonalListener) => () => void;
};

const RealtimeContext = createContext<RealtimeContextValue>({
  connected: false,
  ranking: null,
  games: null,
  lastPersonalEventAt: 0,
  subscribePersonal: () => () => {}
});

const FALLBACK_POLL_MS = 10000; // 仅断线时启用的兜底轮询
const MAX_BACKOFF_MS = 30000;

function getWsUrl(): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured && configured.startsWith("ws")) return configured;
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const path = configured || "/ws";
  // dev 环境网关在 8100 端口
  if (window.location.port === "3000") return `${proto}//${window.location.hostname}:8100`;
  return `${proto}//${window.location.host}${path}`;
}

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}

export default function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [ranking, setRanking] = useState<RankingSnapshot | null>(null);
  const [games, setGames] = useState<Game[] | null>(null);
  const [lastPersonalEventAt, setLastPersonalEventAt] = useState(0);
  const listenersRef = useRef(new Set<PersonalListener>());
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(1000);
  const pollTimerRef = useRef<number | null>(null);
  const disposedRef = useRef(false);

  const subscribePersonal = useCallback((cb: PersonalListener) => {
    listenersRef.current.add(cb);
    return () => listenersRef.current.delete(cb);
  }, []);

  const emitPersonal = useCallback((name: string, gameKey?: string) => {
    setLastPersonalEventAt(Date.now());
    listenersRef.current.forEach((cb) => cb(name, gameKey));
  }, []);

  const stopFallbackPoll = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startFallbackPoll = useCallback(() => {
    if (pollTimerRef.current !== null) return;
    const poll = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/state");
        const data = await res.json();
        if (data.ranking) setRanking(data.ranking);
        if (data.games?.games) setGames(data.games.games);
      } catch {}
    };
    poll();
    pollTimerRef.current = window.setInterval(poll, FALLBACK_POLL_MS);
  }, []);

  useEffect(() => {
    disposedRef.current = false;

    const connect = () => {
      if (disposedRef.current) return;
      const url = getWsUrl();
      if (!url) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        stopFallbackPoll();
        backoffRef.current = 1000;
        const playerId = window.localStorage.getItem(PLAYER_ID_KEY);
        ws.send(JSON.stringify({ type: "hello", playerId }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "snapshot" && msg.key === "ranking") setRanking(msg.data);
          else if (msg.type === "snapshot" && msg.key === "games") setGames(msg.data.games);
          else if (msg.type === "event") emitPersonal(msg.name, msg.gameKey);
        } catch {}
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        if (disposedRef.current) return;
        startFallbackPoll();
        const delay = backoffRef.current;
        backoffRef.current = Math.min(MAX_BACKOFF_MS, delay * 2);
        window.setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      disposedRef.current = true;
      stopFallbackPoll();
      wsRef.current?.close();
    };
  }, [emitPersonal, startFallbackPoll, stopFallbackPoll]);

  return (
    <RealtimeContext.Provider value={{ connected, ranking, games, lastPersonalEventAt, subscribePersonal }}>
      {children}
    </RealtimeContext.Provider>
  );
}
```

- [ ] **Step 2: 接入 `app/layout.jsx`**

```jsx
import "./globals.css";
import LanguageProvider from "@/components/LanguageProvider";
import RealtimeProvider from "@/components/RealtimeProvider";

export const metadata = {
  title: "Offsite Games",
  description: "Interactive HSG game flow built with Next.js and React"
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>
        <LanguageProvider>
          <RealtimeProvider>{children}</RealtimeProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: 验证并提交**

Run: PB + Redis + gateway + `npm run dev`,打开 `/screen`,DevTools Network → WS 面板确认单条连接收到 snapshot;`npm run build`。
Expected: 连接建立、快照到达;杀掉 gateway 后 10s 内页面自动走 `/api/state` 轮询,重启 gateway 后自动回连。

```bash
git add components/RealtimeProvider.tsx app/layout.jsx
git commit -m "feat(client): RealtimeProvider 单 WS 连接 + 断线指数退避与降级轮询"
```

---

### Task 14: hooks 重写(消灭轮询与通配订阅)

**Files:**
- Modify: `hooks/use-game-data.ts`(整文件重写)
- Delete: `hooks/use-game-data.optimized.ts`
- Delete: `next.config.optimized.js`

**Interfaces:**
- Produces(供页面消费,注意与旧版的差异点在 Task 15 逐页适配):
  - `useAppState(): { state: { games: Game[]; players: Player[]; gameResults: GameResult[]; questions: Question[] }, refresh: () => Promise<void>, loading: boolean }` — games 来自 WS;players/gameResults 为**当前玩家个人数据**(来自 `/api/lobby`);questions 恒为 `[]`(消费方改用 useQuestions/useAllQuestions)。
  - `useCurrentPlayer(): { player, playerId, refresh, loading }` — 事件驱动 + 30s 兜底。
  - `useRanking(playerId?): { ranking: { players: never[]; games: Game[]; results: never[]; top10; officeAverage; officeTop3; context; participantCount }, refresh, loading }`。
  - `useLobbySnapshot(playerId): { snapshot: { player, rank, results, quizProgress, games } | null, refresh, loading }`。
  - `useGameStatus(gameKey): boolean | null`;`useQuestions(gameKey)`(改走 `/api/questions`);`useAllQuestions(): { questions, loading }`;`useExistingResult(playerId, gameKey): boolean`;`useSubmitGameResult` / `useRegisterPlayer` / `useAdminActions` 透传不变;新增 `useAdminStats(): { stats: AdminSnapshot | null, loading }`(2s 轮询,仅 admin 页使用)。
- Consumes: Task 13 `useRealtime`;`/api/lobby`、`/api/state`、`/api/questions`、`/api/admin/stats`;`lib/storage.ts` 写函数。

- [ ] **Step 1: 重写 `hooks/use-game-data.ts`(完整文件)**

```ts
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime } from "@/components/RealtimeProvider";
import type { AppState, Game, GameKey, GameResult, Player, Question, QuizProgress } from "@/types";
import {
  getCurrentPlayerId,
  registerPlayer,
  submitGameResult,
  toggleGameOpen,
  triggerBingoScore,
  closeBingoGame,
  advanceQuizGroup,
  openQuizGroup,
  closeQuizGroup
} from "@/lib/storage";
import { getStoredLocale } from "@/lib/i18n";

const PERSONAL_FALLBACK_MS = 30000; // 个人数据兜底刷新(事件驱动为主)
const EVENT_JITTER_MS = 3000;       // 收到事件后错峰拉取,削平判分尖峰

type LobbyData = {
  player: Player | null;
  rank: number;
  results: GameResult[];
  quizProgress: QuizProgress | null;
  games: Game[];
};

async function fetchLobby(playerId: string): Promise<LobbyData | null> {
  try {
    const res = await fetch(`/api/lobby/${playerId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// 个人数据共享缓存:同页多个 hook 复用一次请求
let lobbyCache: { playerId: string; at: number; data: LobbyData | null; inflight: Promise<LobbyData | null> | null } =
  { playerId: "", at: 0, data: null, inflight: null };

async function getLobbyShared(playerId: string, maxAgeMs: number): Promise<LobbyData | null> {
  const now = Date.now();
  if (lobbyCache.playerId === playerId && now - lobbyCache.at < maxAgeMs && lobbyCache.data) return lobbyCache.data;
  if (lobbyCache.playerId === playerId && lobbyCache.inflight) return lobbyCache.inflight;
  const inflight = fetchLobby(playerId).then((data) => {
    lobbyCache = { playerId, at: Date.now(), data, inflight: null };
    return data;
  });
  lobbyCache = { ...lobbyCache, playerId, inflight };
  return inflight;
}

function usePersonalData(playerId: string | null | undefined) {
  const { subscribePersonal, connected } = useRealtime();
  const [data, setData] = useState<LobbyData | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (maxAgeMs = 0) => {
    if (!playerId) {
      setData(null);
      setLoading(false);
      return;
    }
    const d = await getLobbyShared(playerId, maxAgeMs);
    setData(d);
    setLoading(false);
  }, [playerId]);

  useEffect(() => {
    refresh(1000);
    // 个人事件 → 错峰刷新
    const unsub = subscribePersonal(() => {
      window.setTimeout(() => refresh(0), Math.random() * EVENT_JITTER_MS);
    });
    // 低频兜底(断线/漏事件保护)
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      refresh(5000);
    }, PERSONAL_FALLBACK_MS);
    return () => {
      unsub();
      window.clearInterval(timer);
    };
  }, [refresh, subscribePersonal, connected]);

  return { data, refresh, loading };
}

export function useCurrentPlayer() {
  const [playerId, setPlayerId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    getCurrentPlayerId().then(setPlayerId);
  }, []);
  const { data, refresh, loading } = usePersonalData(playerId);
  return { player: data?.player ?? null, playerId, refresh, loading: playerId === undefined || loading };
}

export function useLobbySnapshot(playerId: string | null | undefined) {
  const { data, refresh, loading } = usePersonalData(playerId);
  const snapshot = useMemo(() => (data ? {
    player: data.player,
    rank: data.rank,
    results: data.results,
    quizProgress: data.quizProgress,
    games: data.games,
    state: { players: data.player ? [data.player] : [], gameResults: data.results, games: data.games, questions: [] as Question[] }
  } : null), [data]);
  return { snapshot, refresh, loading };
}

export function useAppState() {
  const { games } = useRealtime();
  const [playerId, setPlayerId] = useState<string | null>(null);
  useEffect(() => {
    getCurrentPlayerId().then((id) => setPlayerId(id));
  }, []);
  const { data, refresh, loading } = usePersonalData(playerId);
  const state: AppState = useMemo(() => ({
    games: games ?? data?.games ?? [],
    players: data?.player ? [data.player] : [],
    gameResults: data?.results ?? [],
    questions: []
  }), [games, data]);
  return { state, refresh: () => refresh(0), loading: loading && !games };
}

export function useGameStatus(gameKey: GameKey) {
  const { games } = useRealtime();
  if (!games) return null;
  return Boolean(games.find((game) => game.key === gameKey)?.isOpen);
}

export function useExistingResult(playerId: string | null | undefined, gameKey: GameKey) {
  const { data } = usePersonalData(playerId);
  return Boolean(data?.results.some((r) => r.gameKey === gameKey && !r.pendingBingoScore));
}

export type QuestionsState = Question[] & {
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

async function fetchQuestions(gameKey: string): Promise<Question[]> {
  const lang = getStoredLocale();
  const res = await fetch(`/api/questions/${gameKey}?lang=${lang}`);
  if (!res.ok) throw new Error(`题库加载失败(${res.status})`);
  const data = await res.json();
  return data.questions || [];
}

export function useQuestions(gameKey: GameKey): QuestionsState {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const attemptRef = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const q = await fetchQuestions(gameKey);
      if (q.length === 0) throw new Error(`${gameKey} 题库为空`);
      setQuestions(q);
      setError(null);
      attemptRef.current = 0;
    } catch (err) {
      setQuestions([]);
      setError(err instanceof Error ? err.message : "题库加载失败");
      // 指数退避重试:1.2s, 2.4s, 4.8s ... 封顶 30s
      const delay = Math.min(30000, 1200 * 2 ** attemptRef.current);
      attemptRef.current += 1;
      window.setTimeout(() => refresh(), delay);
    } finally {
      setLoading(false);
    }
  }, [gameKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.addEventListener("annual-game-locale-change", refresh);
    return () => window.removeEventListener("annual-game-locale-change", refresh);
  }, [refresh]);

  return Object.assign([...questions], { loading, error, refresh });
}

export function useAllQuestions() {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetchQuestions("all")
      .then(setQuestions)
      .catch(() => setQuestions([]))
      .finally(() => setLoading(false));
  }, []);
  return { questions, loading };
}

export function useRanking(playerId?: string | null) {
  const { ranking } = useRealtime();
  const [context, setContext] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const cachedAtRef = useRef(0);

  // 排行快照更新 → 错峰刷新个人 context(仅传了 playerId 的页面)
  useEffect(() => {
    if (!ranking) return;
    setLoading(false);
    if (!playerId) return;
    if (ranking.cachedAt === cachedAtRef.current) return;
    cachedAtRef.current = ranking.cachedAt;
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/state?playerId=${playerId}`);
        const data = await res.json();
        setContext(data.context);
      } catch {}
    }, Math.random() * 2000);
    return () => window.clearTimeout(timer);
  }, [ranking, playerId]);

  const { games } = useRealtime();
  const value = useMemo(() => ({
    players: [] as Player[],
    games: games ?? [],
    results: [] as GameResult[],
    top10: ranking?.top10 ?? [],
    officeAverage: ranking?.officeAverage ?? [],
    officeTop3: ranking?.officeTop3 ?? [],
    participantCount: ranking?.participantCount ?? 0,
    context
  }), [ranking, games, context]);

  return { ranking: value, refresh: async () => {}, loading };
}

export type AdminStats = {
  resultCounts: Record<string, number>;
  quizSectorCounts: number[];
  pendingBingo: number;
  participantCount: number;
  cachedAt: number;
};

export function useAdminStats() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/admin/stats");
        if (res.ok && !disposed) setStats(await res.json());
      } catch {} finally {
        if (!disposed) setLoading(false);
      }
    };
    poll();
    const timer = window.setInterval(poll, 2000); // 后台单客户端,轮询成本可忽略
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);
  return { stats, loading };
}

export function useRegisterPlayer() {
  return registerPlayer;
}

export function useSubmitGameResult() {
  return submitGameResult;
}

export function useAdminActions() {
  return { toggleGameOpen, triggerBingoScore, closeBingoGame, advanceQuizGroup, openQuizGroup, closeQuizGroup };
}
```

- [ ] **Step 2: 删除双轨文件**

Run: `git rm hooks/use-game-data.optimized.ts next.config.optimized.js`

- [ ] **Step 3: 构建定位破坏点**

Run: `npm run build`
Expected: 此时**预期会有类型错误**——来自 Task 15 要适配的页面(screen 的 `players.length`、result/ranking 的 `ranking.players`、admin 的 `state.questions` 等)。记录错误清单,交给 Task 15 逐一修复;本任务先不提交 build 失败的状态,**Task 14 与 Task 15 在同一次提交完成**(见 Task 15 Step 6)。

---

### Task 15: 页面适配(与 Task 14 同一提交)

**Files:**
- Modify: `app/screen/page.tsx`(第 12、45 行)
- Modify: `app/ranking/page.tsx`(第 15、18 行)
- Modify: `app/result/page.tsx`(第 19、25、27、28 行)
- Modify: `app/game/bingo/page.tsx`(第 136~137、143~145、182~199、279~281 行)
- Modify: `app/game/quiz/QuizClient.tsx`(第 104、125、129 行——机械替换,见映射表)
- Modify: `app/game/elimination/EliminationClient.tsx`(第 110~111、132 行)
- Modify: `app/game/story/StoryClient.tsx`(第 110~111、132 行)
- Modify: `app/game/review/page.tsx`(第 192、206~231 行)
- Modify: `app/admin-control/page.tsx`(第 31、41~121 行区域)
- Modify: `app/lobby/page.tsx`(`snapshot.state.games` → `snapshot.games`,以 grep 结果为准)

**字段映射表(旧 → 新):**

| 旧用法 | 新用法 |
|---|---|
| `ranking.players.length`(screen 参与人数) | `ranking.participantCount` |
| `ranking.players.find((i) => i.id === playerId)` | `ranking.context?.player`(RankingItem,字段名 `playerId`/`totalScore`/`name`) |
| `ranking.players.some(...)`(ranking 页存在检查) | `Boolean(ranking.context?.player)` |
| `ranking.results.filter(...)`(result 页兜底) | `snapshot?.results ?? []`(lobby 快照为唯一来源) |
| `getPlayerRank(state.players, id)`(bingo 弹窗名次) | `snapshot.rank`(useLobbySnapshot)或提交返回值 `rank` |
| `state.players.find((p) => p.id === playerId)` | `player`(useCurrentPlayer 已返回) |
| `state.gameResults.filter/find(本人)` | `useAppState` 新语义下不变(gameResults 即本人成绩) |
| `state.games.find(...)` | 不变(games 来自 WS 快照) |
| `state.questions`(review/admin) | `useAllQuestions().questions` |
| `useRanking(playerId, 1500/4000)` | `useRanking(playerId)`(无轮询参数) |
| `useAppState(2000/4000)` | `useAppState()` |

- [ ] **Step 1: screen / ranking / result 三页按映射表修改**

`app/screen/page.tsx` 第 45 行:

```tsx
<strong>{loading || !ranking ? "—" : ranking.participantCount || 0}</strong>
```

`app/ranking/page.tsx` 第 15、18 行:

```tsx
const { ranking } = useRanking(playerId);
const context = ranking.context;
const player = context?.player || null;
```

`app/result/page.tsx` 第 19、25、27、28 行:

```tsx
const { ranking, loading: rankingLoading } = useRanking(playerId);
// ...
const rankedPlayer = ranking.context?.player || null;
const currentRank = ranking.context?.rank || 0;
const playerResults = snapshot?.results || [];
```

(`rankedPlayer` 后续若引用 `.id`/`.totalScore`,`RankingItem` 对应字段为 `.playerId`/`.totalScore`,同步替换。)

- [ ] **Step 2: Bingo 页——等待判分改为事件驱动**

`app/game/bingo/page.tsx`:
1. 第 136~137 行 `state.players.find(...)` → 直接用 `player`(useCurrentPlayer 返回值)。
2. 第 143~145 行 `state.gameResults.find(...)` 保持(新 useAppState 的 gameResults 即本人成绩)。
3. 第 182~199 行等待判分的 `setInterval(pollBingoResult, 5000)` 整体替换为事件驱动 + 兜底:

```tsx
const { subscribePersonal } = useRealtime();

useEffect(() => {
  if (!isWaitingForScore || !playerId) return;
  let disposed = false;
  const check = async () => {
    const result = await getGameResult(playerId as string, "bingo");
    if (!disposed && result && !result.pendingBingoScore) {
      setIsWaitingForScore(false);
      setScoredResult(result);
    }
  };
  // bingo_scored 广播 → 0~3s 错峰确认;30s 轮询兜底
  const unsub = subscribePersonal((name) => {
    if (name === "bingo_scored" || name === "result_update") {
      window.setTimeout(check, Math.random() * 3000);
    }
  });
  const timer = window.setInterval(check, 30000);
  check();
  return () => {
    disposed = true;
    unsub();
    window.clearInterval(timer);
  };
}, [isWaitingForScore, playerId, subscribePersonal]);
```

(局部变量名 `isWaitingForScore`/`setScoredResult` 以文件实际命名为准,保持原状态机不变,只替换定时器来源;顶部补 `import { useRealtime } from "@/components/RealtimeProvider";`。)
4. 第 279~281 行 `getPlayerRank(state.players, currentPlayer.id)` → 使用提交返回的 `rank` 或 `useLobbySnapshot(playerId).snapshot?.rank ?? 0`,并删除 `getPlayerRank`/`state.players` 相关 import。

- [ ] **Step 3: quiz / elimination / story 客户端**

三个文件的修改模式相同:
- `useAppState()` 调用保持(新语义兼容:`state.games` 来自 WS,`state.gameResults` 为本人成绩,QuizClient 第 129 行的 `filter(player === playerId)` 结果不变)。
- elimination/story 第 164、256/265 行 `ranking.context?.rank ?? 0` 保持不变(新 useRanking 提供 context)。
- 删除向 `useRanking` 传的 interval 参数(如有)。

- [ ] **Step 4: review 页与 admin 页**

`app/game/review/page.tsx`:第 192 行 `useAppState(4000)` → `useAppState()`;第 225 行 `state.questions.filter(...)` → 顶部加 `const { questions: allQuestions } = useAllQuestions();`,替换为 `allQuestions.filter((q) => q.gameKey === key && q.isActive)`;第 206~231 行其余 `state.gameResults` 用法保持(本人成绩语义不变)。

`app/admin-control/page.tsx`:
- 第 31 行 `useAppState(2000)` → `useAppState()` + 新增 `const { stats } = useAdminStats();` + `const { questions: allQuestions } = useAllQuestions();`
- 第 41~46 行 completion 计算改为:

```tsx
const completion = useMemo(() => {
  return GAME_ORDER.map((key) => ({
    key,
    count: stats?.resultCounts?.[key] ?? 0
  }));
}, [stats]);
```

- 第 51 行 pendingBingoCount → `stats?.pendingBingo ?? 0`
- 第 60~91 行 quizSectors 中 `state.questions` → `allQuestions`,`completedPlayers.size` → `stats?.quizSectorCounts?.[index] ?? 0`
- 第 93 行以下 elimination/story 的 `completedPlayers` 同理改用 `stats?.resultCounts?.elimination ?? 0` / `stats?.resultCounts?.story ?? 0`
- 参与人数展示(如有 `state.players.length`)→ `stats?.participantCount ?? 0`

- [ ] **Step 5: lobby 页**

Run: `grep -n "snapshot\." app/lobby/page.tsx`
按映射表将 `snapshot.state.games` → `snapshot.games`、`snapshot.state.players` → `snapshot.player ? [snapshot.player] : []`,其余 `snapshot.player/rank/results/quizProgress` 字段不变。

- [ ] **Step 6: 删除 pb-storage 中的废弃订阅与全量函数调用点检查**

Run: `grep -rn "subscribeToState\|loadState(" hooks/ app/ --include="*.tsx" --include="*.ts" | grep -v api/`
Expected: 无残留(`lib/storage.ts`、`lib/pb-storage.ts` 内部保留 `loadStateFromPB` 供 admin 判分刷新与 `subscribeToState` 导出可暂留但无消费方)。有残留则逐一按上述映射清除。

- [ ] **Step 7: 全量验证并与 Task 14 一并提交**

Run: `npm test && npm run build`,再全流程手工冒烟(注册→lobby→四个游戏→判分→result/ranking/screen/admin)。
Expected: PASS;所有页面 Network 中只剩:1 条 WS + 写操作 + 事件触发的 `/api/lobby`、`/api/state` + 低频兜底;无 2~4 秒级周期性请求。

```bash
git add hooks/ app/ components/RealtimeProvider.tsx
git commit -m "feat(client): hooks 全面切换 WS 快照+事件驱动,删除全部轮询与通配订阅"
```

---

### Task 16: k6 压测与验收

**Files:**
- Create: `scripts/loadtest/k6-mixed.js`
- Create: `docs/superpowers/deploy/2026-07-10-loadtest.md`

- [ ] **Step 1: 编写 `scripts/loadtest/k6-mixed.js`(完整文件)**

```js
import ws from "k6/ws";
import http from "k6/http";
import { check, sleep } from "k6";

// 用法:
//   k6 run -e BASE=https://<域名> -e WS=wss://<域名>/ws -e VUS=1000 scripts/loadtest/k6-mixed.js
const BASE = __ENV.BASE || "http://127.0.0.1:3000";
const WS_URL = __ENV.WS || "ws://127.0.0.1:8100";
const VUS = Number(__ENV.VUS || 200);

export const options = {
  scenarios: {
    ws_audience: {
      executor: "constant-vus",
      exec: "wsAudience",
      vus: Math.floor(VUS * 0.8),   // 80% 观众:长连 WS + 偶发个人拉取
      duration: "3m"
    },
    submitters: {
      executor: "constant-arrival-rate",
      exec: "submitFlow",
      rate: 50,                      // 每秒 50 次提交式读写(验收指标上限)
      timeUnit: "1s",
      duration: "3m",
      preAllocatedVUs: Math.floor(VUS * 0.2)
    }
  },
  thresholds: {
    http_req_duration: ["p(95)<1000"],   // 提交/个人读 P95 < 1s
    checks: ["rate>0.99"]
  }
};

export function wsAudience() {
  const res = ws.connect(WS_URL, {}, (socket) => {
    let gotSnapshot = false;
    socket.on("open", () => socket.send(JSON.stringify({ type: "hello", playerId: null })));
    socket.on("message", (msg) => {
      if (msg.indexOf("snapshot") >= 0) gotSnapshot = true;
    });
    socket.setTimeout(() => {
      check(gotSnapshot, { "收到快照": (v) => v });
      socket.close();
    }, 60000);
  });
  check(res, { "ws 101": (r) => r && r.status === 101 });
  sleep(1);
}

export function submitFlow() {
  // 压测环境专用只读混合:state + lobby(写路径压测需在演练库造玩家,见压测文档)
  const state = http.get(`${BASE}/api/state`);
  check(state, { "state 200": (r) => r.status === 200 });
  const q = http.get(`${BASE}/api/questions/quiz?lang=zh`);
  check(q, { "questions 200": (r) => r.status === 200 });
  sleep(0.1);
}
```

- [ ] **Step 2: 编写压测文档(含写路径方案与验收标准)**

`docs/superpowers/deploy/2026-07-10-loadtest.md`:

````markdown
# 压测方案与验收

## 环境
- 在演练用 PocketBase 数据库(拷贝 pb_data)上执行,严禁对正式库压测。
- 造数:用 scripts/ 下现有脚本或 PB Admin 批量导入 1000 名玩家。

## 执行
```bash
# 观众 + 只读混合
k6 run -e BASE=https://<域名> -e WS=wss://<域名>/ws -e VUS=1000 scripts/loadtest/k6-mixed.js
# 写路径(判分风暴演练):压测运行中,admin 页触发 bingo 判分
```

## 验收标准(设计文档第 8 节)
| 指标 | 阈值 | 采集方式 |
|---|---|---|
| 提交/个人读 P95 | < 1s | k6 http_req_duration |
| 排行榜推送延迟 | < 2s | 手改分数→大屏变化秒表/日志时间差 |
| PocketBase CPU | < 50% | top / vmstat |
| 公网下行带宽 | < 15Mbps | 云控制台监控 |
| WS 断线重连 | 杀 gateway 后 10s 内降级轮询,重启后回连 | 手工演练 |
| Bingo 判分 | 1000 玩家 < 5s 完成,期间页面不卡死 | admin 触发计时 |
````

- [ ] **Step 3: 本地小规模试跑**

Run: `k6 run -e VUS=50 scripts/loadtest/k6-mixed.js`(本地全栈起好)
Expected: thresholds 全绿,无连接错误。

- [ ] **Step 4: Commit**

```bash
git add scripts/loadtest docs/superpowers/deploy/2026-07-10-loadtest.md
git commit -m "test(loadtest): k6 混合场景压测脚本与验收标准"
```

---

### Task 17: 收尾清理与文档同步

**Files:**
- Modify: `lib/pb-storage.ts`(删除已无消费方的 `subscribeToState`、`loadState`、`saveStateToPB`、`getRankingSnapshot`、`getLobbySnapshot`——先 grep 确认零引用再删)
- Modify: `lib/storage.ts`(同步删除对应包装)
- Modify: `README.md`(架构一节补充 gateway/Redis/API 层)
- Delete: `pb_hooks/ranking.pb.js` 的 `/api/ranking-data` 保留(作为 gateway 全挂时的最后回退,注释说明),不删除。

- [ ] **Step 1: 死代码确认与删除**

Run: `grep -rn "subscribeToState\|getRankingSnapshot\|getLobbySnapshot\|loadState\b" app/ hooks/ components/ --include="*.ts*"`
Expected: 仅 `triggerBingoScore` 内部的 `loadStateFromPB` 保留;其余零引用后删除函数与导出。

- [ ] **Step 2: README 架构小节更新**

在 README「技术栈」后追加:

```markdown
## 运行拓扑(性能优化版)

- `realtime-gateway`(gateway/,:8100):全场唯一 PocketBase realtime 订阅者,计算排行/游戏状态快照写入 Redis 并经 WebSocket 推送。
- Next.js API(app/api/):个人数据(/api/lobby)、聚合快照(/api/state)、题库缓存(/api/questions)、管理操作转发(/api/admin/*)。
- Redis(127.0.0.1:6379):快照与题库缓存,不承载持久数据。
- 启动:`npm run gateway`(开发)或 `pm2 start ecosystem.config.js`(生产,见 docs/superpowers/deploy/)。
```

- [ ] **Step 3: 最终回归并提交**

Run: `npm test && npm run test:gateway && npm run build`
Expected: 全部 PASS。

```bash
git add -A
git commit -m "chore: 清理死代码,同步 README 运行拓扑"
```

---

## Self-Review 结果(已执行)

1. **Spec 覆盖检查**:设计文档 §2 架构(Task 10/12/13)、§3 网关含节流/哈希/压缩/个人事件/错峰(Task 9/10,`perMessageDeflate: true`、`MIN_PUSH_INTERVAL_MS`、`EVENT_JITTER_MS`)、§4 四个 API(Task 11,`/api/ranking` 并入 `/api/state`,`/api/admin/bingo-score` 提前至 Task 5)、§5 客户端(Task 13/14/15)、§6 查询优化+服务端判分+索引+健康检查+reset(Task 1~5)、§7 降级(Task 9 Redis 容错/Task 13 断线降级)、§8 测试验收(Task 8 单测/Task 16 压测)、§9 实施顺序(阶段划分一致)——无缺口。
2. **占位符扫描**:无 TBD/TODO;Bingo 页局部变量名、lobby 页字段两处以 grep+映射表方式给出(源文件行内容已在计划中列明精确行号与替换模式)。
3. **类型一致性**:`RankingSnapshot`/`GamesSnapshot`/`AdminSnapshot`/`ResultLite` 在 Task 8 定义、Task 9/11/13/14 消费,字段一致;WS 协议与 Redis 键在 Global Constraints 统一;`persistGameResult` 新签名仅模块内使用。
