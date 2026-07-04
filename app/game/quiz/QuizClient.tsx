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
import { useAppState, useCurrentPlayer, useQuestions, useSubmitGameResult } from "@/hooks/use-game-data";
import { answerValueForLocale, isCorrectAnswerForLocale, localizedOptionLabel, localizedTitle } from "@/lib/i18n/question";
import type { Question } from "@/types";

const TOTAL_GROUPS = 5;
const QUIZ_SCORE_PER_QUESTION = 20;

type QuizModalState = {
  open: boolean;
  roundScore: number;
  totalScore: number;
  rank: number;
  quizTotalScore: number;
  completedAll: boolean;
};

function getQuizSessionIndex(question: Question): number {
  if (Number.isInteger(question.quizSessionIndex)) {
    return question.quizSessionIndex as number;
  }
  return Math.max(0, Math.min(TOTAL_GROUPS - 1, Math.max(1, question.order) - 1));
}

function getSectorName(index: number): string {
  return `Sector ${index + 1}`;
}

function getSectorDisplayName(index: number): ReactNode {
  const labels = [
    { main: "Sector 1", sub: "TECH" },
    { main: "Sector 2", sub: "SEED / X" },
    { main: "Sector 3", sub: "CONSUMER" },
    { main: "Sector 4", sub: "HEALTHCARE" },
    { main: "Sector 5", sub: "HCEP/HSIF/HCHP" }
  ];
  const label = labels[index];
  if (!label) return `Sector ${index + 1}`;
  return (
    <>
      {label.main}
      <span className="quizSectorSubtitle">{label.sub}</span>
    </>
  );
}

function isCorrectAnswer(question: Question, answer: string | undefined, locale: "zh" | "en"): boolean {
  return isCorrectAnswerForLocale(question, answer, locale);
}

function QuizNav({ hideActions = false }: { hideActions?: boolean }) {
  const t = useTranslations();
  return (
    <header className="quizNav">
      {hideActions ? <span /> : <Link className="quizNavLink" href="/lobby">
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
          <path
            opacity="0.9"
            d="M0.513405 0.994867H9.4866C9.77058 0.994867 10 0.772058 10 0.497434C10 0.222938 9.77071 0 9.4866 0H0.513405C0.229945 0 0 0.222809 0 0.497434C0 0.772058 0.229945 0.994867 0.513405 0.994867ZM9.48646 3.48203H0.513405C0.229294 3.48203 0 3.70484 0 3.97947C0 4.25409 0.229294 4.4769 0.513405 4.4769H9.4866C9.77058 4.4769 10 4.25409 10 3.97947C9.99987 3.70484 9.76914 3.48203 9.48646 3.48203ZM9.48646 7.00513H0.513405C0.230075 7.00513 0 7.22794 0 7.50257C0 7.77719 0.229945 8 0.513405 8H9.4866C9.77058 8 10 7.77719 10 7.50257C9.99987 7.22807 9.77058 7.00513 9.48646 7.00513Z"
            fill="white"
          />
        </svg>
        {t("common.lobby")}
      </Link>}
      <h1>{t("game.name.quiz")}</h1>
      {hideActions ? <span /> : <Link className="quizNavLink" href="/ranking">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="11" viewBox="0 0 12 11" fill="none" aria-hidden="true">
          <path
            opacity="0.9"
            d="M6.5364 9.64627H5.41762C5.1141 9.64628 4.8229 9.52509 4.60756 9.30916C4.39222 9.09322 4.27022 8.80007 4.2682 8.49367V1.16034C4.2682 0.852597 4.3893 0.557461 4.60486 0.339855C4.82042 0.12225 5.11278 0 5.41762 0H6.5364C6.84124 0 7.13361 0.12225 7.34916 0.339855C7.56472 0.557461 7.68582 0.852597 7.68582 1.16034V8.49367C7.6838 8.80007 7.56181 9.09322 7.34647 9.30916C7.13113 9.52509 6.83992 9.64628 6.5364 9.64627ZM5.41762 0.773558C5.31601 0.773558 5.21856 0.814308 5.1467 0.886843C5.07485 0.959379 5.03448 1.05776 5.03448 1.16034V8.49367C5.03447 8.54411 5.04443 8.59404 5.06378 8.64053C5.08313 8.68703 5.11147 8.72917 5.14715 8.76447C5.18284 8.79977 5.22514 8.82753 5.27158 8.84611C5.31802 8.8647 5.36767 8.87374 5.41762 8.87271H6.5364C6.6367 8.87274 6.73301 8.83305 6.80465 8.76218C6.87628 8.69131 6.91753 8.5949 6.91954 8.49367V1.16034C6.91758 1.05838 6.87658 0.961145 6.80515 0.889035C6.73372 0.816924 6.6374 0.775539 6.5364 0.773558H5.41762ZM2.2682 9.64627H1.14943C0.845902 9.64628 0.554696 9.52509 0.339356 9.30916C0.124016 9.09322 0.00202349 8.80007 0 8.49367V6.46695C0 6.15921 0.1211 5.86407 0.336659 5.64647C0.552218 5.42886 0.844579 5.30661 1.14943 5.30661H2.2682C2.57305 5.30661 2.86541 5.42886 3.08097 5.64647C3.29652 5.86407 3.41762 6.15921 3.41762 6.46695V8.53235C3.40574 8.83197 3.27942 9.11532 3.06513 9.32299C2.85085 9.53066 2.56524 9.64651 2.2682 9.64627ZM1.14943 6.04149C1.04781 6.04149 0.950356 6.08224 0.878503 6.15478C0.80665 6.22731 0.766283 6.32569 0.766283 6.42827V8.49367C0.766273 8.54411 0.776233 8.59404 0.79558 8.64053C0.814927 8.68703 0.843272 8.72917 0.878954 8.76447C0.914636 8.79977 0.956938 8.82753 1.00338 8.84611C1.04982 8.8647 1.09948 8.87374 1.14943 8.87271H2.2682C2.31815 8.87374 2.3678 8.8647 2.41424 8.84611C2.46069 8.82753 2.50299 8.79977 2.53867 8.76447C2.57435 8.72917 2.6027 8.68703 2.62204 8.64053C2.64139 8.59404 2.65135 8.54411 2.65134 8.49367V6.46695C2.65134 6.36437 2.61097 6.26599 2.53912 6.19345C2.46727 6.12092 2.36981 6.08017 2.2682 6.08017L1.14943 6.04149ZM10.8506 9.64627H9.7318C9.42828 9.64628 9.13707 9.52509 8.92173 9.30916C8.70639 9.09322 8.5844 8.80007 8.58238 8.49367V4.68776C8.58438 4.38065 8.70613 4.08669 8.92125 3.86952C9.13638 3.65235 9.42757 3.52945 9.7318 3.52743H10.8506C11.1554 3.52743 11.4478 3.64968 11.6633 3.86728C11.8789 4.08489 12 4.38002 12 4.68776V8.49367C11.998 8.80007 11.876 9.09322 11.6606 9.30916C11.4453 9.52509 11.1541 9.64628 10.8506 9.64627ZM9.7318 4.30098C9.6308 4.30297 9.53448 4.34435 9.46305 4.41646C9.39162 4.48857 9.35062 4.5858 9.34866 4.68776V8.49367C9.35067 8.5949 9.39192 8.69131 9.46355 8.76218C9.53519 8.83305 9.6315 8.87274 9.7318 8.87271H10.8506C10.9005 8.87374 10.9502 8.8647 10.9966 8.84611C11.0431 8.82753 11.0854 8.79977 11.121 8.76447C11.1567 8.72917 11.1851 8.68703 11.2044 8.64053C11.2238 8.59404 11.2337 8.54411 11.2337 8.49367V4.68776C11.2337 4.58518 11.1933 4.4868 11.1215 4.41427C11.0496 4.34173 10.9522 4.30098 10.8506 4.30098H9.7318ZM11.6169 11H0.383142C0.281526 11 0.184073 10.9593 0.11222 10.8867C0.0403666 10.8142 0 10.7158 0 10.6132C0 10.5106 0.0403666 10.4123 0.11222 10.3397C0.184073 10.2672 0.281526 10.2264 0.383142 10.2264H11.6169C11.7185 10.2264 11.8159 10.2672 11.8878 10.3397C11.9596 10.4123 12 10.5106 12 10.6132C12 10.7158 11.9596 10.8142 11.8878 10.8867C11.8159 10.9593 11.7185 11 11.6169 11Z"
            fill="white"
          />
        </svg>
        {t("common.ranking")}
      </Link>}
    </header>
  );
}

function QuizShell({ children, hideNavActions = false }: { children: ReactNode; hideNavActions?: boolean }) {
  const t = useTranslations();
  return (
    <Layout title={t("game.name.quiz")} hideHeader>
      <section className="quizPage">
        <PageBackground />
        <div className="quizPageContent">
          <QuizNav hideActions={hideNavActions} />
          {children}
        </div>
      </section>
    </Layout>
  );
}

export default function QuizClient({ initialSectorIndex = null }: { initialSectorIndex?: number | null }) {
  const router = useRouter();
  const t = useTranslations();
  const { locale } = useLocaleSwitch();
  const { playerId, refresh: refreshPlayer } = useCurrentPlayer();
  const { state, refresh: refreshState, loading: stateLoading } = useAppState();
  const questions = useQuestions("quiz");
  const submitGameResult = useSubmitGameResult();

  const [activeSectorIndex, setActiveSectorIndex] = useState<number | null>(initialSectorIndex);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [modal, setModal] = useState<QuizModalState>({
    open: false,
    roundScore: 0,
    totalScore: 0,
    rank: 0,
    quizTotalScore: 0,
    completedAll: false
  });

  const submittingRef = useRef(false);

  const quizGame = state.games.find((game) => game.key === "quiz");
  const quizIsOpen = Boolean(quizGame?.isOpen);
  const quizOpenGroups = quizGame?.quizOpenGroups || [];
  const playerQuizResults = useMemo(() => (
    state.gameResults.filter((result) => result.player === playerId && result.gameKey === "quiz")
  ), [playerId, state.gameResults]);

  const quizSectors = useMemo(() => {
    const activeQuestions = questions
      .filter((question) => question.gameKey === "quiz" && question.isActive === true)
      .map((question) => ({
        ...question,
        quizSessionIndex: getQuizSessionIndex(question)
      }));

    return Array.from({ length: TOTAL_GROUPS }, (_, index) => {
      const sectorQuestions = activeQuestions
        .filter((question) => question.quizSessionIndex === index)
        .sort((a, b) => a.order - b.order)
        .slice(0, 1);
      const result = playerQuizResults.find((item) => (
        (Number.isInteger(item.quizSessionIndex) ? item.quizSessionIndex : 0) === index
      ));

      return {
        index,
        sectorName: getSectorName(index),
        questions: sectorQuestions,
        isOpen: quizOpenGroups.includes(index),
        result
      };
    });
  }, [playerQuizResults, questions, quizOpenGroups]);

  const completedCount = quizSectors.filter((sector) => Boolean(sector.result)).length;
  const quizTotalScore = quizSectors.reduce((sum, sector) => sum + (sector.result?.score || 0), 0);
  const activeSector = activeSectorIndex === null ? null : quizSectors[activeSectorIndex];
  const currentQuestion = activeSector?.questions[currentQuestionIndex];
  const selectedAnswer = currentQuestion ? answers[currentQuestion.id] : "";
  const answeredCount = activeSector ? Object.keys(answers).length : 0;

  // 记录本次会话内猎人快答是否曾被开启：开启后即便所有 Sector 关闭导致 isOpen 回落，
  // 也应停留在“猎人快答开启后的页面”（Sector 列表），而非回到游戏未开放状态。
  const [quizWasOpened, setQuizWasOpened] = useState(false);
  useEffect(() => {
    if (quizIsOpen) setQuizWasOpened(true);
  }, [quizIsOpen]);

  useEffect(() => {
    if (playerId === null) router.push("/register");
  }, [playerId, router]);

  function goLobby() {
    setIsLeaving(true);
    router.push("/lobby");
  }

  function closeModalAndRefresh() {
    setModal({
      open: false,
      roundScore: 0,
      totalScore: 0,
      rank: 0,
      quizTotalScore: 0,
      completedAll: false
    });
    submittingRef.current = false;
    setActiveSectorIndex(null);
    setCurrentQuestionIndex(0);
    setAnswers({});
    refreshState();
    refreshPlayer();
    router.replace("/game/quiz");
  }

  function startSector(index: number) {
    const sector = quizSectors[index];
    if (!sector || sector.result || !sector.isOpen) return;
    setIsLeaving(true);
    router.push(`/game/quiz/sector/${index}`);
  }

  function chooseAnswer(option: string) {
    if (!currentQuestion || submitting) return;
    setAnswers((current) => ({ ...current, [currentQuestion.id]: option }));
    setMessage("");
  }

  function goNext() {
    if (!currentQuestion || !activeSector) return;
    if (!selectedAnswer) {
      setMessage(t("quiz.chooseFirst"));
      return;
    }
    if (currentQuestionIndex < activeSector.questions.length - 1) {
      setCurrentQuestionIndex((index) => index + 1);
      return;
    }
    submitSector();
  }

  async function submitSector() {
    if (!playerId || !activeSector || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const sectorScore = Math.max(0, Math.min(100, activeSector.questions.reduce((sum, question) => (
        sum + (isCorrectAnswer(question, answers[question.id], locale) ? QUIZ_SCORE_PER_QUESTION : 0)
      ), 0)));
      const outcome = await submitGameResult({
        playerId,
        gameKey: "quiz",
        answers,
        score: sectorScore,
        quizSessionIndex: activeSector.index,
        sectorKey: activeSector.questions[0]?.sectorKey || `sector-${activeSector.index + 1}`,
        sectorName: activeSector.sectorName
      });

      const completedGroups = new Set([
        ...playerQuizResults
          .map((result) => result.quizSessionIndex)
          .filter((index): index is number => Number.isInteger(index)),
        activeSector.index
      ]);
      const nextQuizTotalScore = quizTotalScore + outcome.result.score;
      const completedAll = completedGroups.size >= TOTAL_GROUPS;

      await refreshState();
      await refreshPlayer();
      setModal({
        open: true,
        roundScore: outcome.result.score,
        totalScore: outcome.player.totalScore,
        rank: outcome.rank,
        quizTotalScore: nextQuizTotalScore,
        completedAll
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : t("common.submitFailed");
      setMessage(errMsg);
      try {
        await refreshState();
        await refreshPlayer();
      } catch { /* ignore refresh error */ }
      setModal({
        open: true,
        roundScore: 0,
        totalScore: 0,
        rank: 0,
        quizTotalScore: 0,
        completedAll: false
      });
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  }

  if (isLeaving) {
    return (
      <QuizShell>
        <section className="quizStatusCard">
          <p className="quizStatusMessage">{t("common.redirecting")}</p>
        </section>
      </QuizShell>
    );
  }

  if (stateLoading || playerId === undefined) {
    return (
      <QuizShell>
        <section className="quizStatusCard">
          <p className="quizStatusMessage">{t("quiz.syncing")}</p>
        </section>
      </QuizShell>
    );
  }

  if (!quizIsOpen && !quizWasOpened) {
    return (
      <QuizShell>
        <section className="quizStatusCard">
          <p className="quizStatusMessage">{t("quiz.notOpen")}</p>
        </section>
        <button className="quizBackButton" type="button" onClick={goLobby}>
          {t("common.backToLobby")}
        </button>
      </QuizShell>
    );
  }

  if (!questions.length) {
    return (
      <QuizShell>
        <section className="quizStatusCard">
          <p className="quizStatusMessage">{questions.loading ? t("common.questionsLoading") : t("common.questionsReloading", { error: questions.error || t("common.noQuestions") })}</p>
        </section>
      </QuizShell>
    );
  }

  if (!modal.open && initialSectorIndex !== null && !stateLoading && !questions.loading && (!activeSector || !currentQuestion || activeSector.result || !activeSector.isOpen)) {
    return (
      <QuizShell>
        <section className="quizStatusCard">
          <p className="quizStatusMessage">
            {!activeSector
              ? t("quiz.sectorNotExist")
              : activeSector.result
                ? t("quiz.sectorDone")
                : !activeSector.isOpen
                  ? t("quiz.sectorNotOpen")
                  : t("quiz.sectorNoQuestions")}
          </p>
        </section>
        <button className="quizBackButton" type="button" onClick={() => router.replace("/game/quiz")}>
          {t("quiz.backToSectors")}
        </button>
      </QuizShell>
    );
  }

  if (activeSector && currentQuestion) {
    const isLastQuestion = currentQuestionIndex === activeSector.questions.length - 1;
    const submitLabel = submitting ? t("common.submitting") : isLastQuestion ? t("quiz.submitGroup") : t("common.continue");

    return (
      <QuizShell hideNavActions>
        <div className="quizPlayHeader">
          <h2>{activeSector.sectorName}</h2>
          <p>{t("common.questionOf", { current: currentQuestionIndex + 1, total: activeSector.questions.length })}</p>
        </div>

        <section className="quizQuestionCard">
          <h3>{localizedTitle(currentQuestion, locale)}</h3>
          <div className="quizOptions">
            {currentQuestion.options?.map((option, index) => {
              const answerValue = answerValueForLocale(currentQuestion, index, locale);
              return (
                <button
                  className={selectedAnswer === answerValue ? "selected" : ""}
                  disabled={submitting}
                  key={`${option}-${answerValue}`}
                  type="button"
                  onClick={() => chooseAnswer(answerValue)}
                >
                  {String.fromCharCode(65 + index)}. {localizedOptionLabel(currentQuestion, index, locale)}
                </button>
              );
            })}
          </div>
        </section>

        <section className="quizHintCard">
          <b>{t("quiz.selectedOfTotal", { answered: answeredCount, total: activeSector.questions.length })}</b>
          <span>{message || t("quiz.chooseToContinue")}</span>
        </section>

        <button
          className="quizBackButton"
          disabled={submitting || !selectedAnswer}
          type="button"
          onClick={goNext}
        >
          {submitLabel}
        </button>

        <ResultModal
          open={modal.open}
          gameKey={modal.completedAll ? "quiz" : undefined}
          gameName={modal.completedAll ? t("game.name.quiz") : t("quiz.sectorComplete", { sector: activeSector.sectorName })}
          roundScore={modal.completedAll ? modal.quizTotalScore : modal.roundScore}
          totalScore={modal.totalScore}
          rank={modal.rank}
          buttonText={modal.completedAll ? t("common.backToLobbyAlt") : t("quiz.backPrev")}
          onBackLobby={goLobby}
          onClose={modal.completedAll ? undefined : closeModalAndRefresh}
          hideScore={!modal.completedAll}
        />
      </QuizShell>
    );
  }

  return (
    <QuizShell>
      <div className="quizBanner">
        <div className="quizBannerText">
          <Image
            alt={t("game.name.quiz")}
            className="quizBannerTitle"
            height={20}
            src="/image/source/quiz/quiz-title.png"
            width={242}
          />
          <p>{t("quiz.bannerProgress", { completed: completedCount, total: TOTAL_GROUPS })}</p>
        </div>
        <GameBannerIcon
          className="quizBannerLogo"
          src="/image/source/quiz/quiz-cube.png"
          width={67}
          height={67}
          left={17}
          offsetY={9}
          containerSize={96}
          reflectionHeight={76}
          reflectionOverlap={12}
        />
      </div>

      <section className="quizSectorCard">
        {quizSectors.map((sector) => {
          const status = sector.result ? t("common.completed") : sector.isOpen ? t("common.available") : t("common.notOpen");
          return (
            <div className="quizSectorRow" key={sector.index}>
              <div className="quizSectorInfo">
                <b>{getSectorDisplayName(sector.index)}</b>
                <div className="quizSectorMeta">
                  <span>{t("common.statusLabel", { status })}</span>
                </div>
              </div>
              {sector.result ? (
                <button className="quizSectorAction quizSectorAction--ghost" disabled type="button">
                  {t("common.completed")}
                </button>
              ) : sector.isOpen ? (
                <button className="quizSectorAction quizSectorAction--primary" type="button" onClick={() => startSector(sector.index)}>
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

      <button className="quizBackButton" type="button" onClick={goLobby}>
        {t("common.backToLobby")}
      </button>
    </QuizShell>
  );
}
