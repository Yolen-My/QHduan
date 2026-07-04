"use client";

import { pb } from "@/lib/pocketbase";
import { calculateBingoSelection } from "@/lib/bingo-scoring";
import { GAME_ORDER, GAMES, PLAYER_CACHE_KEY, PLAYER_ID_KEY, PLAYER_PHONE_KEY } from "@/lib/constants";
import { settlePendingBingoResults } from "@/lib/game-state";
import { getOfficeAverageRanking, getOfficeTop3, getPlayerRank, getPlayerRankingContext, getTop10Ranking } from "@/lib/ranking";
import type { AppState, Game, GameKey, GameResult, Player, Question, QuizProgress, QuizSessionSnapshot } from "@/types";

let pocketBaseAvailable = false;
let lastHealthCheckAt = 0;
const HEALTH_CHECK_CACHE_MS = 5000;

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
    optionsEn: Array.isArray(question.optionsEn) ? question.optionsEn.map((option) => normalizeAnswerValue(option)) : question.optionsEn,
    correctAnswer: normalizeAnswerValue(question.correctAnswer),
    correctAnswerEn: Array.isArray(question.correctAnswerEn)
      ? question.correctAnswerEn.map((answer) => normalizeAnswerValue(answer))
      : question.correctAnswerEn !== undefined
        ? normalizeAnswerValue(question.correctAnswerEn)
        : undefined
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

function buildQuizProgress(state: AppState, playerId: string): QuizProgress {
  const quizGame = state.games.find((game) => game.key === "quiz");
  const openGroups = normalizeQuizOpenGroups(quizGame?.quizOpenGroups || []);
  const quizResults = state.gameResults
    .filter((result) => result.player === playerId && result.gameKey === "quiz" && !result.pendingBingoScore)
    .map(normalizeGameResult);
  const completedGroups = normalizeQuizOpenGroups(quizResults
    .map((result) => result.quizSessionIndex)
    .filter((index): index is number => Number.isInteger(index)));
  const completedSet = new Set(completedGroups);
  const availableGroups = openGroups.filter((group) => !completedSet.has(group));

  return {
    completedCount: completedGroups.length,
    totalCount: 5,
    score: quizResults.reduce((sum, result) => sum + result.score, 0),
    maxScore: 100,
    openGroups,
    availableGroups,
    completedGroups
  };
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
    titleEn: record.titleEn || record.title_en || undefined,
    options: record.options || undefined,
    optionsEn: record.optionsEn || record.options_en || undefined,
    correctAnswer: record.correctAnswer,
    correctAnswerEn: record.correctAnswerEn || record.correctAnswer_en || undefined,
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

    const mappedResults: GameResult[] = gameResults.map(r => ({
      id: r.id,
      player: r.player,
      gameKey: r.gameKey,
      answers: r.answers,
      score: r.score,
      maxScore: r.maxScore,
      completedAt: r.completedAt,
      pendingBingoScore: mapPendingBingoScore(r),
      quizSessionIndex: r.quizSessionIndex,
      sectorKey: r.sectorKey || undefined,
      sectorName: r.sectorName || undefined
    })).map(normalizeGameResult);
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

export async function loadState(): Promise<AppState> {
  const available = await checkPocketBase();
  if (available) {
    return await loadStateFromPB();
  }
  return getEmptyRuntimeState();
}

export async function saveStateToPB(state: AppState): Promise<void> {
  const available = await checkPocketBase();
  if (!available) return;
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
  const state = await loadState();
  return state.gameResults.find((result) => result.player === playerId && result.gameKey === gameKey) || null;
}

export async function isGameOpen(gameKey: GameKey): Promise<boolean> {
  const state = await loadState();
  return Boolean(state.games.find((game) => game.key === gameKey)?.isOpen);
}

export async function toggleGameOpen(gameKey: GameKey): Promise<AppState> {
  const state = await loadState();
  let targetGame: Game | undefined;
  const newGames = state.games.map((game) => {
    if (game.key !== gameKey) return game;
    const isOpen = !game.isOpen;
    if (game.key === "bingo") {
      // 开启 Bingo 时：恢复到 open 阶段，清除已判分标记
      // 关闭 Bingo 时：保留当前 bingoPhase（由专门的"完全关闭"按钮设置 closed）
      targetGame = isOpen
        ? { ...game, isOpen, bingoScored: false, bingoPhase: "open" as const }
        : { ...game, isOpen };
      return targetGame;
    }
    targetGame = { ...game, isOpen };
    return targetGame;
  });
  const newState = { ...state, games: newGames };

  const available = await checkPocketBase();
  if (available && targetGame) {
    const existing = await pb.collection("games").getFirstListItem(
      pb.filter("key = {:key}", { key: targetGame.key })
    );
    const data: Record<string, any> = { isOpen: targetGame.isOpen };
    if (targetGame.key === "bingo") {
      data.bingoScored = Boolean(targetGame.bingoScored);
      if (targetGame.bingoPhase) data.bingoPhase = targetGame.bingoPhase;
    }
    if (targetGame.key === "quiz") {
      data.quizCurrentGroup = targetGame.quizCurrentGroup || 0;
      data.quizOpenGroups = targetGame.quizOpenGroups || [];
    }
    await pb.collection("games").update(existing.id, data);
  }

  if (!available) throw new Error("PocketBase 不可用，已禁用本地兜底数据");
  await saveState(newState);
  return await loadState();
}

export async function triggerBingoScore(): Promise<AppState> {
  console.log("🎮 completeBossAndEnableAutoScore: 开始执行");
  
  let state = await loadState();
  console.log("📊 加载的当前状态：", {
    playersCount: state.players.length,
    gameResultsCount: state.gameResults.length,
    bingoPendingCount: state.gameResults.filter(r => r.gameKey === "bingo" && r.pendingBingoScore).length
  });
  
  // 1. 找到所有 pendingBingoScore=true 的 Bingo 记录并判分
  const gameResults = state.gameResults.map((result) => {
    if (result.gameKey !== "bingo" || !result.pendingBingoScore) return result;
    const settled = calculateBingoSelection(state.questions, result.answers, result.score);
    return {
      ...result,
      answers: {
        ...result.answers,
        selectedWords: settled.selectedWords,
        targetWords: settled.targetWords,
        correctCount: settled.correctCount,
        pendingBingoScore: false
      },
      score: settled.score,
      pendingBingoScore: false
    };
  });

  // 1.5 为没有提交过 Bingo 记录的玩家自动创建一条空 Bingo 记录（review 页面可显示正确答案）
  const playersWithoutBingo = state.players.filter(
    (p) => !gameResults.some((r) => r.player === p.id && r.gameKey === "bingo")
  );
  const autoCreatedBingoResults: GameResult[] = [];
  for (const player of playersWithoutBingo) {
    const settled = calculateBingoSelection(state.questions, {}, 0);
    autoCreatedBingoResults.push({
      id: createId("result"),
      player: player.id,
      gameKey: "bingo",
      answers: {
        selectedWords: settled.selectedWords,
        targetWords: settled.targetWords,
        correctCount: settled.correctCount
      },
      score: 0,
      maxScore: 100,
      completedAt: nowIso(),
      pendingBingoScore: false
    });
  }
  gameResults.push(...autoCreatedBingoResults);

  // 2. 重新计算所有玩家的 completedGames 和 totalScore
  const players = state.players.map((player) => {
    const playerResults = gameResults.filter((result) => result.player === player.id && !result.pendingBingoScore);
    const completedGames = getCompletedGamesForPlayer(player, playerResults, "bingo");
    const finalSubmitted = GAME_ORDER.every((key) => completedGames.includes(key));
    const totalScore = playerResults.reduce((sum, result) => sum + result.score, 0);

    return {
      ...player,
      totalScore,
      completedGames,
      finalSubmitted,
      finalCompletedAt: finalSubmitted ? player.finalCompletedAt || nowIso() : player.finalCompletedAt,
      updated: nowIso()
    };
  });

  // 3. 更新 Bingo 状态：bingoPhase=closed, isOpen=false（判分后直接完全关闭）
  const newGames = state.games.map((game) => (
    game.key === "bingo"
      ? { ...game, isOpen: false, bingoScored: true, bingoPhase: "closed" as const }
      : game
  ));
  const newState = { ...state, players, gameResults, games: newGames };

  const available = await checkPocketBase();
  if (available) {
    console.log("🔌 PocketBase 可用，开始同步数据...");
    
    try {
      const pendingResults = await pb.collection("game_results").getFullList({ 
        filter: "gameKey = 'bingo'"
      });
      
      for (const result of pendingResults) {
        if (mapPendingBingoScore(result)) {
          const settled = gameResults.find((item) => item.id === result.id);
          await pb.collection("game_results").update(result.id, {
            pendingBingoScore: false,
            score: settled?.score ?? result.score,
            answers: settled?.answers ?? { ...result.answers, pendingBingoScore: false }
          });
        }
      }

      // 为没提交 Bingo 的玩家自动创建空 Bingo 记录到 PocketBase
      for (const autoResult of autoCreatedBingoResults) {
        const created = await pb.collection("game_results").create({
          player: autoResult.player,
          gameKey: autoResult.gameKey,
          answers: autoResult.answers,
          score: autoResult.score,
          maxScore: autoResult.maxScore,
          completedAt: autoResult.completedAt,
          pendingBingoScore: false
        });
        autoResult.id = created.id;
      }

      for (const player of newState.players) {
        await pb.collection("players").update(player.id, buildPlayerUpdate(player));
      }

      const list = await pb.collection("games").getFullList();
      const bingo = list.find(g => g.key === "bingo");
      if (bingo) {
        await pb.collection("games").update(bingo.id, {
          isOpen: false,
          bingoScored: true,
          bingoPhase: "closed"
        });
      }

      console.log("✅ PocketBase 数据同步完成");
    } catch (error) {
      console.error("❌ PocketBase 同步失败:", error);
      throw error;
    }
  }

  if (!available) throw new Error("PocketBase 不可用，已禁用本地兜底数据");
  await saveState(newState);
  const finalState = await loadStateFromPB();
  console.log("🎯 completeBossAndEnableAutoScore: 执行完成");
  return finalState;
}

// 别名，语义更清晰
export const completeBossAndEnableAutoScore = triggerBingoScore;

// 完全关闭 Bingo（管理员决定终止 Bingo）
export async function closeBingoGame(): Promise<AppState> {
  const state = await loadState();
  const newGames = state.games.map((game) => (
    game.key === "bingo"
      ? { ...game, isOpen: false, bingoPhase: "closed" as const }
      : game
  ));
  const newState = { ...state, games: newGames };

  const available = await checkPocketBase();
  if (available) {
    const list = await pb.collection("games").getFullList();
    const bingo = list.find(g => g.key === "bingo");
    if (bingo) {
      await pb.collection("games").update(bingo.id, {
        isOpen: false,
        bingoPhase: "closed"
      });
    }
  }

  if (!available) throw new Error("PocketBase 不可用，已禁用本地兜底数据");
  await saveState(newState);
  return await loadStateFromPB();
}

export async function advanceQuizGroup(): Promise<AppState> {
  const state = await loadState();
  const newGames = state.games.map((game) => {
    if (game.key !== "quiz") return game;
    const nextGroup = (game.quizCurrentGroup || 0) + 1;
    const openedGroup = Math.max(0, Math.min(4, nextGroup - 1));
    const quizOpenGroups = normalizeQuizOpenGroups([...(game.quizOpenGroups || []), openedGroup]);
    return { ...game, quizCurrentGroup: nextGroup, quizOpenGroups };
  });
  const newState = { ...state, games: newGames };

  const available = await checkPocketBase();
  if (available) {
    const list = await pb.collection("games").getFullList();
    const quiz = list.find(g => g.key === "quiz");
    if (quiz) {
      const nextGroup = (quiz.quizCurrentGroup || 0) + 1;
      const openedGroup = Math.max(0, Math.min(4, nextGroup - 1));
      const quizOpenGroups = normalizeQuizOpenGroups([...(quiz.quizOpenGroups || []), openedGroup]);
      await pb.collection("games").update(quiz.id, { quizCurrentGroup: nextGroup, quizOpenGroups });
    }
  }

  if (!available) throw new Error("PocketBase 不可用，已禁用本地兜底数据");
  await saveState(newState);
  return await loadState();
}

export async function openQuizGroup(groupIndex: number, gameKey: GameKey = "quiz"): Promise<AppState> {
  const maxGroupIndex = getGroupMaxIndex(gameKey);
  if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > maxGroupIndex) {
    throw new Error(`${gameKey} group index must be between 0 and ${maxGroupIndex}`);
  }
  const state = await loadState();
  const newGames = state.games.map((game) => {
    if (game.key !== gameKey) return game;
    return {
      ...game,
      isOpen: true,
      quizOpenGroups: normalizeQuizOpenGroups([...(game.quizOpenGroups || []), groupIndex])
    };
  });
  const newState = { ...state, games: newGames };

  const available = await checkPocketBase();
  if (available) {
    const list = await pb.collection("games").getFullList();
    const targetGame = list.find(g => g.key === gameKey);
    if (targetGame) {
      await pb.collection("games").update(targetGame.id, {
        isOpen: true,
        quizOpenGroups: normalizeQuizOpenGroups([...(targetGame.quizOpenGroups || []), groupIndex])
      });
    }
  }

  if (!available) throw new Error("PocketBase 不可用，已禁用本地兜底数据");
  await saveState(newState);
  return await loadState();
}

export async function closeQuizGroup(groupIndex: number, gameKey: GameKey = "quiz"): Promise<AppState> {
  const maxGroupIndex = getGroupMaxIndex(gameKey);
  if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > maxGroupIndex) {
    throw new Error(`${gameKey} group index must be between 0 and ${maxGroupIndex}`);
  }
  const state = await loadState();
  const newGames = state.games.map((game) => {
    if (game.key !== gameKey) return game;
    const quizOpenGroups = normalizeQuizOpenGroups(game.quizOpenGroups || []).filter((index) => index !== groupIndex);
    return {
      ...game,
      quizOpenGroups,
      isOpen: quizOpenGroups.length > 0
    };
  });
  const newState = { ...state, games: newGames };

  const available = await checkPocketBase();
  if (available) {
    const list = await pb.collection("games").getFullList();
    const targetGame = list.find(g => g.key === gameKey);
    if (targetGame) {
      const quizOpenGroups = normalizeQuizOpenGroups(targetGame.quizOpenGroups || []).filter((index) => index !== groupIndex);
      await pb.collection("games").update(targetGame.id, {
        isOpen: quizOpenGroups.length > 0,
        quizOpenGroups
      });
    }
  }

  if (!available) throw new Error("PocketBase 不可用，已禁用本地兜底数据");
  await saveState(newState);
  return await loadState();
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
  const state = await loadState();
  const game = state.games.find((g) => g.key === input.gameKey);
  const player = state.players.find((p) => p.id === input.playerId);

  if (!player) throw new Error("未找到当前用户，请重新注册");

  // === Bingo 特殊逻辑：根据 bingoPhase 决定提交行为 ===
  if (input.gameKey === "bingo") {
    const bingoPhase = game?.bingoPhase || "open";

    // 1. 已完成则禁止重复提交
    if (player.completedGames.includes("bingo")) {
      throw new Error("该游戏已完成，不能重复提交");
    }
    // 已有非 pending 的 bingo 记录也算完成
    const existingBingoResult = state.gameResults.find(
      (r) => r.player === input.playerId && r.gameKey === "bingo"
    );
    if (existingBingoResult && !existingBingoResult.pendingBingoScore) {
      throw new Error("该游戏已完成，不能重复提交");
    }
    // 已存在 pending 记录不允许重复提交
    if (existingBingoResult && existingBingoResult.pendingBingoScore) {
      throw new Error("已提交，等待 Boss 发言完成后判分");
    }

    // 2. closed 阶段禁止提交
    if (bingoPhase === "closed") {
      throw new Error("Bingo 已结束");
    }

    // 3. open 阶段：标记 pending，等待 Boss 判分
    // 4. auto_score 阶段：立即判分
    const isPending = bingoPhase === "open";
    return await persistGameResult(state, input, isPending);
  }

  if (input.gameKey === "quiz") {
    const quizSessionIndex = Number.isInteger(input.quizSessionIndex) ? input.quizSessionIndex as number : 0;
    if (quizSessionIndex < 0 || quizSessionIndex > 4) {
      throw new Error("Quiz group index must be between 0 and 4");
    }
    const openGroups = normalizeQuizOpenGroups(game?.quizOpenGroups || []);
    if (!game?.isOpen || !openGroups.includes(quizSessionIndex)) {
      throw new Error("该游戏暂未开放");
    }
    if (state.gameResults.some((result) => (
      result.player === input.playerId &&
      result.gameKey === "quiz" &&
      (Number.isInteger(result.quizSessionIndex) ? result.quizSessionIndex : 0) === quizSessionIndex
    ))) {
      throw new Error("该组 Quiz 已完成，不能重复提交");
    }
    const defaults = getQuizSectorDefaults(quizSessionIndex);
    return await persistGameResult(state, {
      ...input,
      quizSessionIndex,
      sectorKey: input.sectorKey || defaults.sectorKey,
      sectorName: input.sectorName || defaults.sectorName
    }, false);
  }

  // === 其他游戏：必须 isOpen=true ===
  if (!game?.isOpen) {
    throw new Error("该游戏暂未开放");
  }

  if (state.gameResults.some((result) => result.player === input.playerId && result.gameKey === input.gameKey)) {
    throw new Error("该游戏已完成，不能重复提交");
  }

  return await persistGameResult(state, input, false);
}

async function persistGameResult(
  state: AppState,
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
  const playerIndex = state.players.findIndex((player) => player.id === input.playerId);
  if (playerIndex < 0) throw new Error("未找到当前用户，请重新注册");

  const bingoScore = input.gameKey === "bingo"
    ? calculateBingoSelection(state.questions, input.answers, input.score)
    : null;
  const maxScore = input.gameKey === "elimination" ? 200 : 100;

  const result: GameResult = {
    id: createId("result"),
    player: input.playerId,
    gameKey: input.gameKey,
    answers: bingoScore
      ? {
          ...input.answers,
          selectedWords: bingoScore.selectedWords,
          targetWords: bingoScore.targetWords,
          correctCount: bingoScore.correctCount
        }
      : input.answers,
    score: Math.max(0, Math.min(maxScore, Math.round(bingoScore?.score ?? input.score))),
    maxScore,
    completedAt: nowIso(),
    pendingBingoScore: isPending,
    quizSessionIndex: input.quizSessionIndex,
    sectorKey: input.sectorKey,
    sectorName: input.sectorName
  };

  const available = await checkPocketBase();
  if (!available) throw new Error("PocketBase 不可用，已禁用本地兜底数据");

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

  // pending 情况下不更新 player.completedGames
  if (isPending) {
    const newState: AppState = {
      ...state,
      gameResults: [...state.gameResults, result]
    };
    await saveState(newState);
    return { result, player: state.players[playerIndex], rank: getPlayerRank(state.players, input.playerId) };
  }

  // 已判分：更新 player
  const gameResults = [...state.gameResults, result];
  const totalScore = gameResults
    .filter((item) => item.player === input.playerId && !item.pendingBingoScore)
    .reduce((sum, item) => sum + item.score, 0);
  const playerResults = gameResults.filter((item) => item.player === input.playerId && !item.pendingBingoScore);
  const completedGames = getCompletedGamesForPlayer(state.players[playerIndex], playerResults, input.gameKey);
  // 站立淘汰被淘汰：视为整场比赛结束，标记最终完成
  const isEliminatedFinal = input.gameKey === "elimination" && Boolean(input.eliminated);
  const finalSubmitted = isEliminatedFinal || GAME_ORDER.every((key) => completedGames.includes(key));
  const player: Player = {
    ...state.players[playerIndex],
    totalScore,
    completedGames,
    finalSubmitted,
    finalCompletedAt: finalSubmitted ? (state.players[playerIndex].finalCompletedAt || nowIso()) : state.players[playerIndex].finalCompletedAt,
    updated: nowIso()
  };

  await pb.collection("players").update(player.id, buildPlayerUpdate(player));

  const newState: AppState = {
    ...state,
    players: state.players.map((p, i) => i === playerIndex ? player : p),
    gameResults
  };
  await saveState(newState);

  return { result, player, rank: getPlayerRank(newState.players, player.id) };
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

export async function getQuizSessionSnapshot(playerId: string): Promise<QuizSessionSnapshot> {
  const state = await loadState();
  const quizGame = state.games.find((game) => game.key === "quiz");
  const results = state.gameResults
    .filter((result) => result.player === playerId && result.gameKey === "quiz")
    .map(normalizeGameResult);
  return {
    openGroups: normalizeQuizOpenGroups(quizGame?.quizOpenGroups || []),
    completedGroups: normalizeQuizOpenGroups(results
      .map((result) => result.quizSessionIndex)
      .filter((index): index is number => Number.isInteger(index))),
    results
  };
}

export async function getLobbySnapshot(playerId: string) {
  const available = await checkPocketBase();
  if (available) {
    try {
      // 旧实现为了算「我的排名」全量拉取 players（500 并发下是主要瓶颈）。
      // 改为：只取当前玩家本人 + 用 count 查询求名次（totalScore 已建索引），不再加载全表。
      const playerRecord = await pb.collection("players").getOne(playerId).catch(() => null);
      const player = playerRecord ? mapPlayerRecord(playerRecord) : null;

      const [aheadCount, playerResults, games] = await Promise.all([
        player
          ? pb.collection("players").getList(1, 1, {
              filter: pb.filter("totalScore > {:score}", { score: player.totalScore }),
              fields: "id"
            })
          : Promise.resolve({ totalItems: 0 }),
        // player 字段已建索引，该过滤查询命中索引而非全表扫描。
        pb.collection("game_results").getFullList({
          filter: pb.filter("player = {:playerId}", { playerId }),
          sort: "completedAt"
        }),
        pb.collection("games").getFullList({ sort: "order" })
      ]);

      const results: GameResult[] = playerResults.map((r) => ({
        id: r.id,
        player: r.player,
        gameKey: r.gameKey,
        answers: r.answers,
        score: r.score,
        maxScore: r.maxScore,
        completedAt: r.completedAt,
        pendingBingoScore: mapPendingBingoScore(r),
        quizSessionIndex: r.quizSessionIndex,
        sectorKey: r.sectorKey || undefined,
        sectorName: r.sectorName || undefined
      })).map(normalizeGameResult);
      const state: AppState = {
        players: player ? [player] : [],
        gameResults: results,
        games: games.map(mapGameRecord),
        questions: []
      };
      return {
        state,
        player,
        // 按总分计算名次：领先我的人数 + 1（同分并列取较优名次）。
        rank: player ? aheadCount.totalItems + 1 : 0,
        results,
        quizProgress: buildQuizProgress(state, playerId)
      };
    } catch {
      // PocketBase 查询失败时不使用本地缓存兜底，走空状态。
    }
  }

  const state = await loadState();
  const player = state.players.find((item) => item.id === playerId) || null;
  return {
    state,
    player,
    rank: player ? getPlayerRank(state.players, player.id) : 0,
    results: state.gameResults.filter((result) => result.player === playerId),
    quizProgress: buildQuizProgress(state, playerId)
  };
}

// 排行榜：players 走服务端缓存接口 /api/ranking-data（TTL=2s），games 直查。
// 旧实现走 loadState() 会额外全量加载 game_results 和 questions（排行榜完全用不到），
// 且每个客户端各自全量扫描 players，在高并发下是主要瓶颈。
export async function getRankingSnapshot(playerId?: string | null) {
  const available = await checkPocketBase();
  if (!available) {
    const empty = getEmptyRuntimeState();
    return {
      players: empty.players,
      games: empty.games,
      results: [] as GameResult[],
      top10: [],
      officeAverage: [],
      officeTop3: [],
      context: null
    };
  }

  try {
    // players 走服务端缓存接口（TTL=2s），高并发下避免每个客户端各自全表扫描；
    // games 是 4 行小表，直接查询即可（并发成本可忽略）。
    const [rankData, gameRecords] = await Promise.all([
      pb.send("/api/ranking-data", { method: "GET" }) as Promise<{ players: unknown[] }>,
      pb.collection("games").getFullList({ sort: "order" })
    ]);
    const players = (rankData?.players || []).map((r) => mapPlayerRecord(r));
    const games = gameRecords.map(mapGameRecord);
    return {
      players,
      games: games.length > 0 ? games : GAMES,
      // results 仅作为 result 页的兜底来源（snapshot.results 优先），排行榜本身不依赖它。
      results: [] as GameResult[],
      top10: getTop10Ranking(players),
      officeAverage: getOfficeAverageRanking(players),
      officeTop3: getOfficeTop3(players),
      context: playerId ? getPlayerRankingContext(players, playerId) : null
    };
  } catch (error) {
    console.error("❌ getRankingSnapshot 失败:", error);
    const empty = getEmptyRuntimeState();
    return {
      players: empty.players,
      games: empty.games,
      results: [] as GameResult[],
      top10: [],
      officeAverage: [],
      officeTop3: [],
      context: null
    };
  }
}

export async function resetDemoData(): Promise<void> {
  if (!isBrowser()) return;

  const available = await checkPocketBase();
  if (available) {
    try {
      const players = await pb.collection("players").getFullList();
      const results = await pb.collection("game_results").getFullList();
      const games = await pb.collection("games").getFullList();

      for (const p of players) {
        await pb.collection("players").delete(p.id);
      }
      for (const r of results) {
        await pb.collection("game_results").delete(r.id);
      }
      for (const game of games) {
        const updateData: Record<string, unknown> = {
          isOpen: false,
          bingoScored: game.key === "bingo" ? false : Boolean(game.bingoScored)
        };
        if (game.key === "quiz" || game.key === "elimination" || game.key === "story") {
          if (game.key === "quiz") {
            updateData.quizCurrentGroup = 0;
          }
          updateData.quizOpenGroups = [];
        }
        await pb.collection("games").update(game.id, updateData);
      }
    } catch {}
  }

  window.localStorage.removeItem("annual_game_demo_state_v3");
  window.localStorage.removeItem(PLAYER_ID_KEY);
  window.localStorage.removeItem(PLAYER_PHONE_KEY);
  window.localStorage.removeItem(PLAYER_CACHE_KEY);
  await loadState();
}

export function subscribeToState(callback: () => void): () => void {
  let unsub: (() => void) | null = null;
  let disposed = false;

  const setUnsub = (nextUnsub: () => void) => {
    if (disposed) {
      nextUnsub();
      return;
    }
    unsub = nextUnsub;
  };

  checkPocketBase().then(available => {
    if (disposed) return;

    if (!available) {
      if (isBrowser()) {
        const handler = () => callback();
        window.addEventListener("annual-game-state-change", handler);
        window.addEventListener("storage", handler);
        setUnsub(() => {
          window.removeEventListener("annual-game-state-change", handler);
          window.removeEventListener("storage", handler);
        });
      }
      return;
    }

    Promise.all([
      pb.collection("players").subscribe("*", callback),
      pb.collection("game_results").subscribe("*", callback),
      pb.collection("games").subscribe("*", callback)
    ]).then(unsubs => {
      setUnsub(() => unsubs.forEach(u => u()));
    }).catch((error) => {
      console.warn("PocketBase realtime subscribe failed; polling fallback remains active.", error);
    });
  });

  return () => {
    disposed = true;
    unsub?.();
  };
}
