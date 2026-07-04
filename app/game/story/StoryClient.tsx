"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useLocaleSwitch } from "@/components/LanguageProvider";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import GameBannerIcon from "@/components/GameBannerIcon";
import Layout from "@/components/Layout";
import PageBackground from "@/components/PageBackground";
import ResultModal from "@/components/ResultModal";
import CorrectAnswerModal from "@/components/CorrectAnswerModal";
import { calculateStoryScore } from "@/lib/scoring";
import { getGameResult } from "@/lib/storage";
import { useAppState, useCurrentPlayer, useQuestions, useRanking, useSubmitGameResult } from "@/hooks/use-game-data";
import { answerValueForLocale, isCorrectAnswerForLocale, localizedOptionLabel, localizedTitle } from "@/lib/i18n/question";
import type { Question } from "@/types";

const STORY_SECONDS = 10;
const STORY_GROUP_COUNT = 2;
const STORY_ANSWERS_KEY_PREFIX = "story_group_answers";
const STORY_TIMER_KEY_PREFIX = "story_group_timer_start";

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

function isCorrectAnswer(question: Question, answer: string | undefined, locale: "zh" | "en"): boolean {
  return isCorrectAnswerForLocale(question, answer, locale, normalizeAnswerValue);
}

function getGroupName(index: number): string {
  return `Group ${index + 1}`;
}

function getAnswersKey(playerId?: string | null): string {
  return playerId ? `${STORY_ANSWERS_KEY_PREFIX}_${playerId}` : `${STORY_ANSWERS_KEY_PREFIX}_guest`;
}

function getTimerKey(playerId: string | null | undefined, index: number): string {
  return playerId ? `${STORY_TIMER_KEY_PREFIX}_${playerId}_${index}` : `${STORY_TIMER_KEY_PREFIX}_guest_${index}`;
}

function hasAnswer(answers: Record<string, string>, question?: Question): boolean {
  return Boolean(question && Object.prototype.hasOwnProperty.call(answers, question.id));
}

function StoryNav({ hideActions = false }: { hideActions?: boolean }) {
  const t = useTranslations();
  return (
    <header className="quizNav">
      {hideActions ? <span /> : (
        <Link className="quizNavLink" href="/lobby">
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
            <path
              opacity="0.9"
              d="M0.513405 0.994867H9.4866C9.77058 0.994867 10 0.772058 10 0.497434C10 0.222938 9.77071 0 9.4866 0H0.513405C0.229945 0 0 0.222809 0 0.497434C0 0.772058 0.229945 0.994867 0.513405 0.994867ZM9.48646 3.48203H0.513405C0.229294 3.48203 0 3.70484 0 3.97947C0 4.25409 0.229294 4.4769 0.513405 4.4769H9.4866C9.77058 4.4769 10 4.25409 10 3.97947C9.99987 3.70484 9.76914 3.48203 9.48646 3.48203ZM9.48646 7.00513H0.513405C0.230075 7.00513 0 7.22794 0 7.50257C0 7.77719 0.229945 8 0.513405 8H9.4866C9.77058 8 10 7.77719 10 7.50257C9.99987 7.22807 9.77058 7.00513 9.48646 7.00513Z"
              fill="white"
            />
          </svg>
          {t("common.lobby")}
        </Link>
      )}
      <h1>{t("game.name.story")}</h1>
      {hideActions ? <span /> : (
        <Link className="quizNavLink" href="/ranking">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="11" viewBox="0 0 12 11" fill="none" aria-hidden="true">
            <path
              opacity="0.9"
              d="M6.5364 9.64627H5.41762C5.1141 9.64628 4.8229 9.52509 4.60756 9.30916C4.39222 9.09322 4.27022 8.80007 4.2682 8.49367V1.16034C4.2682 0.852597 4.3893 0.557461 4.60486 0.339855C4.82042 0.12225 5.11278 0 5.41762 0H6.5364C6.84124 0 7.13361 0.12225 7.34916 0.339855C7.56472 0.557461 7.68582 0.852597 7.68582 1.16034V8.49367C7.6838 8.80007 7.56181 9.09322 7.34647 9.30916C7.13113 9.52509 6.83992 9.64628 6.5364 9.64627ZM5.41762 0.773558C5.31601 0.773558 5.21856 0.814308 5.1467 0.886843C5.07485 0.959379 5.03448 1.05776 5.03448 1.16034V8.49367C5.03447 8.54411 5.04443 8.59404 5.06378 8.64053C5.08313 8.68703 5.11147 8.72917 5.14715 8.76447C5.18284 8.79977 5.22514 8.82753 5.27158 8.84611C5.31802 8.8647 5.36767 8.87374 5.41762 8.87271H6.5364C6.6367 8.87274 6.73301 8.83305 6.80465 8.76218C6.87628 8.69131 6.91753 8.5949 6.91954 8.49367V1.16034C6.91758 1.05838 6.87658 0.961145 6.80515 0.889035C6.73372 0.816924 6.6374 0.775539 6.5364 0.773558H5.41762ZM2.2682 9.64627H1.14943C0.845902 9.64628 0.554696 9.52509 0.339356 9.30916C0.124016 9.09322 0.00202349 8.80007 0 8.49367V6.46695C0 6.15921 0.1211 5.86407 0.336659 5.64647C0.552218 5.42886 0.844579 5.30661 1.14943 5.30661H2.2682C2.57305 5.30661 2.86541 5.42886 3.08097 5.64647C3.29652 5.86407 3.41762 6.15921 3.41762 6.46695V8.53235C3.40574 8.83197 3.27942 9.11532 3.06513 9.32299C2.85085 9.53066 2.56524 9.64651 2.2682 9.64627ZM1.14943 6.04149C1.04781 6.04149 0.950356 6.08224 0.878503 6.15478C0.80665 6.22731 0.766283 6.32569 0.766283 6.42827V8.49367C0.766273 8.54411 0.776233 8.59404 0.79558 8.64053C0.814927 8.68703 0.843272 8.72917 0.878954 8.76447C0.914636 8.79977 0.956938 8.82753 1.00338 8.84611C1.04982 8.8647 1.09948 8.87374 1.14943 8.87271H2.2682C2.31815 8.87374 2.3678 8.8647 2.41424 8.84611C2.46069 8.82753 2.50299 8.79977 2.53867 8.76447C2.57435 8.72917 2.6027 8.68703 2.62204 8.64053C2.64139 8.59404 2.65135 8.54411 2.65134 8.49367V6.46695C2.65134 6.36437 2.61097 6.26599 2.53912 6.19345C2.46727 6.12092 2.36981 6.08017 2.2682 6.08017L1.14943 6.04149ZM10.8506 9.64627H9.7318C9.42828 9.64628 9.13707 9.52509 8.92173 9.30916C8.70639 9.09322 8.5844 8.80007 8.58238 8.49367V3.8501C8.58238 3.54236 8.70348 3.24722 8.91903 3.02962C9.13459 2.81201 9.42695 2.68976 9.7318 2.68976H10.8506C11.1554 2.68976 11.4478 2.81201 11.6633 3.02962C11.8789 3.24722 12 3.54236 12 3.8501V8.49367C11.998 8.80007 11.876 9.09322 11.6606 9.30916C11.4453 9.52509 11.1541 9.64628 10.8506 9.64627ZM9.7318 3.46332C9.63018 3.46332 9.53273 3.50407 9.46088 3.5766C9.38903 3.64914 9.34866 3.74752 9.34866 3.8501V8.49367C9.34865 8.54411 9.35861 8.59404 9.37796 8.64053C9.3973 8.68703 9.42565 8.72917 9.46133 8.76447C9.49701 8.79977 9.53931 8.82753 9.58575 8.84611C9.6322 8.8647 9.68185 8.87374 9.7318 8.87271H10.8506C10.9509 8.87274 11.0472 8.83305 11.1188 8.76218C11.1905 8.69131 11.2317 8.5949 11.2337 8.49367V3.8501C11.2318 3.74814 11.1908 3.65091 11.1193 3.5788C11.0479 3.50669 10.9516 3.4653 10.8506 3.46332H9.7318Z"
              fill="white"
            />
          </svg>
          {t("common.ranking")}
        </Link>
      )}
    </header>
  );
}

function StoryShell({ children, hideNavActions = false }: { children: ReactNode; hideNavActions?: boolean }) {
  const t = useTranslations();
  return (
    <Layout title={t("game.name.story")} hideHeader>
      <section className="quizPage">
        <PageBackground />
        <div className="quizPageContent">
          <StoryNav hideActions={hideNavActions} />
          {children}
        </div>
      </section>
    </Layout>
  );
}

export default function StoryClient({ initialGroupIndex = null }: { initialGroupIndex?: number | null }) {
  const router = useRouter();
  const t = useTranslations();
  const { locale } = useLocaleSwitch();
  const { playerId, refresh: refreshPlayer, player } = useCurrentPlayer();
  const { state, refresh: refreshState, loading: stateLoading } = useAppState();
  const { ranking } = useRanking(playerId);
  const questions = useQuestions("story");
  const submitGameResult = useSubmitGameResult();

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [existing, setExisting] = useState<Awaited<ReturnType<typeof getGameResult>>>(null);
  const [existingLoading, setExistingLoading] = useState(true);
  const [modal, setModal] = useState({ open: false, score: 0, total: 0, rank: 0 });
  const [correctModalOpen, setCorrectModalOpen] = useState(false);
  const [correctModalIsCorrect, setCorrectModalIsCorrect] = useState(true);
  const [correctModalIsTimeout, setCorrectModalIsTimeout] = useState(false);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [seconds, setSeconds] = useState(STORY_SECONDS);
  const [timeUp, setTimeUp] = useState(false);

  const submittingRef = useRef(false);
  const timeUpSubmittingRef = useRef(false);
  const handleTimeUpRef = useRef<() => Promise<void>>(async () => {});

  const storyGame = state.games.find((game) => game.key === "story");
  const openGroups = storyGame?.quizOpenGroups || [];
  const storyIsOpen = Boolean(storyGame?.isOpen);

  const gameQuestions = useMemo(() => (
    questions
      .filter((question) => question.gameKey === "story" && question.isActive === true)
      .sort((a, b) => a.order - b.order)
      .slice(0, STORY_GROUP_COUNT)
  ), [questions]);

  const groups = useMemo(() => (
    Array.from({ length: STORY_GROUP_COUNT }, (_, index) => {
      const question = gameQuestions[index];
      return {
        index,
        groupName: getGroupName(index),
        question,
        isOpen: openGroups.includes(index),
        answered: hasAnswer(answers, question)
      };
    })
  ), [answers, gameQuestions, openGroups]);

  const activeGroup = initialGroupIndex === null ? null : groups[initialGroupIndex];
  const currentQuestion = activeGroup?.question;
  const selectedAnswer = currentQuestion ? answers[currentQuestion.id] || "" : "";
  const completedCount = groups.filter((group) => group.answered).length;
  const allGroupsAnswered = gameQuestions.length >= STORY_GROUP_COUNT && gameQuestions.every((question) => hasAnswer(answers, question));
  const resultModalOpen = modal.open || Boolean(existing && !existingLoading);
  const resultRoundScore = modal.open ? modal.score : existing?.score ?? 0;
  const resultTotalScore = modal.open ? modal.total : player?.totalScore ?? existing?.score ?? 0;
  const resultRank = modal.open ? modal.rank : ranking.context?.rank ?? 0;

  // 记录本次会话内游戏是否曾被开启：开启后即便所有分组关闭导致 isOpen 回落，
  // 也应停留在“开启后的页面”（分组列表），而非回到游戏未开放状态。
  const [storyWasOpened, setStoryWasOpened] = useState(false);
  useEffect(() => {
    if (storyIsOpen) setStoryWasOpened(true);
  }, [storyIsOpen]);

  useEffect(() => {
    if (playerId === null) router.push("/register");
  }, [playerId, router]);

  useEffect(() => {
    if (!playerId) {
      setExisting(null);
      setExistingLoading(playerId === undefined);
      setAnswers({});
      return;
    }

    let active = true;
    const currentPlayerId = playerId;
    async function loadExisting() {
      setExistingLoading(true);
      try {
        const result = await getGameResult(currentPlayerId, "story");
        if (!active) return;
        setExisting(result);
      } finally {
        if (active) setExistingLoading(false);
      }
    }
    loadExisting();

    try {
      const raw = window.localStorage.getItem(getAnswersKey(currentPlayerId));
      setAnswers(raw ? JSON.parse(raw) : {});
    } catch {
      setAnswers({});
    }

    return () => {
      active = false;
    };
  }, [playerId]);

  function persistAnswers(nextAnswers: Record<string, string>) {
    setAnswers(nextAnswers);
    if (playerId) {
      window.localStorage.setItem(getAnswersKey(playerId), JSON.stringify(nextAnswers));
    }
  }

  function goLobby() {
    setIsLeaving(true);
    router.push("/lobby");
  }

  function startGroup(index: number) {
    const group = groups[index];
    if (!group || group.answered || !group.isOpen || !group.question || existing) return;
    setIsLeaving(true);
    router.push(`/game/story/group/${index + 1}`);
  }

  async function submitFinal(nextAnswers: Record<string, string>) {
    if (!playerId || existing || submittingRef.current) return;
    if (gameQuestions.length < STORY_GROUP_COUNT) return;
    if (!gameQuestions.every((question) => hasAnswer(nextAnswers, question))) return;

    submittingRef.current = true;
    setSubmitting(true);
    const results = gameQuestions.map((question) => isCorrectAnswer(question, nextAnswers[question.id], locale));
    const finalScore = calculateStoryScore(results);

    try {
      const outcome = await submitGameResult({
        playerId,
        gameKey: "story",
        answers: nextAnswers,
        score: finalScore
      });
      await refreshState();
      await refreshPlayer();
      setExisting(outcome.result);
      setModal({ open: true, score: outcome.result.score, total: outcome.player.totalScore, rank: outcome.rank });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t("common.submitFailed");
      if (errorMessage.includes("已完成") && playerId) {
        const completedResult = await getGameResult(playerId, "story");
        if (completedResult) {
          await refreshState();
          await refreshPlayer();
          setExisting(completedResult);
          setModal({
            open: true,
            score: completedResult.score,
            total: player?.totalScore ?? completedResult.score,
            rank: ranking.context?.rank ?? 0
          });
          return;
        }
      }
      setMessage(errorMessage);
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  }

  async function completeGroup(answer: string) {
    if (!currentQuestion || !activeGroup || existing || submitting) return;

    window.localStorage.removeItem(getTimerKey(playerId, activeGroup.index));
    const nextAnswers = { ...answers, [currentQuestion.id]: answer };
    persistAnswers(nextAnswers);
    setMessage("");

    const completedAll = gameQuestions.length >= STORY_GROUP_COUNT && gameQuestions.every((question) => hasAnswer(nextAnswers, question));

    if (activeGroup.index < STORY_GROUP_COUNT - 1) {
      const correct = isCorrectAnswer(currentQuestion, answer, locale);
      setCorrectModalIsCorrect(correct);
      setCorrectModalIsTimeout(false);
      setCorrectModalOpen(true);
      return;
    }

    if (completedAll) {
      await submitFinal(nextAnswers);
      return;
    }
    setIsLeaving(true);
    router.replace("/game/story");
  }

  function handleCorrectModalNext() {
    setCorrectModalOpen(false);
    setIsLeaving(true);
    router.replace("/game/story");
  }

  handleTimeUpRef.current = async () => {
    if (!currentQuestion || !activeGroup || existing || modal.open || timeUpSubmittingRef.current || submitting) return;
    timeUpSubmittingRef.current = true;
    setTimeUp(true);
    if (activeGroup.index < STORY_GROUP_COUNT - 1) {
      setCorrectModalIsCorrect(false);
      setCorrectModalIsTimeout(true);
      setCorrectModalOpen(true);
      const nextAnswers = { ...answers, [currentQuestion.id]: "" };
      persistAnswers(nextAnswers);
      timeUpSubmittingRef.current = false;
      return;
    }
    await completeGroup(answers[currentQuestion.id] ?? "");
    timeUpSubmittingRef.current = false;
  };

  useEffect(() => {
    if (!playerId || !currentQuestion || !activeGroup || !activeGroup.isOpen || existing || modal.open || correctModalOpen || submitting) return;

    const timerKey = getTimerKey(playerId, activeGroup.index);
    let start = Number(window.localStorage.getItem(timerKey));
    if (!start) {
      start = Date.now();
      window.localStorage.setItem(timerKey, String(start));
    }

    setTimeUp(false);
    const tick = () => {
      const elapsed = (Date.now() - start) / 1000;
      const nextSeconds = Math.max(0, Math.ceil(STORY_SECONDS - elapsed));
      setSeconds(nextSeconds);
      if (nextSeconds <= 0) {
        window.localStorage.removeItem(timerKey);
        handleTimeUpRef.current();
      }
    };

    tick();
    const t = window.setInterval(tick, 250);
    return () => window.clearInterval(t);
  }, [playerId, currentQuestion, activeGroup, existing, modal.open, correctModalOpen, submitting]);

  function chooseAnswer(option: string) {
    if (!currentQuestion || !activeGroup?.isOpen || existing || timeUp || submitting) return;
    completeGroup(option);
  }

  if (isLeaving) {
    return (
      <StoryShell>
        <section className="quizStatusCard">
          <p className="quizStatusMessage">{t("common.redirecting")}</p>
        </section>
      </StoryShell>
    );
  }

  if (stateLoading || playerId === undefined || existingLoading) {
    return (
      <StoryShell>
        <section className="quizStatusCard">
          <p className="quizStatusMessage">{t("common.gameLoading")}</p>
        </section>
      </StoryShell>
    );
  }

  if (!questions.length) {
    return (
      <StoryShell>
        <section className="quizStatusCard">
          <p className="quizStatusMessage">{questions.loading ? t("common.questionsLoading") : t("common.questionsReloading", { error: questions.error || t("common.noQuestions") })}</p>
        </section>
      </StoryShell>
    );
  }

  if (!storyIsOpen && !storyWasOpened && !existing) {
    return (
      <StoryShell>
        <section className="quizStatusCard">
          <p className="quizStatusMessage">{t("common.gameNotOpen", { game: t("game.name.story") })}</p>
        </section>
        <button className="quizBackButton" type="button" onClick={goLobby}>
          {t("common.backToLobby")}
        </button>
      </StoryShell>
    );
  }

  if (!modal.open && !correctModalOpen && initialGroupIndex !== null && (!activeGroup || !currentQuestion || activeGroup.answered || !activeGroup.isOpen)) {
    return (
      <StoryShell>
        <section className="quizStatusCard">
          <p className="quizStatusMessage">
            {!activeGroup
              ? t("story.groupNotExist")
              : activeGroup.answered
                ? t("story.groupDone")
                : !activeGroup.isOpen
                  ? t("story.groupNotOpen")
                  : t("story.groupNoQuestions")}
          </p>
        </section>
        <button className="quizBackButton" type="button" onClick={() => router.replace("/game/story")}>
          {t("story.backToGroups")}
        </button>
      </StoryShell>
    );
  }

  if (activeGroup && currentQuestion) {
    return (
      <StoryShell hideNavActions>
        <div className="quizPlayHeader">
          <h2>{activeGroup.groupName}</h2>
          <p>{t("common.questionOf", { current: 1, total: 1 })}</p>
        </div>

        {!existing && activeGroup.isOpen && (
          <div className="quizTimer">
            <div className="quizTimerMeta">
              <span>{t("common.countdownLabel")}</span>
              <span className="quizTimerClock">{timeUp ? t("common.timeUp") : `${seconds}s`}</span>
            </div>
            {!timeUp && (
              <div className="quizTimerTrack">
                <span style={{ width: `${(seconds / STORY_SECONDS) * 100}%` }} />
              </div>
            )}
          </div>
        )}

        <section className="quizQuestionCard">
          <h3>{localizedTitle(currentQuestion, locale)}</h3>
          <div className="storyOptions">
            {currentQuestion.options?.map((option, index) => {
              const answerValue = answerValueForLocale(currentQuestion, index, locale);
              return (
                <button
                  className={selectedAnswer === answerValue ? "selected" : ""}
                  disabled={Boolean(existing) || !activeGroup.isOpen || timeUp || submitting}
                  key={`${option}-${answerValue}`}
                  type="button"
                  onClick={() => chooseAnswer(answerValue)}
                >
                  {localizedOptionLabel(currentQuestion, index, locale)}
                </button>
              );
            })}
          </div>
        </section>

        <section className="quizHintCard">
          <b>{t("common.completedOf", { completed: completedCount, total: STORY_GROUP_COUNT })}</b>
          <span>{message || (submitting ? t("common.submittingFinal") : t("story.chooseToReturn"))}</span>
        </section>

        <button className="quizBackButton" type="button" onClick={() => router.replace("/game/story")}>
          {t("story.backToGroups")}
        </button>

        <ResultModal
          open={resultModalOpen}
          gameKey="story"
          gameName={t("game.name.story")}
          roundScore={resultRoundScore}
          totalScore={resultTotalScore}
          rank={resultRank}
          onBackLobby={goLobby}
          buttonText={t("common.backToLobbyAlt")}
        />

        <CorrectAnswerModal
          open={correctModalOpen}
          isCorrect={correctModalIsCorrect}
          isTimeout={correctModalIsTimeout}
          onNext={handleCorrectModalNext}
        />
      </StoryShell>
    );
  }

  return (
    <StoryShell hideNavActions={resultModalOpen}>
      <div className="quizBanner">
        <div className="quizBannerText">
          <Image
            alt={t("game.name.story")}
            className="quizBannerTitle"
            height={20}
            src="/image/source/story/story-title.png"
            width={244}
          />
          <p>{t("story.bannerProgress", { completed: completedCount, total: STORY_GROUP_COUNT })}</p>
        </div>
        <GameBannerIcon
          className="quizBannerLogo"
          src="/image/source/story/story-book.png"
          width={95}
          height={66}
          left={5}
          offsetY={19}
          containerSize={96}
          reflectionHeight={76}
          reflectionOverlap={12}
        />
      </div>

      {existing && (
        <section className="quizStatusCard" style={{ flex: "initial", minHeight: 96, marginBottom: 16 }}>
          <p className="quizStatusMessage">{t("common.alreadyDone", { score: existing.score })}</p>
        </section>
      )}

      <section className="quizSectorCard">
        {groups.map((group) => {
          const status = existing || group.answered ? t("common.completed") : group.isOpen ? t("common.available") : t("common.notOpen");
          return (
            <div className="quizSectorRow" key={group.index}>
              <div className="quizSectorInfo">
                <b>{group.groupName}</b>
                <div className="quizSectorMeta">
                  <span>{t("common.statusLabel", { status })}</span>
                </div>
              </div>
              {existing || group.answered ? (
                <button className="quizSectorAction quizSectorAction--ghost" disabled type="button">
                  {t("common.completed")}
                </button>
              ) : group.isOpen && group.question ? (
                <button className="quizSectorAction quizSectorAction--primary" type="button" onClick={() => startGroup(group.index)}>
                  {t("common.enterAnswer")}
                </button>
              ) : (
                <button className="quizSectorAction quizSectorAction--ghost" disabled type="button">
                  {t("common.waitForHost")}
                </button>
              )}
            </div>
          );
        })}
      </section>

      {allGroupsAnswered && !existing && !modal.open && (
        <button className="quizBackButton" disabled={submitting} type="button" onClick={() => submitFinal(answers)}>
          {submitting ? t("common.submitting") : t("common.submitFinal")}
        </button>
      )}

      <button className="quizBackButton" type="button" onClick={goLobby}>
        {t("common.backToLobby")}
      </button>

      <ResultModal
        open={resultModalOpen}
        gameKey="story"
        gameName={t("game.name.story")}
        roundScore={resultRoundScore}
        totalScore={resultTotalScore}
        rank={resultRank}
        onBackLobby={goLobby}
        buttonText={t("common.backToLobbyAlt")}
      />
    </StoryShell>
  );
}
