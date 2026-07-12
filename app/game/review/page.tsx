"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo } from "react";
import Layout from "@/components/Layout";
import PageBackground from "@/components/PageBackground";
import { getGameResult, getQuestions } from "@/lib/storage";
import { isBingoCorrectQuestion, getBingoTargetWords } from "@/lib/bingo-scoring";
import { useCurrentPlayer, useAppState, useAllQuestions } from "@/hooks/use-game-data";
import type { GameKey, GameResult, Question } from "@/types";

const GAME_ORDER: GameKey[] = ["bingo", "quiz", "story", "elimination"];

/* ─── helpers ─── */

function isCorrectAnswer(question: Question, userAnswer: unknown): boolean {
  if (userAnswer == null) return false;
  const answer = String(userAnswer);
  if (Array.isArray(question.correctAnswer)) {
    return question.correctAnswer.includes(answer);
  }
  return question.correctAnswer === answer;
}

/* ─── sub-components ─── */

function ReviewBingoBlock({ result, questions }: { result: GameResult; questions: Question[] }) {
  const t = useTranslations();
  const answers = result.answers as { selectedQuestionIds?: string[]; selectedWords?: string[]; targetWords?: string[]; correctCount?: number };
  const correctCount: number = answers.correctCount || 0;

  // 优先用 selectedQuestionIds(与语言无关)+ 当前语言题库重新解析,使 review 跟随界面语言。
  // 提交时冻结的 selectedWords/targetWords 是玩家当时所用语言,直接显示会导致英文界面出现中文词。
  // 无 ID 的旧数据回退到冻结值。
  const byId = new Map(questions.map((q) => [q.id, q] as const));
  const selectedIds = answers.selectedQuestionIds || [];
  const resolvedSelected = selectedIds.map((id) => byId.get(id)).filter((q): q is Question => Boolean(q));
  const canResolve = questions.length > 0 && selectedIds.length > 0 && resolvedSelected.length === selectedIds.length;

  const selectedWords: string[] = canResolve ? resolvedSelected.map((q) => q.title) : (answers.selectedWords || []);
  const targetWords: string[] = canResolve ? getBingoTargetWords(questions) : (answers.targetWords || []);

  return (
    <div className="reviewBlockContent">
      <div className="reviewScoreLine">
        <span>{t("review.score")}<b>{result.score}</b> / {result.maxScore}</span>
        <span>{t("review.correctTargets", { count: correctCount })}</span>
      </div>

      <div className="reviewBingoGrid">
        {Array.from({ length: 9 }).map((_, i) => {
          const word = selectedWords[i] || "";
          const isTarget = canResolve
            ? (resolvedSelected[i] ? isBingoCorrectQuestion(resolvedSelected[i]) : false)
            : targetWords.includes(word);
          return (
            <div className={`reviewBingoCell${isTarget ? " reviewBingoCell--correct" : " reviewBingoCell--wrong"}`} key={i}>
              {word}
            </div>
          );
        })}
      </div>

      <div className="reviewBingoTargets">
        <span className="reviewBingoTargetsLabel">{t("review.correctAnswer")}</span>
        {targetWords.map((word) => {
          const hit = selectedWords.includes(word);
          return (
            <span className={`reviewBingoTargetWord${hit ? " reviewBingoTargetWord--hit" : " reviewBingoTargetWord--miss"}`} key={word}>
              {word}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ReviewQuestion({ question, userAnswer, needsLetterPrefix }: {
  question: Question;
  userAnswer: unknown;
  needsLetterPrefix: boolean;
}) {
  const t = useTranslations();
  const answer = userAnswer != null ? String(userAnswer) : null;
  const isCorrect = isCorrectAnswer(question, userAnswer);
  const isChoice = question.type === "single" || question.type === "boolean" || question.type === "story";

  return (
    <div className={`reviewQuestion${isCorrect ? " reviewQuestion--correct" : " reviewQuestion--wrong"}`}>
      <div className="reviewQuestionTitle">{question.title}</div>

      {isChoice && question.options ? (
        <div className="reviewOptions">
          {question.options.map((option, idx) => {
            const prefix = needsLetterPrefix ? `${String.fromCharCode(65 + idx)}. ` : "";
            const isUserChoice = answer === option;
            const isRightAnswer = Array.isArray(question.correctAnswer)
              ? question.correctAnswer.includes(option)
              : question.correctAnswer === option;

            let cls = "reviewOption";
            if (isUserChoice && isRightAnswer) cls += " reviewOption--correct";
            else if (isUserChoice && !isRightAnswer) cls += " reviewOption--wrong";
            else if (!isUserChoice && isRightAnswer) cls += " reviewOption--rightAnswer";

            return (
              <div className={cls} key={idx}>
                {prefix}{option}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="reviewTextAnswers">
          <div className={`reviewTextAnswer${isCorrect ? " reviewTextAnswer--correct" : " reviewTextAnswer--wrong"}`}>
            {t("review.yourAnswer")}{answer || t("review.notAnswered")}
          </div>
          <div className="reviewTextAnswer reviewTextAnswer--right">
            {t("review.correctAnswer")}{Array.isArray(question.correctAnswer) ? question.correctAnswer.join("、") : question.correctAnswer}
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewQuizBlock({ results, questions }: { results: GameResult[]; questions: Question[] }) {
  const t = useTranslations();
  const sectors = useMemo(() => {
    return results
      .slice()
      .sort((a, b) => (a.quizSessionIndex ?? 0) - (b.quizSessionIndex ?? 0))
      .map((result) => {
        const sectorIdx = result.quizSessionIndex ?? 0;
        const sectorName = result.sectorName || `Sector ${sectorIdx + 1}`;
        const sectorQuestions = questions
          .filter((q) => (q.quizSessionIndex ?? Math.max(0, Math.max(1, q.order) - 1)) === sectorIdx)
          .sort((a, b) => a.order - b.order)
          .slice(0, 1);

        return { result, sectorName, sectorQuestions };
      });
  }, [results, questions]);

  return (
    <div className="reviewBlockContent">
      <div className="reviewScoreLine">
        <span>{t("review.total")}<b>{results.reduce((s, r) => s + r.score, 0)}</b> / 100</span>
      </div>

      {sectors.map(({ result, sectorName, sectorQuestions }) => (
        <div className="reviewSector" key={result.id}>
          <div className="reviewSectorHeader">
            <span>{sectorName}</span>
            <span>{t("review.sectorScore", { score: result.score })}</span>
          </div>
          {sectorQuestions.map((question) => (
            <ReviewQuestion
              key={question.id}
              question={question}
              userAnswer={(result.answers as Record<string, unknown>)[question.id]}
              needsLetterPrefix={true}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function ReviewStandardBlock({ result, questions }: { result: GameResult; questions: Question[] }) {
  const t = useTranslations();
  const answers = result.answers as Record<string, unknown>;

  return (
    <div className="reviewBlockContent">
      <div className="reviewScoreLine">
        <span>{t("review.score")}<b>{result.score}</b> / {result.maxScore}</span>
      </div>
      {questions
        .filter((q) => answers[q.id] != null)
        .sort((a, b) => a.order - b.order)
        .map((question) => (
          <ReviewQuestion
            key={question.id}
            question={question}
            userAnswer={answers[question.id]}
            needsLetterPrefix={question.type !== "story"}
          />
        ))}
    </div>
  );
}

/* ─── main page ─── */

export default function ReviewPage() {
  const router = useRouter();
  const t = useTranslations();
  const { playerId, player } = useCurrentPlayer();
  const { state } = useAppState();
  const { questions: allQuestions } = useAllQuestions();

  useEffect(() => {
    if (playerId === null) router.push("/register");
  }, [playerId, router]);

  const gamesWithResults = useMemo(() => {
    if (!player) return [] as GameKey[];
    const keys = new Set<GameKey>();
    // 先加入已完成的游戏
    for (const key of player.completedGames) {
      keys.add(key);
    }
    // 再加入有答题结果但尚未标记为完成的游戏（如 quiz 部分完成）
    for (const r of state.gameResults) {
      if (r.player === playerId) {
        keys.add(r.gameKey);
      }
    }
    return GAME_ORDER.filter((key) => keys.has(key));
  }, [player, state.gameResults, playerId]);

  const [resultsMap, questionsMap] = useMemo(() => {
    const rMap = new Map<GameKey, GameResult[]>();
    const qMap = new Map<GameKey, Question[]>();

    for (const key of gamesWithResults) {
      const results = state.gameResults.filter(
      (r) => r.player === playerId && r.gameKey === key && !r.pendingBingoScore
    );
    if (results.length > 0) {
      rMap.set(key, results);
    }
      const qs = allQuestions.filter((q) => q.gameKey === key && q.isActive);
      if (qs.length > 0) {
        qMap.set(key, qs);
      }
    }
    return [rMap, qMap];
  }, [gamesWithResults, state.gameResults, allQuestions, playerId]);

  if (!player) {
    return (
      <Layout title={t("common.review")} hideHeader>
        <section className="reviewPage">
          <PageBackground />
          <div className="reviewPageContent">
            <p className="reviewLoading">{t("common.loadingIdentity")}</p>
          </div>
        </section>
      </Layout>
    );
  }

  return (
    <Layout title={t("common.review")} hideHeader>
      <section className="reviewPage">
        <PageBackground />
        <div className="reviewPageContent">
          <header className="reviewNav">
            <Link className="reviewNavLink" href="/lobby">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
                <path opacity="0.9" d="M0.513405 0.994867H9.4866C9.77058 0.994867 10 0.772058 10 0.497434C10 0.222938 9.77071 0 9.4866 0H0.513405C0.229945 0 0 0.222809 0 0.497434C0 0.772058 0.229945 0.994867 0.513405 0.994867ZM9.48646 3.48203H0.513405C0.229294 3.48203 0 3.70484 0 3.97947C0 4.25409 0.229294 4.4769 0.513405 4.4769H9.4866C9.77058 4.4769 10 4.25409 10 3.97947C9.99987 3.70484 9.76914 3.48203 9.48646 3.48203ZM9.48646 7.00513H0.513405C0.230075 7.00513 0 7.22794 0 7.50257C0 7.77719 0.229945 8 0.513405 8H9.4866C9.77058 8 10 7.77719 10 7.50257C9.99987 7.22807 9.77058 7.00513 9.48646 7.00513Z" fill="white" />
              </svg>
              {t("common.lobby")}
            </Link>
            <h1>{t("common.review")}</h1>
            <Link className="reviewNavLink" href="/ranking">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="11" viewBox="0 0 12 11" fill="none" aria-hidden="true">
                <path opacity="0.9" d="M6.5364 9.64627H5.41762C5.1141 9.64628 4.8229 9.52509 4.60756 9.30916C4.39222 9.09322 4.27022 8.80007 4.2682 8.49367V1.16034C4.2682 0.852597 4.3893 0.557461 4.60486 0.339855C4.82042 0.12225 5.11278 0 5.41762 0H6.5364C6.84124 0 7.13361 0.12225 7.34916 0.339855C7.56472 0.557461 7.68582 0.852597 7.68582 1.16034V8.49367C7.6838 8.80007 7.56181 9.09322 7.34647 9.30916C7.13113 9.52509 6.83992 9.64628 6.5364 9.64627ZM5.41762 0.773558C5.31601 0.773558 5.21856 0.814308 5.1467 0.886843C5.07485 0.959379 5.03448 1.05776 5.03448 1.16034V8.49367C5.03447 8.54411 5.04443 8.59404 5.06378 8.64053C5.08313 8.68703 5.11147 8.72917 5.14715 8.76447C5.18284 8.79977 5.22514 8.82753 5.27158 8.84611C5.31802 8.8647 5.36767 8.87374 5.41762 8.87271H6.5364C6.6367 8.87274 6.73301 8.83305 6.80465 8.76218C6.87628 8.69131 6.91753 8.5949 6.91954 8.49367V1.16034C6.91758 1.05838 6.87658 0.961145 6.80515 0.889035C6.73372 0.816924 6.6374 0.775539 6.5364 0.773558H5.41762ZM2.2682 9.64627H1.14943C0.845902 9.64628 0.554696 9.52509 0.339356 9.30916C0.124016 9.09322 0.00202349 8.80007 0 8.49367V6.46695C0 6.15921 0.1211 5.86407 0.336659 5.64647C0.552218 5.42886 0.844579 5.30661 1.14943 5.30661H2.2682C2.57305 5.30661 2.86541 5.42886 3.08097 5.64647C3.29652 5.86407 3.41762 6.15921 3.41762 6.46695V8.53235C3.40574 8.83197 3.27942 9.11532 3.06513 9.32299C2.85085 9.53066 2.56524 9.64651 2.2682 9.64627ZM1.14943 6.04149C1.04781 6.04149 0.950356 6.08224 0.878503 6.15478C0.80665 6.22731 0.766283 6.32569 0.766283 6.42827V8.49367C0.766273 8.54411 0.776233 8.59404 0.79558 8.64053C0.814927 8.68703 0.843272 8.72917 0.878954 8.76447C0.914636 8.79977 0.956938 8.82753 1.00338 8.84611C1.04982 8.8647 1.09948 8.87374 1.14943 8.87271H2.2682C2.31815 8.87374 2.3678 8.8647 2.41424 8.84611C2.46069 8.82753 2.50299 8.79977 2.53867 8.76447C2.57435 8.72917 2.6027 8.68703 2.62204 8.64053C2.64139 8.59404 2.65135 8.54411 2.65134 8.49367V6.46695C2.65134 6.36437 2.61097 6.26599 2.53912 6.19345C2.46727 6.12092 2.36981 6.08017 2.2682 6.04149ZM10.8506 9.64627H9.73179C9.42827 9.64628 9.13706 9.52509 8.92172 9.30916C8.70638 9.09322 8.58439 8.80007 8.58237 8.49367V3.76034C8.58237 3.4526 8.70347 3.15746 8.91903 2.93985C9.13459 2.72225 9.42695 2.6 9.73179 2.6H10.8506C11.1554 2.6 11.4478 2.72225 11.6633 2.93985C11.8789 3.15746 12 3.4526 12 3.76034V8.53235C11.9881 8.83197 11.8618 9.11532 11.6475 9.32299C11.4332 9.53066 11.1476 9.64651 10.8506 9.64627ZM9.73179 3.37356C9.63017 3.37356 9.53272 3.41431 9.46087 3.48684C9.38901 3.55938 9.34865 3.65776 9.34865 3.76034V8.49367C9.34864 8.54411 9.3586 8.59404 9.37794 8.64053C9.39729 8.68703 9.42564 8.72917 9.46132 8.76447C9.497 8.79977 9.5393 8.82753 9.58575 8.84611C9.63219 8.8647 9.68184 8.87374 9.73179 8.87271H10.8506C10.9005 8.87374 10.9502 8.8647 10.9966 8.84611C11.0431 8.82753 11.0854 8.79977 11.121 8.76447C11.1567 8.72917 11.1851 8.68703 11.2044 8.64053C11.2238 8.59404 11.2337 8.54411 11.2337 8.49367V3.76034C11.2337 3.65776 11.1933 3.55938 11.1215 3.48684C11.0496 3.41431 10.9522 3.37356 10.8506 3.37356H9.73179Z" fill="white" />
              </svg>
              {t("common.ranking")}
            </Link>
          </header>

          {gamesWithResults.length === 0 ? (
            <div className="reviewEmpty">{t("review.empty")}</div>
          ) : (
            gamesWithResults.map((key) => {
              const results = resultsMap.get(key);
              const questions = questionsMap.get(key);
              if (!results || !questions) return null;

              return (
                <div className="reviewBlock" key={key}>
                  <div className="reviewBlockHeader">
                    <span className="reviewBlockTitle">{t(`game.name.${key}`)}</span>
                  </div>

                  {key === "bingo" ? (
                    <ReviewBingoBlock result={results[0]} questions={questions} />
                  ) : key === "quiz" ? (
                    <ReviewQuizBlock results={results} questions={questions} />
                  ) : (
                    <ReviewStandardBlock result={results[0]} questions={questions} />
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>
    </Layout>
  );
}
