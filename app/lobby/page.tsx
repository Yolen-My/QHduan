"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import GameCard, { type GameStatusKey } from "@/components/GameCard";
import Layout from "@/components/Layout";
import PageBackground from "@/components/PageBackground";
import ScorePanel from "@/components/ScorePanel";
import { restoreCurrentPlayerFromLocal } from "@/lib/storage";
import { useCurrentPlayer, useLobbySnapshot } from "@/hooks/use-game-data";

export default function LobbyPage() {
  const router = useRouter();
  const t = useTranslations();
  const { player, playerId } = useCurrentPlayer();
  const { snapshot } = useLobbySnapshot(playerId);

  useEffect(() => {
    async function check() {
      if (playerId === null) {
        const restored = await restoreCurrentPlayerFromLocal();
        if (!restored) {
          router.push("/register");
        }
      }
    }
    check();
  }, [playerId, router]);

  if (!player || !snapshot) {
    return (
      <Layout title={t("common.lobby")} hideHeader>
        <section className="lobbyPage">
          <PageBackground />
          <div className="lobbyPageContent">
            <p className="lobbyLoading">{t("common.loadingIdentity")}</p>
          </div>
        </section>
      </Layout>
    );
  }

  const completedCount = player.completedGames.length;
  const quizProgress = snapshot.quizProgress;
  const hasBeenControlled = (game: { created?: string; updated?: string }) => Boolean(game.created && game.updated && game.created !== game.updated);
  const getClosedStatus = (game: { created?: string; updated?: string }): GameStatusKey => hasBeenControlled(game) ? "closed" : "notOpen";
  const getGroupBasedGameStatus = (game: typeof snapshot.state.games[number], completed: boolean): GameStatusKey => {
    if (completed) return "done";
    if (!game.isOpen) return getClosedStatus(game);
    return (game.quizOpenGroups || []).length > 0 ? "continueQuiz" : "gameStarted";
  };
  const getLobbyGameStatus = (game: typeof snapshot.state.games[number], completed: boolean, bingoPending = false): GameStatusKey => {
    if (completed) return "done";
    if (game.key === "bingo") {
      const phase = game.bingoPhase || "open";
      if (bingoPending) return "waitingBoss";
      if (phase === "open" && game.isOpen) return "open";
      if (phase === "auto_score") return bingoPending ? "waitingBoss" : "closed";
      if (phase === "closed") return "closed";
      return getClosedStatus(game);
    }
    if (game.key === "story" || game.key === "elimination") {
      return getGroupBasedGameStatus(game, completed);
    }
    if (game.isOpen) return "open";
    return getClosedStatus(game);
  };

  return (
    <Layout title={t("common.lobby")} hideHeader>
      <section className="lobbyPage">
        <PageBackground />

        <div className="lobbyProgressPill">{completedCount}/4</div>

        <div className="lobbyPageContent">
          <header className="lobbyHeader">
            <Link className="lobbyNavLink" href="/game/review">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="11" viewBox="0 0 12 11" fill="none" aria-hidden="true">
                <path opacity="0.9" d="M1.5 1C0.67 1 0 1.67 0 2.5V10L6 8L12 10V2.5C12 1.67 11.33 1 10.5 1C9.67 1 9 1.67 9 2.5V7.25L3 5.25V2.5C3 1.67 2.33 1 1.5 1Z" stroke="white" strokeWidth="1" strokeLinejoin="round" />
                <path opacity="0.9" d="M3 5.25V8.75" stroke="white" strokeWidth="1" strokeLinecap="round" />
                <path opacity="0.9" d="M9 7.25V8.75" stroke="white" strokeWidth="1" strokeLinecap="round" />
              </svg>
              {t("common.review")}
            </Link>
            <h1>{t("common.lobby")}</h1>
            <Link className="lobbyNavLink" href="/ranking">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="11" viewBox="0 0 12 11" fill="none" aria-hidden="true">
                <path
                  opacity="0.9"
                  d="M6.5364 9.64627H5.41762C5.1141 9.64628 4.8229 9.52509 4.60756 9.30916C4.39222 9.09322 4.27022 8.80007 4.2682 8.49367V1.16034C4.2682 0.852597 4.3893 0.557461 4.60486 0.339855C4.82042 0.12225 5.11278 0 5.41762 0H6.5364C6.84124 0 7.13361 0.12225 7.34916 0.339855C7.56472 0.557461 7.68582 0.852597 7.68582 1.16034V8.49367C7.6838 8.80007 7.56181 9.09322 7.34647 9.30916C7.13113 9.52509 6.83992 9.64628 6.5364 9.64627ZM5.41762 0.773558C5.31601 0.773558 5.21856 0.814308 5.1467 0.886843C5.07485 0.959379 5.03448 1.05776 5.03448 1.16034V8.49367C5.03447 8.54411 5.04443 8.59404 5.06378 8.64053C5.08313 8.68703 5.11147 8.72917 5.14715 8.76447C5.18284 8.79977 5.22514 8.82753 5.27158 8.84611C5.31802 8.8647 5.36767 8.87374 5.41762 8.87271H6.5364C6.6367 8.87274 6.73301 8.83305 6.80465 8.76218C6.87628 8.69131 6.91753 8.5949 6.91954 8.49367V1.16034C6.91758 1.05838 6.87658 0.961145 6.80515 0.889035C6.73372 0.816924 6.6374 0.775539 6.5364 0.773558H5.41762ZM2.2682 9.64627H1.14943C0.845902 9.64628 0.554696 9.52509 0.339356 9.30916C0.124016 9.09322 0.00202349 8.80007 0 8.49367V6.46695C0 6.15921 0.1211 5.86407 0.336659 5.64647C0.552218 5.42886 0.844579 5.30661 1.14943 5.30661H2.2682C2.57305 5.30661 2.86541 5.42886 3.08097 5.64647C3.29652 5.86407 3.41762 6.15921 3.41762 6.46695V8.53235C3.40574 8.83197 3.27942 9.11532 3.06513 9.32299C2.85085 9.53066 2.56524 9.64651 2.2682 9.64627ZM1.14943 6.04149C1.04781 6.04149 0.950356 6.08224 0.878503 6.15478C0.80665 6.22731 0.766283 6.32569 0.766283 6.42827V8.49367C0.766273 8.54411 0.776233 8.59404 0.79558 8.64053C0.814927 8.68703 0.843272 8.72917 0.878954 8.76447C0.914636 8.79977 0.956938 8.82753 1.00338 8.84611C1.04982 8.8647 1.09948 8.87374 1.14943 8.87271H2.2682C2.31815 8.87374 2.3678 8.8647 2.41424 8.84611C2.46069 8.82753 2.50299 8.79977 2.53867 8.76447C2.57435 8.72917 2.6027 8.68703 2.62204 8.64053C2.64139 8.59404 2.65135 8.54411 2.65134 8.49367V6.46695C2.65134 6.36437 2.61097 6.26599 2.53912 6.19345C2.46727 6.12092 2.36981 6.08017 2.2682 6.08017L1.14943 6.04149ZM10.8506 9.64627H9.7318C9.42828 9.64628 9.13707 9.52509 8.92173 9.30916C8.70639 9.09322 8.5844 8.80007 8.58238 8.49367V1.16034C8.58238 0.852597 8.70348 0.557461 8.91903 0.339855C9.13459 0.12225 9.42695 0 9.7318 0H10.8506C11.1554 0 11.4478 0.12225 11.6633 0.339855C11.8789 0.557461 12 0.852597 12 1.16034V8.49367C11.998 8.80007 11.876 9.09322 11.6606 9.30916C11.4453 9.52509 11.1541 9.64628 10.8506 9.64627ZM9.7318 0.773558C9.63018 0.773558 9.53273 0.814308 9.46088 0.886843C9.38903 0.959379 9.34866 1.05776 9.34866 1.16034V8.49367C9.34865 8.54411 9.35861 8.59404 9.37796 8.64053C9.3973 8.68703 9.42565 8.72917 9.46133 8.76447C9.49701 8.79977 9.53931 8.82753 9.58575 8.84611C9.6322 8.8647 9.68185 8.87374 9.7318 8.87271H10.8506C10.9509 8.87274 11.0472 8.83305 11.1188 8.76218C11.1905 8.69131 11.2317 8.5949 11.2337 8.49367V1.16034C11.2318 1.05838 11.1908 0.961145 11.1193 0.889035C11.0479 0.816924 10.9516 0.775539 10.8506 0.773558H9.7318Z"
                  fill="white"
                />
              </svg>
              {t("common.ranking")}
            </Link>
          </header>

          <section className="lobbyProfile">
            <span className="lobbyProfileLabel">PLAYER</span>
            <div className="lobbyProfileRow">
              <h2>{player.name}</h2>
            </div>
            <span className="lobbyOfficeBadge">{player.office}</span>
          </section>

          <ScorePanel totalScore={player.totalScore} rank={snapshot.rank} />

          <section className="lobbyGameList">
            {snapshot.state.games.sort((a, b) => a.order - b.order).map((game) => {
              const isBingo = game.key === "bingo";
              const userBingoResult = isBingo
                ? snapshot.results.find((result) => result.gameKey === "bingo")
                : undefined;
              const bingoPending = Boolean(userBingoResult?.pendingBingoScore);

              if (game.key === "quiz") {
                const quizCompleted = quizProgress.completedCount >= quizProgress.totalCount;
                const hasAvailableGroup = quizProgress.availableGroups.length > 0;
                const quizStatus: GameStatusKey = quizCompleted
                  ? "done"
                  : !game.isOpen
                    ? getClosedStatus(game)
                    : hasAvailableGroup
                      ? "continueQuiz"
                      : "gameStarted";

                return (
                  <GameCard
                    game={game}
                    completed={quizCompleted}
                    key={game.key}
                    statusKeyOverride={quizStatus}
                    allowEnterOverride={game.isOpen && !quizCompleted}
                  />
                );
              }

              const completed = player.completedGames.includes(game.key);
              const status = getLobbyGameStatus(game, completed, bingoPending);

              return (
                <GameCard
                  game={game}
                  completed={completed}
                  bingoPending={bingoPending}
                  key={game.key}
                  statusKeyOverride={status}
                  allowEnterOverride={!completed && (game.isOpen || bingoPending)}
                />
              );
            })}
          </section>
        </div>
      </section>
    </Layout>
  );
}
