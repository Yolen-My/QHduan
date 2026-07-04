"use client";

import { useTranslations } from "next-intl";

export default function Home() {
  const t = useTranslations();
  return (
    <main className="landingPage">
      <section className="landingHero">
        <div className="heroMark">HSG</div>
        <span className="eyebrow">ANNUAL GAME </span>
        <h1>
          HSG
          <span>{t("home.brandTitle")}</span>
        </h1>
        <p>{t("home.desc")}</p>
        <a className="primaryButton landingButton" href="/register">
          {t("home.start")}
        </a>
        <div className="landingLinks">
          <a href="/screen">{t("home.screenDemo")}</a>
          <a href="/admin-control">{t("home.adminControl")}</a>
          <a href="/ranking">{t("common.ranking")}</a>
        </div>
      </section>
    </main>
  );
}
