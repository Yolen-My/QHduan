"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import GameBannerIcon from "@/components/GameBannerIcon";
import Layout from "@/components/Layout";
import PageBackground from "@/components/PageBackground";
import ResultModal from "@/components/ResultModal";
import WaitingModal from "@/components/WaitingModal";
import { calculateBingoSelection, getBingoTargetWords } from "@/lib/bingo-scoring";
import { getGameResult } from "@/lib/storage";
import { useCurrentPlayer, useQuestions, useSubmitGameResult, useAppState, useLobbySnapshot } from "@/hooks/use-game-data";
import { useRealtime } from "@/components/RealtimeProvider";
import type { Question } from "@/types";
import type { ReactNode } from "react";

const BINGO_SECONDS = 90;
const LEGACY_BINGO_TIMER_KEY = "bingo_timer_start";
const LEGACY_BINGO_TIMEOUT_KEY = "bingo_timeout";

// 已选宫格固定高度，长词换行后按字数动态缩小字号以完整显示
function getGridFontSize(word: string): number {
  const len = word.length;
  if (len <= 8) return 14;
  if (len <= 11) return 12;
  if (len <= 15) return 11;
  return 10;
}

function getBingoTimerKey(playerId?: string | null): string {
  return playerId ? `bingo_timer_start_${playerId}` : LEGACY_BINGO_TIMER_KEY;
}
function getBingoTimeoutKey(playerId?: string | null): string {
  return playerId ? `bingo_timeout_${playerId}` : LEGACY_BINGO_TIMEOUT_KEY;
}

function BingoShell({ children, hideNavActions = false, hideNav = false }: { children: ReactNode; hideNavActions?: boolean; hideNav?: boolean }) {
  const t = useTranslations();
  return (
    <Layout title={t("game.name.bingo")} hideHeader>
      <section className="bingoPage">
        <PageBackground />

        <div className="bingoPageContent">
          {!hideNav && (
          <header className={`bingoNav${hideNavActions ? " bingoNav--hideActions" : ""}`}>
            <Link className="bingoNavLink" href="/lobby">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
                <path
                  opacity="0.9"
                  d="M0.513405 0.994867H9.4866C9.77058 0.994867 10 0.772058 10 0.497434C10 0.222938 9.77071 0 9.4866 0H0.513405C0.229945 0 0 0.222809 0 0.497434C0 0.772058 0.229945 0.994867 0.513405 0.994867ZM9.48646 3.48203H0.513405C0.229294 3.48203 0 3.70484 0 3.97947C0 4.25409 0.229294 4.4769 0.513405 4.4769H9.4866C9.77058 4.4769 10 4.25409 10 3.97947C9.99987 3.70484 9.76914 3.48203 9.48646 3.48203ZM9.48646 7.00513H0.513405C0.230075 7.00513 0 7.22794 0 7.50257C0 7.77719 0.229945 8 0.513405 8H9.4866C9.77058 8 10 7.77719 10 7.50257C9.99987 7.22807 9.77058 7.00513 9.48646 7.00513Z"
                  fill="white"
                />
              </svg>
              {t("common.lobby")}
            </Link>
            <h1>{t("game.name.bingo")}</h1>
            <Link className="bingoNavLink" href="/ranking">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="11" viewBox="0 0 12 11" fill="none" aria-hidden="true">
                <path
                  opacity="0.9"
                  d="M6.5364 9.64627H5.41762C5.1141 9.64628 4.8229 9.52509 4.60756 9.30916C4.39222 9.09322 4.27022 8.80007 4.2682 8.49367V1.16034C4.2682 0.852597 4.3893 0.557461 4.60486 0.339855C4.82042 0.12225 5.11278 0 5.41762 0H6.5364C6.84124 0 7.13361 0.12225 7.34916 0.339855C7.56472 0.557461 7.68582 0.852597 7.68582 1.16034V8.49367C7.6838 8.80007 7.56181 9.09322 7.34647 9.30916C7.13113 9.52509 6.83992 9.64628 6.5364 9.64627ZM5.41762 0.773558C5.31601 0.773558 5.21856 0.814308 5.1467 0.886843C5.07485 0.959379 5.03448 1.05776 5.03448 1.16034V8.49367C5.03447 8.54411 5.04443 8.59404 5.06378 8.64053C5.08313 8.68703 5.11147 8.72917 5.14715 8.76447C5.18284 8.79977 5.22514 8.82753 5.27158 8.84611C5.31802 8.8647 5.36767 8.87374 5.41762 8.87271H6.5364C6.6367 8.87274 6.73301 8.83305 6.80465 8.76218C6.87628 8.69131 6.91753 8.5949 6.91954 8.49367V1.16034C6.91758 1.05838 6.87658 0.961145 6.80515 0.889035C6.73372 0.816924 6.6374 0.775539 6.5364 0.773558H5.41762ZM2.2682 9.64627H1.14943C0.845902 9.64628 0.554696 9.52509 0.339356 9.30916C0.124016 9.09322 0.00202349 8.80007 0 8.49367V6.46695C0 6.15921 0.1211 5.86407 0.336659 5.64647C0.552218 5.42886 0.844579 5.30661 1.14943 5.30661H2.2682C2.57305 5.30661 2.86541 5.42886 3.08097 5.64647C3.29652 5.86407 3.41762 6.15921 3.41762 6.46695V8.53235C3.40574 8.83197 3.27942 9.11532 3.06513 9.32299C2.85085 9.53066 2.56524 9.64651 2.2682 9.64627ZM1.14943 6.04149C1.04781 6.04149 0.950356 6.08224 0.878503 6.15478C0.80665 6.22731 0.766283 6.32569 0.766283 6.42827V8.49367C0.766273 8.54411 0.776233 8.59404 0.79558 8.64053C0.814927 8.68703 0.843272 8.72917 0.878954 8.76447C0.914636 8.79977 0.956938 8.82753 1.00338 8.84611C1.04982 8.8647 1.09948 8.87374 1.14943 8.87271H2.2682C2.31815 8.87374 2.3678 8.8647 2.41424 8.84611C2.46069 8.82753 2.50299 8.79977 2.53867 8.76447C2.57435 8.72917 2.6027 8.68703 2.62204 8.64053C2.64139 8.59404 2.65135 8.54411 2.65134 8.49367V6.46695C2.65134 6.36437 2.61097 6.26599 2.53912 6.19345C2.46727 6.12092 2.36981 6.08017 2.2682 6.08017L1.14943 6.04149ZM10.8506 9.64627H9.7318C9.42828 9.64628 9.13707 9.52509 8.92173 9.30916C8.70639 9.09322 8.5844 8.80007 8.58238 8.49367V4.68776C8.58438 4.38065 8.70613 4.08669 8.92125 3.86952C9.13638 3.65235 9.42757 3.52945 9.7318 3.52743H10.8506C11.1554 3.52743 11.4478 3.64968 11.6633 3.86728C11.8789 4.08489 12 4.38002 12 4.68776V8.49367C11.998 8.80007 11.876 9.09322 11.6606 9.30916C11.4453 9.52509 11.1541 9.64628 10.8506 9.64627ZM9.7318 4.30098C9.6308 4.30297 9.53448 4.34435 9.46305 4.41646C9.39162 4.48857 9.35062 4.5858 9.34866 4.68776V8.49367C9.35067 8.5949 9.39192 8.69131 9.46355 8.76218C9.53519 8.83305 9.6315 8.87274 9.7318 8.87271H10.8506C10.9005 8.87374 10.9502 8.8647 10.9966 8.84611C11.0431 8.82753 11.0854 8.79977 11.121 8.76447C11.1567 8.72917 11.1851 8.68703 11.2044 8.64053C11.2238 8.59404 11.2337 8.54411 11.2337 8.49367V4.68776C11.2337 4.58518 11.1933 4.4868 11.1215 4.41427C11.0496 4.34173 10.9522 4.30098 10.8506 4.30098H9.7318ZM11.6169 11H0.383142C0.281526 11 0.184073 10.9593 0.11222 10.8867C0.0403666 10.8142 0 10.7158 0 10.6132C0 10.5106 0.0403666 10.4123 0.11222 10.3397C0.184073 10.2672 0.281526 10.2264 0.383142 10.2264H11.6169C11.7185 10.2264 11.8159 10.2672 11.8878 10.3397C11.9596 10.4123 12 10.5106 12 10.6132C12 10.7158 11.9596 10.8142 11.8878 10.8867C11.8159 10.9593 11.7185 11 11.6169 11Z"
                  fill="white"
                />
              </svg>
              {t("common.ranking")}
            </Link>
          </header>
          )}

          <div className="bingoBanner">
            <div className="bingoBannerText">
              <Image
                className="bingoBannerTitle"
                src="/image/source/bingo/bingo-title.png"
                alt={t("game.name.bingo")}
                width={246}
                height={20}
              />
              <p>{t("bingo.subtitle")}</p>
            </div>
            <GameBannerIcon
              className="bingoBannerLogo"
              src="/image/source/bingo/bingo-cube.png"
              width={67}
              height={67}
              left={17}
              offsetY={9}
              containerSize={96}
            />
          </div>

          {children}
        </div>
      </section>
    </Layout>
  );
}

export default function BingoPage() {
  const router = useRouter();
  const t = useTranslations();
  const { player, playerId, refresh } = useCurrentPlayer();
  const { state } = useAppState();
  const { snapshot } = useLobbySnapshot(playerId);
  const { subscribePersonal } = useRealtime();
  const questions = useQuestions("bingo");
  const submitGameResult = useSubmitGameResult();
  const [selectedQuestionIds, setSelectedQuestionIds] = useState<string[]>([]);
  const selectedWords = useMemo(
    () =>
      selectedQuestionIds
        .map((id) => questions.find((question) => question.id === id)?.title)
        .filter((title): title is string => Boolean(title)),
    [selectedQuestionIds, questions]
  );
  const [existing, setExisting] = useState<Awaited<ReturnType<typeof getGameResult>>>(null);
  const [existingLoading, setExistingLoading] = useState(true);
  const [modal, setModal] = useState({ open: false, score: 0, total: 0, rank: 0 });
  const [waitingModal, setWaitingModal] = useState(false);
  const [pendingResult, setPendingResult] = useState<Awaited<ReturnType<typeof submitGameResult>> | null>(null);
  const [isLeaving, setIsLeaving] = useState(false);
  const [message, setMessage] = useState("");
  const [seconds, setSeconds] = useState(BINGO_SECONDS);
  const [timeUp, setTimeUp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [shouldAutoSubmitOnReentry, setShouldAutoSubmitOnReentry] = useState(false);
  const timerKey = getBingoTimerKey(playerId);
  const timeoutKey = getBingoTimeoutKey(playerId);

  // Bingo 阶段
  const bingoGame = useMemo(() => state.games.find((g) => g.key === "bingo"), [state.games]);
  const bingoPhase = bingoGame?.bingoPhase || "open";
  const currentPlayer = playerId ? player : null;

  // 用户当前的 Bingo 状态
  const myBingoResult = useMemo(() => {
    if (!playerId) return existing;
    const stateResult = state.gameResults.find((r) => r.player === playerId && r.gameKey === "bingo") || null;
    return stateResult || existing;
  }, [existing, playerId, state.gameResults]);

  // 用户是否已完成 Bingo（只看用户自己的 completedGames）
  const hasCompletedBingo = Boolean(currentPlayer?.completedGames.includes("bingo"));
  // 用户是否有等待 Boss 判分的记录
  const isWaitingForScore = Boolean(myBingoResult?.pendingBingoScore) && !hasCompletedBingo;

  useEffect(() => {
    if (playerId === null) router.push("/register");
  }, [playerId, router]);

  useEffect(() => {
    if (!playerId) {
      setExisting(null);
      setExistingLoading(playerId === undefined);
      return;
    }

    let active = true;
    const currentPlayerId = playerId;
    async function loadExisting() {
      setExistingLoading(true);
      try {
        const result = await getGameResult(currentPlayerId, "bingo");
        if (!active) return;
        setExisting(result);
      } finally {
        if (active) setExistingLoading(false);
      }
    }
    loadExisting();
    return () => {
      active = false;
    };
  }, [playerId]);

  // 等待 Boss 判分：事件驱动确认(bingo_scored / result_update 广播 → 0~3s 错峰)+ 30s 兜底
  useEffect(() => {
    if (!playerId || !isWaitingForScore) return;

    let disposed = false;
    const check = async () => {
      const result = await getGameResult(playerId as string, "bingo");
      if (!disposed && result) {
        setExisting(result);
      }
    };
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
  }, [playerId, isWaitingForScore, subscribePersonal]);

  // 按玩家隔离倒计时，避免微信内旧缓存 bingo_timer_start 污染当前玩家
  useEffect(() => {
    if (!playerId) return;
    localStorage.removeItem(LEGACY_BINGO_TIMER_KEY);
    const start = localStorage.getItem(timerKey);
    if (!start) {
      setSeconds(BINGO_SECONDS);
      setTimeUp(false);
      return;
    }
    const elapsed = (Date.now() - Number(start)) / 1000;
    const nextSeconds = Math.max(0, Math.ceil(BINGO_SECONDS - elapsed));
    setSeconds(nextSeconds);
    const expired = elapsed >= BINGO_SECONDS;
    setTimeUp(expired);
    // 如果本地已标记超时，强制 timeUp=true
    const hasTimeoutMarker = localStorage.getItem(timeoutKey) === "1";
    if (!expired && hasTimeoutMarker) {
      setTimeUp(true);
      // 已超时但时间戳未过期：清理时间戳，避免倒计时继续
      localStorage.removeItem(timerKey);
    }
    if (expired || hasTimeoutMarker) {
      // 重新进入时倒计时已结束，标记需要自动提交
      setShouldAutoSubmitOnReentry(true);
    }
  }, [playerId, timerKey, timeoutKey]);

  // 倒计时：时间到后禁止选词，自动提交（必须在 early return 之前）
  const handleSubmitRef = useRef<(autoSubmit?: boolean) => Promise<void>>(async () => {});
  useEffect(() => {
    const bingoGame = state.games.find((g) => g.key === "bingo");
    const phase = bingoGame?.bingoPhase || "open";
    const completed = currentPlayer?.completedGames?.includes("bingo");
    const waiting = Boolean(myBingoResult?.pendingBingoScore) && !completed;
    if (!playerId || timeUp || waiting || completed || phase === "closed") {
      // 已完成/已关闭时清除时间戳
      if (completed || phase === "closed") {
        localStorage.removeItem(timerKey);
        localStorage.removeItem(timeoutKey);
      }
      return;
    }
    // 首次进入：存入开始时间戳
    if (!localStorage.getItem(timerKey)) {
      localStorage.setItem(timerKey, String(Date.now()));
    }
    if (seconds <= 0) {
      setTimeUp(true);
      localStorage.removeItem(timerKey);
      localStorage.setItem(timeoutKey, "1");
      // 自动提交已选答案
      handleSubmitRef.current(true);
      return;
    }
    const timer = window.setInterval(() => setSeconds((v) => Math.max(0, v - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [playerId, timeUp, seconds, state.games, currentPlayer, myBingoResult, timerKey, timeoutKey]);

  const targetWords = useMemo(() => getBingoTargetWords(questions), [questions]);
  const selectedQuestionIdsForScore = useMemo(() => selectedQuestionIds, [selectedQuestionIds]);
  const bingoSelection = useMemo(
    () => calculateBingoSelection(questions, { selectedQuestionIds: selectedQuestionIdsForScore, selectedWords }),
    [questions, selectedQuestionIdsForScore, selectedWords]
  );
  const correctCount = bingoSelection.correctCount;
  const previewScore = bingoSelection.score;

  // 当用户完成 Bingo 时显示结果弹窗
  useEffect(() => {
    if (!hasCompletedBingo || modal.open || !currentPlayer) return;
    const latestResult = myBingoResult || pendingResult?.result;
    if (!latestResult) return;
    setWaitingModal(false);
    setModal({
      open: true,
      score: latestResult.score,
      total: currentPlayer.totalScore,
      rank: pendingResult?.rank ?? snapshot?.rank ?? 0
    });
  }, [hasCompletedBingo, myBingoResult, pendingResult, currentPlayer, modal.open, snapshot]);

  // 重新进入页面：若倒计时已结束且未完成/未等待判分，自动提交并弹出等待弹窗
  useEffect(() => {
    if (!shouldAutoSubmitOnReentry) return;
    if (existingLoading) return;
    if (!playerId) return;
    if (hasCompletedBingo || isWaitingForScore) {
      setShouldAutoSubmitOnReentry(false);
      return;
    }
    if (bingoPhase === "closed") {
      setShouldAutoSubmitOnReentry(false);
      return;
    }
    if (submitting) return;
    setShouldAutoSubmitOnReentry(false);
    handleSubmitRef.current(true);
  }, [shouldAutoSubmitOnReentry, existingLoading, playerId, hasCompletedBingo, isWaitingForScore, bingoPhase, submitting]);

  function goLobby() {
    setIsLeaving(true);
    router.push("/lobby");
  }

  if (isLeaving) {
    return (
      <BingoShell>
        <section className="bingoMainCard bingoMainCard--status">
          <p className="bingoStatusMessage">{t("common.redirecting")}</p>
        </section>
      </BingoShell>
    );
  }

  // bingoPhase === auto_score 且用户从未参与过 Bingo：禁止新进入
  if (bingoPhase === "auto_score" && !hasCompletedBingo && !isWaitingForScore && !myBingoResult) {
    return (
      <BingoShell>
        <section className="bingoMainCard bingoMainCard--status">
          <p className="bingoStatusMessage">{t("bingo.ended")}</p>
          <button className="bingoSubmitButton" type="button" onClick={goLobby}>
            {t("common.backToLobbyShort")}
          </button>
        </section>
      </BingoShell>
    );
  }

  // bingoPhase === closed 且用户未完成：禁止进入
  if (bingoPhase === "closed" && !hasCompletedBingo && !isWaitingForScore) {
    return (
      <BingoShell>
        <section className="bingoMainCard bingoMainCard--status">
          <p className="bingoStatusMessage">{t("bingo.ended")}</p>
          <button className="bingoSubmitButton" type="button" onClick={goLobby}>
            {t("common.backToLobbyShort")}
          </button>
        </section>
      </BingoShell>
    );
  }

  // 等待数据加载中
  if (existingLoading) {
    return (
      <BingoShell>
        <section className="bingoMainCard bingoMainCard--status">
          <p className="bingoStatusMessage">{t("common.gameLoading")}</p>
        </section>
      </BingoShell>
    );
  }

  if (!questions.length) {
    return (
      <BingoShell>
        <section className="bingoMainCard bingoMainCard--status">
          <p className="bingoStatusMessage">{questions.loading ? t("common.questionsLoading") : t("common.questionsReloading", { error: questions.error || t("common.noQuestions") })}</p>
        </section>
      </BingoShell>
    );
  }

  // 用户能否操作（选词与提交）
  const canInteract = !hasCompletedBingo && !isWaitingForScore && bingoPhase !== "closed";

  function toggleQuestion(question: Question) {
    if (!canInteract || timeUp) return;
    setSelectedQuestionIds((current) => {
      if (current.includes(question.id)) {
        return current.filter((id) => id !== question.id);
      }
      if (current.length >= 9) return current;
      // 同一标题可能对应多条题目记录，按 id 选中并替换旧项，避免词库高亮与宫格数量不一致
      const withoutSameTitle = current.filter((id) => {
        const item = questions.find((entry) => entry.id === id);
        return item?.title !== question.title;
      });
      return [...withoutSameTitle, question.id];
    });
  }

  async function handleSubmit(autoSubmit = false) {
    if (!playerId || submitting) return;
    if (!autoSubmit && !timeUp && selectedWords.length !== 9) {
      setMessage(t("bingo.pickNine"));
      return;
    }
    setSubmitting(true);
    localStorage.removeItem(timerKey);
    // 仅手动提交时清除超时标记；超时自动提交保留标记，以便返回后再进入仍显示超时弹窗
    if (!autoSubmit) {
      localStorage.removeItem(timeoutKey);
    }
    try {
      const outcome = await submitGameResult({
        playerId,
        gameKey: "bingo",
        answers: { selectedQuestionIds, selectedWords, targetWords, correctCount },
        score: previewScore
        // 不再传 pendingBingoScore；由后端根据 bingoPhase 决定
      });
      refresh();
      setPendingResult(outcome);
      // 根据 result.pendingBingoScore 判断 waitingModal 是否打开
      if (outcome.result.pendingBingoScore) {
        setWaitingModal(true);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("common.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  // 保持 ref 指向最新 handleSubmit，供倒计时 useEffect 调用
  handleSubmitRef.current = handleSubmit;

  const statusHint = message || (timeUp && !submitting ? t("bingo.autoSubmitting") : t("bingo.hint"));

  return (
    <BingoShell hideNavActions={canInteract} hideNav={modal.open || waitingModal || isWaitingForScore}>
      {bingoPhase === "auto_score" && !hasCompletedBingo && (
        <p className="bingoPhaseNotice">{t("bingo.phaseNotice")}</p>
      )}

      <section className="bingoMainCard">
        <div className="bingoStatus">
          <span aria-hidden="true" />
          {canInteract && !timeUp && (
            <span className="bingoTimer">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8.5" r="6.5" stroke="currentColor" strokeWidth="1.2" />
                <path d="M8 5.5V8.5L10 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              {seconds}s
            </span>
          )}
          {timeUp && (
            <span className="bingoTimer bingoTimer--up">{t("common.timeUp")}</span>
          )}
        </div>
        {canInteract && !timeUp && (
          <div className="bingoProgressTrack">
            <span
              className="bingoProgressBar"
              style={{ width: `${(seconds / BINGO_SECONDS) * 100}%` }}
            />
          </div>
        )}
        <p className="bingoHint">{statusHint}</p>

        <div className="bingoWordBank">
          {questions.map((question) => (
            <button
              className={selectedQuestionIds.includes(question.id) ? "selected" : ""}
              disabled={!canInteract || timeUp}
              key={question.id}
              type="button"
              onClick={() => toggleQuestion(question)}
            >
              {question.title}
            </button>
          ))}
        </div>

        <div className="bingoGridWrap">
          <div className="bingoGrid">
            {Array.from({ length: 9 }).map((_, index) => (
              <div className={selectedWords[index] ? "lit" : ""} key={index}>
                <span
                  style={
                    selectedWords[index]
                      ? { fontSize: `${getGridFontSize(selectedWords[index])}px` }
                      : undefined
                  }
                >
                  {selectedWords[index] || ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <button
        className="bingoSubmitButton"
        type="button"
        disabled={!canInteract || selectedWords.length !== 9}
        onClick={() => handleSubmit()}
      >
        {t("common.submit")}
      </button>

      <ResultModal
        open={modal.open}
        gameKey="bingo"
        gameName={t("game.name.bingo")}
        roundScore={modal.score}
        totalScore={modal.total}
        rank={modal.rank}
        onBackLobby={goLobby}
      />
      <WaitingModal open={(waitingModal || isWaitingForScore) && !modal.open} gameKey="bingo" gameName={t("game.name.bingo")} timeout={timeUp || localStorage.getItem(timeoutKey) === "1"} />
    </BingoShell>
  );
}
