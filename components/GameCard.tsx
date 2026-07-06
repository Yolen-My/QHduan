"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, type CSSProperties, type MouseEvent } from "react";
import type { Game, GameKey } from "@/types";

export type GameStatusKey =
  | "done"
  | "open"
  | "closed"
  | "notOpen"
  | "waitingBoss"
  | "waitingOpen"
  | "gameStarted"
  | "continueQuiz";

type GameCardProps = {
  game: Game;
  completed: boolean;
  bingoPending?: boolean;
  subtitle?: string;
  statusKeyOverride?: GameStatusKey;
  allowEnterOverride?: boolean;
};

type IconConfig = {
  src: string;
  width: number;
  height: number;
  right: number;
  offsetY: number;
};

const GAME_ICONS: Record<GameKey, IconConfig> = {
  bingo: { src: "/image/source/lobby/game-bingo.png", width: 72, height: 73, right: 18, offsetY: 10 },
  quiz: { src: "/image/source/lobby/game-quiz.png", width: 89, height: 89, right: 6, offsetY: 8 },
  story: { src: "/image/source/lobby/game-story.png", width: 95, height: 66, right: 6, offsetY: 12 },
  elimination: { src: "/image/source/lobby/game-elimination.png", width: 64, height: 78, right: 22, offsetY: 5 }
};

function getStatusBadgeClass(statusKey: GameStatusKey, canEnter: boolean): string {
  if (statusKey === "done" || statusKey === "closed") return "lobbyGameBadge lobbyGameBadge--done";
  if (!canEnter || statusKey === "waitingOpen" || statusKey === "gameStarted") return "lobbyGameBadge lobbyGameBadge--locked";
  return "lobbyGameBadge";
}

function hasBeenControlled(game: Game): boolean {
  return Boolean(game.created && game.updated && game.created !== game.updated);
}

export default function GameCard({
  game,
  completed,
  bingoPending = false,
  subtitle,
  statusKeyOverride,
  allowEnterOverride
}: GameCardProps) {
  const t = useTranslations();
  const router = useRouter();
  const [entering, setEntering] = useState(false);
  const href = `/game/${game.key}`;
  const icon = GAME_ICONS[game.key];

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (entering) return;
    setEntering(true);
    // 随机抖动 0-1.5s，避免管理员开局后几百人同一秒涌入游戏页面。
    const delay = Math.random() * 1500;
    setTimeout(() => router.push(href), delay);
  };

  let statusKey: GameStatusKey;
  let canEnter: boolean;

  if (statusKeyOverride) {
    statusKey = statusKeyOverride;
    canEnter = Boolean(allowEnterOverride);
  } else if (game.key === "bingo") {
    const phase = game.bingoPhase || "open";
    const controlled = hasBeenControlled(game);
    if (completed) {
      statusKey = "done";
      canEnter = false;
    } else if (bingoPending) {
      statusKey = "waitingBoss";
      canEnter = true;
    } else if (phase === "open" && game.isOpen) {
      statusKey = "open";
      canEnter = true;
    } else if (phase === "auto_score") {
      if (bingoPending) {
        statusKey = "waitingBoss";
        canEnter = true;
      } else {
        statusKey = "closed";
        canEnter = false;
      }
    } else if (phase === "closed") {
      statusKey = "closed";
      canEnter = false;
    } else {
      statusKey = controlled ? "closed" : "notOpen";
      canEnter = false;
    }
  } else {
    const controlled = hasBeenControlled(game);
    if (completed) {
      statusKey = "done";
      canEnter = false;
    } else if (game.isOpen) {
      statusKey = "open";
      canEnter = true;
    } else {
      statusKey = controlled ? "closed" : "notOpen";
      canEnter = false;
    }
  }

  const status = t(`status.${statusKey}`);
  const iconLeft = 104 - icon.width - icon.right;

  const iconStyle = {
    "--icon-width": `${icon.width}px`,
    "--icon-height": `${icon.height}px`,
    "--icon-left": `${iconLeft}px`,
    "--icon-offset-y": `${icon.offsetY}px`
  } as CSSProperties;

  const cardBody = (
    <div className="lobbyGameCard">
      <h3>{t(`game.name.${game.key}`)}</h3>
      <div className="lobbyGameCardMeta">
        <p>{subtitle || t("lobby.maxScore", { score: game.maxScore })}</p>
        <span className={getStatusBadgeClass(statusKey, canEnter)}>{status}</span>
      </div>
    </div>
  );

  const iconLayer = (
    <div className="lobbyGameIcon" style={iconStyle} aria-hidden="true">
      <div className="lobbyGameIconMain">
        <Image src={icon.src} alt="" width={icon.width} height={icon.height} priority={game.order === 1} />
      </div>
      <div className="lobbyGameIconReflection">
        <Image src={icon.src} alt="" width={icon.width} height={icon.height} aria-hidden="true" />
      </div>
    </div>
  );

  const itemClass = [
    "lobbyGameItem",
    completed ? "lobbyGameItem--done" : "",
    !canEnter ? "lobbyGameItem--locked" : ""
  ]
    .filter(Boolean)
    .join(" ");

  if (!canEnter) {
    return (
      <article className={itemClass} aria-disabled="true">
        {cardBody}
        {iconLayer}
      </article>
    );
  }

  return (
    <Link href={href} className={entering ? `${itemClass} lobbyGameItem--entering` : itemClass} onClick={handleClick}>
      {cardBody}
      {iconLayer}
    </Link>
  );
}
