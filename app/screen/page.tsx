"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import OfficeAverageTable from "@/components/OfficeAverageTable";
import OfficeTop3Panel from "@/components/OfficeTop3Panel";
import RankingTable from "@/components/RankingTable";
import { useRanking } from "@/hooks/use-game-data";

export default function ScreenPage() {
  const t = useTranslations();
  const { ranking, loading } = useRanking(null, 3000);

  return (
    <main className="screenPage">
      <div className="screenPageBg" aria-hidden="true">
        <Image
          className="screenPageBgImage"
          src="/image/source/screen/page-bg.png"
          alt=""
          fill
          priority
          sizes="100vw"
        />
        <div className="screenPageBgGradient" />
      </div>

      <div className="screenPageContent">
        <div className="screenPageInner">
        <header className="screenHeader">
          <div className="screenHeaderMain">
            <span className="screenEyebrow">LIVE SCREEN </span>
            <div className="screenTitleRow">
              <h1 className="screenTitle">{t("screen.title")}</h1>
              <Image
                className="screenLogo"
                src="/image/source/screen/logo-icon.png"
                alt=""
                width={79}
                height={79}
                priority
              />
            </div>
            <p className="screenParticipantCount">
              <strong>{loading || !ranking ? "—" : ranking.players.length || 0}</strong>
              <span>{t("screen.participants")}</span>
            </p>
          </div>

          <div className="screenQrBlock">
            <div className="screenQrRow">
              <Image
                className="screenDefineLogo"
                src="/image/source/screen/screen-define-the-game.png"
                alt="Define The Game"
                width={218}
                height={132}
                priority
              />
              <div className="screenQrWithText">
                <div className="screenQrFrame">
                  <Image
                    className="screenQrImage"
                    src="/image/source/screen/qr-code.png"
                    alt={t("screen.qrAlt")}
                    width={136}
                    height={136}
                    priority
                  />
                </div>
                <p className="screenQrText">
                  <span>{t("screen.scanZh")}</span>
                  <span className="screenQrTextEn">{t("screen.scanEn")}</span>
                </p>
              </div>
            </div>
          </div>
          
        </header>

        {loading || !ranking ? (
          <div className="screenLoading">
            <div className="loadingSpinner">
              <div className="spinner"></div>
              <p>{t("screen.loading")}</p>
            </div>
          </div>
        ) : (
          <section className="screenGrid">
            <section className="screenPanel top10Panel">
              <div className="screenPanelHeader">
                <h2 className="screenPanelTitle">
                  <span>{t("screen.overallZh")}</span>
                  <span className="screenPanelTitleEn">{t("screen.overallEn")}</span>
                </h2>
                <Image
                  className="screenTop10Watermark"
                  src="/image/source/ranking/top10-watermark.png"
                  alt=""
                  width={163}
                  height={40}
                  aria-hidden="true"
                />
              </div>
              <RankingTable data={ranking.top10 || []} variant="ranking" bilingual />
            </section>

            <div className="screenSideColumn">
              <section className="screenPanel">
                <h2 className="screenPanelTitle">
                  <span>{t("screen.avgZh")}</span>
                  <span className="screenPanelTitleEn">{t("screen.avgEn")}</span>
                </h2>
                <OfficeAverageTable data={ranking.officeAverage || []} variant="ranking" bilingual />
              </section>

              <section className="screenPanel">
                <h2 className="screenPanelTitle">
                  <span>{t("screen.top3Zh")}</span>
                  <span className="screenPanelTitleEn">{t("screen.top3En")}</span>
                </h2>
                <OfficeTop3Panel data={ranking.officeTop3 || []} variant="ranking" bilingual />
              </section>
            </div>
          </section>
        )}
        </div>
      </div>
    </main>
  );
}
