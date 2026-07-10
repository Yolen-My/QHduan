"use client";

import { pb } from "@/lib/pocketbase";
import { calculateBingoSelection } from "@/lib/bingo-scoring";
import { GAME_ORDER, GAMES, PLAYER_CACHE_KEY, PLAYER_ID_KEY, PLAYER_PHONE_KEY } from "@/lib/constants";
import type { AppState, Game, GameKey, GameResult, Player, Question } from "@/types";

let pocketBaseAvailable = false;
let lastHealthCheckAt = 0;
const HEALTH_CHECK_CACHE_MS = 30000;

function nowIso(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getQuizSessionIndexFromOrder(order: number): number {
  return Math.max(0, Math.min(4, Math.max(1, order) - 1));
}

function getGroupMaxIndex(gameKey: GameKey): number {
  if (gameKey === "elimination") return 7;
  if (gameKey === "story") return 1;
  return 4;
}

function getQuizSectorDefaults(index: number): { sectorKey: string; sectorName: string } {
  return {
    sectorKey: `sector-${index + 1}`,
    sectorName: `Sector ${index + 1}`
  };
}

function normalizeQuizOpenGroups(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 7))]
    .sort((a, b) => a - b);
}

function normalizeAnswerValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = String(value).trim();
  try {
    const decoded = JSON.parse(raw);
    if (typeof decoded === "string" || typeof decoded === "number" || typeof decoded === "boolean") {
      return String(decoded).trim();
    }
  } catch {}
  return raw;
}

function normalizeQuestion(question: Question): Question {
  const normalizedQuestion: Question = {
    ...question,
    options: Array.isArray(question.options) ? question.options.map((option) => normalizeAnswerValue(option)) : question.options,
    correctAnswer: normalizeAnswerValue(question.correctAnswer)
  };
  if (normalizedQuestion.gameKey !== "quiz") return normalizedQuestion;
  const derivedSessionIndex = getQuizSessionIndexFromOrder(normalizedQuestion.order);
  const hasExplicitSector = Boolean(normalizedQuestion.sectorKey || normalizedQuestion.sectorName);
  const quizSessionIndex = Number.isInteger(normalizedQuestion.quizSessionIndex) && (hasExplicitSector || normalizedQuestion.quizSessionIndex !== 0 || derivedSessionIndex === 0)
    ? normalizedQuestion.quizSessionIndex as number
    : derivedSessionIndex;
  const defaults = getQuizSectorDefaults(quizSessionIndex);
  return {
    ...normalizedQuestion,
    quizSessionIndex,
    sectorKey: question.sectorKey || defaults.sectorKey,
    sectorName: question.sectorName || defaults.sectorName
  };
}

function normalizeGameResult(result: GameResult): GameResult {
  if (result.gameKey !== "quiz") return result;
  const quizSessionIndex = Number.isInteger(result.quizSessionIndex) ? result.quizSessionIndex : undefined;
  if (quizSessionIndex === undefined) return result;
  const defaults = getQuizSectorDefaults(quizSessionIndex);
  return {
    ...result,
    sectorKey: result.sectorKey || defaults.sectorKey,
    sectorName: result.sectorName || defaults.sectorName
  };
}

function getCompletedGamesForPlayer(player: Player, playerResults: GameResult[], nextGameKey: GameKey): GameKey[] {
  const completedGames = new Set<GameKey>(player.completedGames.filter((key) => key !== "quiz"));
  for (const result of playerResults) {
    if (result.pendingBingoScore) continue;
    if (result.gameKey !== "quiz") completedGames.add(result.gameKey);
  }

  const completedQuizGroups = new Set(
    playerResults
      .filter((result) => result.gameKey === "quiz" && !result.pendingBingoScore)
      .map((result) => result.quizSessionIndex)
      .filter((index): index is number => Number.isInteger(index))
  );
  if (completedQuizGroups.size >= 5 || (nextGameKey === "quiz" && completedQuizGroups.size >= 5)) {
    completedGames.add("quiz");
  }
  return GAME_ORDER.filter((key) => completedGames.has(key));
}


function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function getEmptyRuntimeState(): AppState {
  return {
    players: [],
    gameResults: [],
    games: GAMES,
    questions: []
  };
}

function setCachedPlayer(player: Player): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(PLAYER_CACHE_KEY, JSON.stringify(player));
}

function getCachedPlayer(playerId?: string | null): Player | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(PLAYER_CACHE_KEY);
    if (!raw) return null;
    const player = JSON.parse(raw) as Player;
    if (playerId && player.id !== playerId) return null;
    return player;
  } catch {
    return null;
  }
}

function mapPlayerRecord(record: any): Player {
  return {
    id: record.id,
    name: record.name,
    phone: record.phone,
    office: record.office,
    team: record.team,
    totalScore: record.totalScore || 0,
    completedGames: record.completedGames || [],
    finalSubmitted: Boolean(record.finalSubmitted),
    created: record.created || nowIso(),
    updated: record.updated || record.created || nowIso(),
    finalCompletedAt: record.finalCompletedAt || undefined
  };
}

function mapGameRecord(record: any): Game {
  // 兼容旧数据：没有 bingoPhase 字段时，根据 bingoScored 推断
  let bingoPhase = record.bingoPhase;
  if (record.key === "bingo" && !bingoPhase) {
    bingoPhase = record.bingoScored ? "auto_score" : "open";
  }
  return {
    id: record.id,
    key: record.key,
    name: record.name,
    maxScore: record.key === "elimination" ? 200 : record.maxScore,
    isOpen: Boolean(record.isOpen),
    order: record.order,
    bingoScored: Boolean(record.bingoScored),
    bingoPhase,
    quizCurrentGroup: record.quizCurrentGroup || 0,
    quizOpenGroups: normalizeQuizOpenGroups(record.quizOpenGroups),
    created: record.created || undefined,
    updated: record.updated || undefined
  };
}

function mapQuestionRecord(record: any): Question {
  return normalizeQuestion({
    id: record.id,
    gameKey: record.gameKey,
    type: record.type,
    title: record.title,
    options: record.options || undefined,
    correctAnswer: record.correctAnswer,
    score: record.score || 0,
    order: record.order || 1,
    isActive: record.isActive !== false,
    sectorKey: record.sectorKey || undefined,
    sectorName: record.sectorName || undefined,
    quizSessionIndex: record.quizSessionIndex
  });
}

async function loadQuestionsFromPB(): Promise<Question[]> {
  try {
    const records = await pb.collection("questions").getFullList({ sort: "order" });
    if (records.length === 0) {
      console.warn("⚠️ PocketBase 返回空题库，运行时不使用本地题库兜底");
      return [];
    }
    console.log(`✅ 从 PocketBase 加载 ${records.length} 个题目`);
    return records.map(mapQuestionRecord);
  } catch (error) {
    console.error("❌ loadQuestionsFromPB 失败:", error);
    console.warn("⚠️ 运行时不使用本地题库兜底");
    return [];
  }
}

function mapPendingBingoScore(record: any): boolean {
  if (typeof record.pendingBingoScore === "boolean") {
    return record.pendingBingoScore;
  }
  return Boolean(record.answers?.pendingBingoScore);
}

function buildPlayerUpdate(player: Player): Record<string, unknown> {
  const playerUpdate: Record<string, unknown> = {
    totalScore: player.totalScore,
    completedGames: player.completedGames,
    finalSubmitted: player.finalSubmitted
  };
  if (player.finalCompletedAt) {
    playerUpdate.finalCompletedAt = player.finalCompletedAt;
  }
  return playerUpdate;
}

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

export async function checkPocketBase(): Promise<boolean> {
  const now = Date.now();
  if (now - lastHealthCheckAt < HEALTH_CHECK_CACHE_MS) {
    return pocketBaseAvailable;
  }
  lastHealthCheckAt = now;
  try {
    await pb.health.check();
    pocketBaseAvailable = true;
    return true;
  } catch {
    pocketBaseAvailable = false;
    return false;
  }
}

export async function ensureGameState(): Promise<void> {
  const available = await checkPocketBase();
  if (!available) return;

  try {
    const list = await pb.collection("games").getFullList();
    if (list.length === 0) {
      for (const game of GAMES) {
        await pb.collection("games").create(game);
      }
    } else {
      // 更新已有的游戏记录，确保包含所有字段
      for (const game of GAMES) {
        const existingGame = list.find(g => g.key === game.key);
        if (existingGame) {
          let shouldUpdate = false;
          const updateData: Record<string, unknown> = {};
          
          // 检查并添加缺失的字段
          if (game.key === "bingo") {
            if (existingGame.bingoScored === undefined) {
              updateData.bingoScored = false;
              shouldUpdate = true;
            }
            if (existingGame.bingoPhase === undefined) {
              updateData.bingoPhase = existingGame.bingoScored ? "auto_score" : "open";
              shouldUpdate = true;
            }
          }
          if (game.key === "quiz") {
            if (existingGame.quizCurrentGroup === undefined) {
              updateData.quizCurrentGroup = 0;
              shouldUpdate = true;
            }
            if (existingGame.quizOpenGroups === undefined) {
              updateData.quizOpenGroups = [];
              shouldUpdate = true;
            }
          }
          
          if (shouldUpdate) {
            await pb.collection("games").update(existingGame.id, updateData);
          }
        } else {
          // 如果游戏不存在，则创建
          await pb.collection("games").create(game);
        }
      }
    }
  } catch {
    for (const game of GAMES) {
      try {
        await pb.collection("games").create(game);
      } catch {}
    }
  }
}

let collectionsEnsured = false;

// ensureCollections 是一次性的 schema 自检/初始化，旧实现每次注册都执行
// （getFullList(players) + getFullList(game_results) + ensureGameState 里对 games 的循环 update），
// 这是注册接口 ~556ms 的主要构成。这里改为每个运行时只执行一次。
export async function ensureCollectionsOnce(): Promise<void> {
  if (collectionsEnsured) return;
  await ensureCollections();
  collectionsEnsured = true;
}

export async function ensureCollections(): Promise<void> {
  const available = await checkPocketBase();
  if (!available) return;

  try {
    await pb.collection("players").getFullList(1);
  } catch {
    try {
      await pb.collection("players").create({
        name: "temp",
        phone: "13900000000",
        office: "北京",
        team: "Alpha",
        totalScore: 0,
        completedGames: [],
        finalSubmitted: false
      });
      const records = await pb.collection("players").getFullList();
      for (const record of records) {
        await pb.collection("players").delete(record.id);
      }
    } catch {}
  }

  try {
    await pb.collection("game_results").getFullList(1);
  } catch {
    throw new Error("game_results collection not found");
  }

  await ensureGameState();
}

export async function loadStateFromPB(): Promise<AppState> {
  const available = await checkPocketBase();
  if (!available) {
    return getEmptyRuntimeState();
  }

  try {
    const [players, gameResults, games, questions] = await Promise.all([
      pb.collection("players").getFullList(),
      pb.collection("game_results").getFullList({ sort: "completedAt" }),
      pb.collection("games").getFullList({ sort: "order" }),
      loadQuestionsFromPB()
    ]);

    const mappedPlayers: Player[] = players.map(mapPlayerRecord);

    const mappedResults: GameResult[] = gameResults.map(mapResultRecord);
    const mappedGames: Game[] = games.map(mapGameRecord);

    const mappedQuestions = questions.map(normalizeQuestion);
    console.log(`✅ loadStateFromPB: 加载 ${mappedQuestions.length} 个题目`);

    return {
      players: mappedPlayers,
      gameResults: mappedResults,
      games: mappedGames.length > 0 ? mappedGames : GAMES,
      questions: mappedQuestions
    };
  } catch (error) {
    console.error("❌ loadStateFromPB 失败:", error);
    return getEmptyRuntimeState();
  }
}

export function getInitialState(): AppState {
  return getEmptyRuntimeState();
}


export async function saveState(state: AppState): Promise<void> {
  const available = await checkPocketBase();
  if (!available) return;

  if (isBrowser()) {
    window.dispatchEvent(new Event("annual-game-state-change"));
  }
}

export async function getCurrentPlayerId(): Promise<string | null> {
  if (!isBrowser()) return null;
  return window.localStorage.getItem(PLAYER_ID_KEY);
}

export async function getCurrentPlayer(): Promise<Player | null> {
  const playerId = await getCurrentPlayerId();
  if (!playerId) return null;
  const available = await checkPocketBase();
  if (!available) return null;
  try {
    const record = await pb.collection("players").getOne(playerId);
    const player = mapPlayerRecord(record);
    setCachedPlayer(player);
    return player;
  } catch {
    clearCurrentPlayer();
    return null;
  }
}

export function saveCurrentPlayer(player: Player): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(PLAYER_ID_KEY, player.id);
  if (player.phone) {
    window.localStorage.setItem(PLAYER_PHONE_KEY, player.phone);
  }
  setCachedPlayer(player);
}

export function clearCurrentPlayer(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(PLAYER_ID_KEY);
  window.localStorage.removeItem(PLAYER_PHONE_KEY);
  window.localStorage.removeItem(PLAYER_CACHE_KEY);
}

export async function findPlayerByPhone(phone: string): Promise<Player | null> {
  const trimmed = (phone || "").trim();
  if (!trimmed) return null;
  const available = await checkPocketBase();
  if (available) {
    try {
      const record = await pb.collection("players").getFirstListItem(
        pb.filter("phone = {:phone}", { phone: trimmed })
      );
      return record ? mapPlayerRecord(record) : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function restoreCurrentPlayerFromLocal(): Promise<Player | null> {
  if (!isBrowser()) return null;
  const playerId = window.localStorage.getItem(PLAYER_ID_KEY);
  const phone = window.localStorage.getItem(PLAYER_PHONE_KEY);
  if (!playerId && !phone) return null;

  const available = await checkPocketBase();
  if (available) {
    if (playerId) {
      try {
        const record = await pb.collection("players").getOne(playerId);
        if (record) {
          const player = mapPlayerRecord(record);
          saveCurrentPlayer(player);
          return player;
        }
      } catch {
        // 继续按 phone 查找
      }
    }
    if (phone) {
      const byPhone = await findPlayerByPhone(phone);
      if (byPhone) {
        saveCurrentPlayer(byPhone);
        return byPhone;
      }
    }
    // PocketBase 可用但找不到该用户，清除本地缓存
    clearCurrentPlayer();
    return null;
  }

  // PocketBase 不可用时不使用本地缓存兜底
  return null;
}

export function validatePhone(phone: string): boolean {
  return /^\d+$/.test(phone);
}

export async function registerPlayer(input: { name: string; phone: string; office: string; team: string }): Promise<{ player: Player; reused: boolean }> {
  const name = input.name.trim().replace(/[<>]/g, "");
  const phone = input.phone.trim();
  const office = input.office.trim();
  const team = input.team.trim().replace(/[<>]/g, "");

  if (!name) throw new Error("姓名不能为空");
  if (!validatePhone(phone)) throw new Error("手机号只能填写数字");
  if (!office) throw new Error("请选择 Office");
  if (!team) throw new Error("请选择或填写 Team");

  const available = await checkPocketBase();
  if (available) {
    await ensureCollectionsOnce();

    const persistLogin = (player: Player, dispatch: boolean) => {
      if (!isBrowser()) return;
      window.localStorage.setItem(PLAYER_ID_KEY, player.id);
      window.localStorage.setItem(PLAYER_PHONE_KEY, phone);
      setCachedPlayer(player);
      if (dispatch) window.dispatchEvent(new Event("annual-game-state-change"));
    };

    const findByPhone = async () =>
      pb.collection("players").getFirstListItem(pb.filter("phone = {:phone}", { phone })).catch(() => null);

    const existing = await findByPhone();
    if (existing) {
      const player = mapPlayerRecord(existing);
      if (player.name !== name) {
        throw new Error("该手机号已注册");
      }
      persistLogin(player, false);
      return { player, reused: true };
    }

    try {
      const created = await pb.collection("players").create({
        name,
        phone,
        office,
        team,
        totalScore: 0,
        completedGames: [],
        finalSubmitted: false
      });
      const player = mapPlayerRecord(created);
      persistLogin(player, true);
      return { player, reused: false };
    } catch (error) {
      // phone 唯一索引在并发下可能拦截「check-then-create」竞态：另一个并发请求已抢先创建。
      // 回查一次：同名则视为复用，否则确为手机号冲突。
      const raced = await findByPhone();
      if (raced) {
        const player = mapPlayerRecord(raced);
        if (player.name !== name) throw new Error("该手机号已注册");
        persistLogin(player, false);
        return { player, reused: true };
      }
      throw error;
    }
  }

  throw new Error("PocketBase 不可用，已禁用本地兜底数据，请稍后重试");
}

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

// 别名，语义更清晰
export const completeBossAndEnableAutoScore = triggerBingoScore;

// 完全关闭 Bingo（管理员决定终止 Bingo）
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

export async function getQuestions(gameKey: GameKey) {
  const available = await checkPocketBase();
  if (available) {
    try {
      const records = await pb.collection("questions").getFullList({
        filter: pb.filter("gameKey = {:gameKey} && isActive = true", { gameKey }),
        sort: "order"
      });
      return records.map(mapQuestionRecord).map(normalizeQuestion);
    } catch (error) {
      console.error("❌ getQuestions 直接加载 PocketBase 题库失败:", error);
      return [];
    }
  }

  return [];
}



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

