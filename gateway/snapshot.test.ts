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
