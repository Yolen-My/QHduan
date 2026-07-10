"use client";

import * as pbStorage from "@/lib/pb-storage";
import { calculateBingoSelection } from "@/lib/bingo-scoring";
import { GAME_ORDER, GAMES, PLAYER_CACHE_KEY, PLAYER_ID_KEY, PLAYER_PHONE_KEY, STATE_KEY } from "@/lib/constants";
import { settlePendingBingoResults } from "@/lib/game-state";
import { getPlayerRank } from "@/lib/ranking";
import type { AppState, GameKey, GameResult, Player, Question } from "@/types";

let usePocketBase = false;

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

function getCompletedGamesForPlayer(player: Player, playerResults: GameResult[]): GameKey[] {
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
  if (completedQuizGroups.size >= 5) {
    completedGames.add("quiz");
  }
  return GAME_ORDER.filter((key) => completedGames.has(key));
}


function isBrowser(): boolean {
  return typeof window !== "undefined";
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

function hasPocketBaseConfig(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_POCKETBASE_URL);
}

function getEmptyRuntimeState(): AppState {
  return {
    players: [],
    gameResults: [],
    games: GAMES,
    questions: []
  };
}

export async function checkBackend(): Promise<boolean> {
  const available = await pbStorage.checkPocketBase();
  usePocketBase = available;
  return available;
}

export function getInitialState(): AppState {
  return getEmptyRuntimeState();
}

function loadStateLocal(): AppState {
  if (!isBrowser()) return getInitialState();
  const raw = window.localStorage.getItem(STATE_KEY);
  if (!raw) {
    const initialState = getInitialState();
    window.localStorage.setItem(STATE_KEY, JSON.stringify(initialState));
    return initialState;
  }
  try {
    const parsed = JSON.parse(raw) as AppState;
    // 检测 localStorage 中的 questions 是否是英文兜底数据
    const hasEnglishFallback = parsed.questions?.some(q =>
      q.gameKey === "bingo" && (q.title === "Innovation" || q.title === "AI" || q.title === "Growth")
    );
    if (hasEnglishFallback) {
      console.warn("⚠️ 检测到 localStorage 中有英文兜底数据，清除并重新加载");
      window.localStorage.removeItem(STATE_KEY);
      const initialState = getInitialState();
      window.localStorage.setItem(STATE_KEY, JSON.stringify(initialState));
      return initialState;
    }
    return {
      ...getInitialState(),
      ...parsed,
      games: (parsed.games?.length ? parsed.games : GAMES).map((game) => (
        game.key === "quiz"
          ? { ...game, quizOpenGroups: normalizeQuizOpenGroups(game.quizOpenGroups || []) }
          : game.key === "elimination"
            ? { ...game, maxScore: 200 }
            : game
      )),
      gameResults: (parsed.gameResults || []).map(normalizeGameResult),
      questions: (parsed.questions?.length ? parsed.questions : []).map(normalizeQuestion)
    };
  } catch {
    const initialState = getInitialState();
    window.localStorage.setItem(STATE_KEY, JSON.stringify(initialState));
    return initialState;
  }
}

function saveStateLocal(state: AppState): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(STATE_KEY, JSON.stringify(state));
  window.dispatchEvent(new Event("annual-game-state-change"));
}

export async function saveState(state: AppState): Promise<void> {
  const available = await checkBackend();
  if (available) {
    await pbStorage.saveState(state);
    return;
  }
  saveStateLocal(state);
}

export async function getCurrentPlayerId(): Promise<string | null> {
  if (!isBrowser()) return null;
  return window.localStorage.getItem(PLAYER_ID_KEY);
}

export async function getCurrentPlayer(): Promise<Player | null> {
  const available = await checkBackend();
  if (available) {
    return await pbStorage.getCurrentPlayer();
  }
  const playerId = await getCurrentPlayerId();
  if (!playerId) return null;
  const state = loadStateLocal();
  const player = state.players.find((item) => item.id === playerId) || null;
  if (player) {
    setCachedPlayer(player);
    return player;
  }
  return getCachedPlayer(playerId);
}

export async function restoreCurrentPlayerFromLocal(): Promise<Player | null> {
  const available = await checkBackend();
  if (available) {
    return await pbStorage.restoreCurrentPlayerFromLocal();
  }

  if (!isBrowser()) return null;
  const playerId = window.localStorage.getItem(PLAYER_ID_KEY);
  const phone = window.localStorage.getItem(PLAYER_PHONE_KEY);
  if (!playerId && !phone) return null;

  const cached = getCachedPlayer(playerId || undefined);
  if (cached) return cached;

  const state = loadStateLocal();
  if (playerId) {
    const p = state.players.find((item) => item.id === playerId);
    if (p) {
      setCachedPlayer(p);
      return p;
    }
  }
  if (phone) {
    const p = state.players.find((item) => item.phone === phone);
    if (p) {
      setCachedPlayer(p);
      window.localStorage.setItem(PLAYER_ID_KEY, p.id);
      window.localStorage.setItem(PLAYER_PHONE_KEY, p.phone);
      return p;
    }
  }
  clearCurrentPlayer();
  return null;
}

export async function findPlayerByPhone(phone: string): Promise<Player | null> {
  const available = await checkBackend();
  if (available) {
    return await pbStorage.findPlayerByPhone(phone);
  }
  const state = loadStateLocal();
  return state.players.find((item) => item.phone === phone) || null;
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

export function validatePhone(phone: string): boolean {
  return /^\d+$/.test(phone);
}

export async function registerPlayer(input: { name: string; phone: string; office: string; team: string }): Promise<{ player: Player; reused: boolean }> {
  const available = await checkBackend();
  if (available) {
    await pbStorage.ensureCollections();
    return await pbStorage.registerPlayer(input);
  }

  const name = input.name.trim().replace(/[<>]/g, "");
  const phone = input.phone.trim();
  const office = input.office.trim();
  const team = input.team.trim().replace(/[<>]/g, "");

  if (!name) throw new Error("姓名不能为空");
  if (!validatePhone(phone)) throw new Error("手机号只能填写数字");
  if (!office) throw new Error("请选择 Office");
  if (!team) throw new Error("请选择或填写 Team");

  const state = loadStateLocal();
  const existing = state.players.find((player) => player.phone === phone);
  if (existing) {
    if (existing.name !== name) {
      throw new Error("该手机号已注册");
    }
    window.localStorage.setItem(PLAYER_ID_KEY, existing.id);
    window.localStorage.setItem(PLAYER_PHONE_KEY, phone);
    setCachedPlayer(existing);
    return { player: existing, reused: true };
  }

  const player: Player = {
    id: createId("player"),
    name,
    phone,
    office,
    team,
    totalScore: 0,
    completedGames: [],
    finalSubmitted: false,
    created: nowIso(),
    updated: nowIso()
  };
  state.players.push(player);
  saveStateLocal(state);
  window.localStorage.setItem(PLAYER_ID_KEY, player.id);
  window.localStorage.setItem(PLAYER_PHONE_KEY, phone);
  setCachedPlayer(player);
  return { player, reused: false };
}

export async function getGameResult(playerId: string, gameKey: GameKey): Promise<GameResult | null> {
  const available = await checkBackend();
  if (available) {
    return await pbStorage.getGameResult(playerId, gameKey);
  }
  if (hasPocketBaseConfig()) {
    return null;
  }
  const state = loadStateLocal();
  return state.gameResults.find((result) => result.player === playerId && result.gameKey === gameKey) || null;
}

export async function isGameOpen(gameKey: GameKey): Promise<boolean> {
  const available = await checkBackend();
  if (available) {
    return await pbStorage.isGameOpen(gameKey);
  }
  const state = loadStateLocal();
  return Boolean(state.games.find((game) => game.key === gameKey)?.isOpen);
}

export async function toggleGameOpen(gameKey: GameKey): Promise<void> {
  const available = await checkBackend();
  if (available) {
    return await pbStorage.toggleGameOpen(gameKey);
  }
  const state = loadStateLocal();
  state.games = state.games.map((game) => {
    if (game.key !== gameKey) return game;
    const isOpen = !game.isOpen;
    if (game.key === "bingo") {
      if (isOpen) {
        return { ...game, isOpen, bingoScored: false, bingoPhase: "open" as const };
      }
      return { ...game, isOpen };
    }
    return { ...game, isOpen };
  });
  saveStateLocal(state);
}

export async function triggerBingoScore(): Promise<AppState> {
  const available = await checkBackend();
  if (available) {
    return await pbStorage.triggerBingoScore();
  }
  const state = settlePendingBingoResults(loadStateLocal());
  state.games = state.games.map((game) => (
    game.key === "bingo"
      ? { ...game, isOpen: false, bingoScored: true, bingoPhase: "closed" as const }
      : game
  ));
  saveStateLocal(state);
  return state;
}

export async function closeBingoGame(): Promise<void> {
  const available = await checkBackend();
  if (available) {
    return await pbStorage.closeBingoGame();
  }
  const state = loadStateLocal();
  state.games = state.games.map((game) => (
    game.key === "bingo"
      ? { ...game, isOpen: false, bingoPhase: "closed" as const }
      : game
  ));
  saveStateLocal(state);
}

export async function advanceQuizGroup(): Promise<void> {
  const available = await checkBackend();
  if (available) {
    return await pbStorage.advanceQuizGroup();
  }
  const state = loadStateLocal();
  state.games = state.games.map((game) => {
    if (game.key !== "quiz") return game;
    const nextGroup = (game.quizCurrentGroup || 0) + 1;
    const openedGroup = Math.max(0, Math.min(4, nextGroup - 1));
    const quizOpenGroups = normalizeQuizOpenGroups([...(game.quizOpenGroups || []), openedGroup]);
    return { ...game, quizCurrentGroup: nextGroup, quizOpenGroups };
  });
  saveStateLocal(state);
}

export async function openQuizGroup(groupIndex: number, gameKey: GameKey = "quiz"): Promise<void> {
  const available = await checkBackend();
  if (available) {
    return await pbStorage.openQuizGroup(groupIndex, gameKey);
  }
  const maxGroupIndex = getGroupMaxIndex(gameKey);
  if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > maxGroupIndex) {
    throw new Error(`${gameKey} group index must be between 0 and ${maxGroupIndex}`);
  }
  const state = loadStateLocal();
  state.games = state.games.map((game) => (
    game.key === gameKey
      ? {
          ...game,
          isOpen: true,
          quizOpenGroups: normalizeQuizOpenGroups([...(game.quizOpenGroups || []), groupIndex])
        }
      : game
  ));
  saveStateLocal(state);
}

export async function closeQuizGroup(groupIndex: number, gameKey: GameKey = "quiz"): Promise<void> {
  const available = await checkBackend();
  if (available) {
    return await pbStorage.closeQuizGroup(groupIndex, gameKey);
  }
  const maxGroupIndex = getGroupMaxIndex(gameKey);
  if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > maxGroupIndex) {
    throw new Error(`${gameKey} group index must be between 0 and ${maxGroupIndex}`);
  }
  const state = loadStateLocal();
  state.games = state.games.map((game) => {
    if (game.key !== gameKey) return game;
    const quizOpenGroups = normalizeQuizOpenGroups(game.quizOpenGroups || []).filter((index) => index !== groupIndex);
    return {
      ...game,
      quizOpenGroups,
      isOpen: quizOpenGroups.length > 0
    };
  });
  saveStateLocal(state);
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
  const available = await checkBackend();
  if (available) {
    return await pbStorage.submitGameResult(input);
  }

  const state = loadStateLocal();
  const game = state.games.find((g) => g.key === input.gameKey);
  const playerIndex = state.players.findIndex((player) => player.id === input.playerId);
  if (playerIndex < 0) throw new Error("未找到当前用户，请重新注册");
  const playerObj = state.players[playerIndex];

  // === Bingo 特殊逻辑：根据 bingoPhase 决定提交行为 ===
  let isPending = false;
  if (input.gameKey === "bingo") {
    const bingoPhase = game?.bingoPhase || "open";
    if (playerObj.completedGames.includes("bingo")) {
      throw new Error("该游戏已完成，不能重复提交");
    }
    const existingBingo = state.gameResults.find(
      (r) => r.player === input.playerId && r.gameKey === "bingo"
    );
    if (existingBingo && !existingBingo.pendingBingoScore) {
      throw new Error("该游戏已完成，不能重复提交");
    }
    if (existingBingo && existingBingo.pendingBingoScore) {
      throw new Error("已提交，等待 Boss 发言完成后判分");
    }
    if (bingoPhase === "closed") {
      throw new Error("Bingo 已结束");
    }
    isPending = bingoPhase === "open";
  } else if (input.gameKey === "quiz") {
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
    input = {
      ...input,
      quizSessionIndex,
      sectorKey: input.sectorKey || defaults.sectorKey,
      sectorName: input.sectorName || defaults.sectorName
    };
  } else {
    if (!game?.isOpen) {
      throw new Error("该游戏暂未开放");
    }
    if (state.gameResults.some((result) => result.player === input.playerId && result.gameKey === input.gameKey)) {
      throw new Error("该游戏已完成，不能重复提交");
    }
  }

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

  if (isPending) {
    state.gameResults = [...state.gameResults, result];
    saveStateLocal(state);
    return { result, player: playerObj, rank: getPlayerRank(state.players, input.playerId) };
  }

  const gameResults = [...state.gameResults, result];
  const totalScore = gameResults
    .filter((item) => item.player === input.playerId && !item.pendingBingoScore)
    .reduce((sum, item) => sum + item.score, 0);
  const playerResults = gameResults.filter((item) => item.player === input.playerId && !item.pendingBingoScore);
  const completedGames = getCompletedGamesForPlayer(playerObj, playerResults);
  // 站立淘汰被淘汰：视为整场比赛结束，标记最终完成
  const isEliminatedFinal = input.gameKey === "elimination" && Boolean(input.eliminated);
  const finalSubmitted = isEliminatedFinal || GAME_ORDER.every((key) => completedGames.includes(key));
  const player: Player = {
    ...playerObj,
    totalScore,
    completedGames,
    finalSubmitted,
    finalCompletedAt: finalSubmitted ? (playerObj.finalCompletedAt || nowIso()) : playerObj.finalCompletedAt,
    updated: nowIso()
  };

  state.players[playerIndex] = player;
  state.gameResults = gameResults;
  saveStateLocal(state);
  return { result, player, rank: getPlayerRank(state.players, player.id) };
}

export async function getQuestions(gameKey: GameKey) {
  const available = await checkBackend();
  if (available) {
    return await pbStorage.getQuestions(gameKey);
  }

  const state = loadStateLocal();
  return state.questions
    .map(normalizeQuestion)
    .filter((question) => question.gameKey === gameKey && question.isActive)
    .sort((a, b) => a.order - b.order);
}


export async function resetDemoData(): Promise<void> {
  const available = await checkBackend();
  if (available) {
    await pbStorage.resetDemoData();
    return;
  }

  if (!isBrowser()) return;
  window.localStorage.removeItem(STATE_KEY);
  window.localStorage.removeItem(PLAYER_ID_KEY);
  window.localStorage.removeItem(PLAYER_PHONE_KEY);
  window.localStorage.removeItem(PLAYER_CACHE_KEY);
  loadStateLocal();
}

export { PLAYER_ID_KEY, PLAYER_PHONE_KEY };
