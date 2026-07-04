"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import Layout from "@/components/Layout";
import OfficeAverageTable from "@/components/OfficeAverageTable";
import OfficeTop3Panel from "@/components/OfficeTop3Panel";
import RankingTable from "@/components/RankingTable";
import { GAME_ORDER } from "@/lib/constants";
import { useCurrentPlayer, useLobbySnapshot, useRanking } from "@/hooks/use-game-data";

export default function ResultPage() {
  const router = useRouter();
  const t = useTranslations();
  const { player, playerId, loading: playerLoading } = useCurrentPlayer();
  const { snapshot, loading: snapshotLoading } = useLobbySnapshot(playerId);
  const { ranking, loading: rankingLoading } = useRanking(playerId, 1500);

  useEffect(() => {
    if (playerId === null) router.replace("/register");
  }, [playerId, router]);

  const rankedPlayer = playerId ? ranking.players.find((item) => item.id === playerId) : null;
  const currentPlayer = snapshot?.player || player || rankedPlayer || null;
  const currentRank = ranking.context?.rank || (currentPlayer ? ranking.players.findIndex((item) => item.id === currentPlayer.id) + 1 : 0);
  const playerResults = snapshot?.results || (playerId ? ranking.results.filter((result) => result.player === playerId) : []);
  const lastResult = playerResults
    .slice()
    .sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())[0];
  const roundScore = lastResult?.score || 0;
  const missingGames = currentPlayer ? GAME_ORDER.filter((key) => !currentPlayer.completedGames.includes(key)) : [];
  const isLoading = playerId === undefined || (playerLoading && snapshotLoading && rankingLoading);

  if (!currentPlayer) {
    return (
      <Layout title={t("result.title")} eyebrow="RESULT">
        <section className="statusBanner">{isLoading ? t("result.loadingResult") : t("result.notFound")}</section>
      </Layout>
    );
  }

  return (
    <Layout title={t("result.title")} eyebrow="RESULT" rightSlot={<Link href="/ranking">{t("result.rankingShort")}</Link>}>
      <section className="profileCard resultHero" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <div>
            <span className="eyebrow">TOTAL SCORE</span>
            <h2 style={{ fontSize: '48px', margin: '8px 0' }}>{currentPlayer.totalScore}</h2>
          </div>
          <strong style={{ fontSize: '32px' }}>#{currentRank || "-"}</strong>
        </div>
        <p style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>{currentPlayer.name} / {currentPlayer.office} / {currentPlayer.team}</p>
      </section>

      {missingGames.length > 0 && (
        <section className="statusBanner">
          {t("result.missingGames", { count: missingGames.length })}
        </section>
      )}

      {ranking.context?.distanceToTop10 !== null && ranking.context?.distanceToTop10 !== undefined && (
        <section className="statusPanel">
          <b>{t("result.gapToTop10", { gap: ranking.context.distanceToTop10 })}</b>
          <span>
            {t("result.prevPlayer", { name: ranking.context.previousPlayer?.name || "-", gap: ranking.context.distanceToPrevious || 0 })}
          </span>
        </section>
      )}

      <section className="sectionBlock">
        <h2>{t("result.top10")}</h2>
        <RankingTable data={ranking.top10} currentPlayerId={currentPlayer.id} />
      </section>

      <section className="sectionBlock">
        <h2>{t("result.officeAverage")}</h2>
        <OfficeAverageTable data={ranking.officeAverage} />
      </section>

      <section className="sectionBlock">
        <h2>{t("result.officeTop3")}</h2>
        <OfficeTop3Panel data={ranking.officeTop3} />
      </section>
    </Layout>
  );
}
