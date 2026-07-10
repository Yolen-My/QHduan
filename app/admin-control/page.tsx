"use client";

import { useMemo, useState } from "react";
import Layout from "@/components/Layout";
import { GAME_ORDER, GAME_DISPLAY_NAMES } from "@/lib/constants";
import { resetDemoData } from "@/lib/storage";
import { loadStateFromPB } from "@/lib/pb-storage";
import { useAdminActions, useAppState, useAdminStats, useAllQuestions } from "@/hooks/use-game-data";
import type { GameKey } from "@/types";

const QUIZ_SECTOR_COUNT = 5;
const ELIMINATION_MISSION_COUNT = 8;
const STORY_GROUP_COUNT = 2;

function getQuizSessionIndexFromOrder(order: number): number {
  return Math.max(0, Math.min(4, Math.max(1, order) - 1));
}

function getSectorName(index: number, questions: any[]): string {
  return questions.find((question) => question.sectorName)?.sectorName || `Sector ${index + 1}`;
}

function getMissionName(index: number): string {
  return `Mission ${index + 1}`;
}

function getGroupName(index: number): string {
  return `Group ${index + 1}`;
}

export default function AdminControlPage() {
  const { state, refresh } = useAppState();
  const { stats } = useAdminStats();
  const { questions: allQuestions } = useAllQuestions();
  const {
    toggleGameOpen,
    triggerBingoScore,
    closeBingoGame,
    openQuizGroup,
    closeQuizGroup
  } = useAdminActions();
  const [exportText, setExportText] = useState("");

  const completion = useMemo(() => {
    return GAME_ORDER.map((key) => ({
      key,
      count: stats?.resultCounts?.[key] ?? 0
    }));
  }, [stats]);

  // 结果记录总数与参与人数来自 admin 聚合快照(每 2s 轮询)
  const totalResults = useMemo(
    () => (stats ? Object.values(stats.resultCounts).reduce((sum, n) => sum + n, 0) : 0),
    [stats]
  );

  const bingoGame = state.games.find((game) => game.key === "bingo");
  const bingoPhase = bingoGame?.bingoPhase || "open";
  const bingoCompletionCount = completion.find((item) => item.key === "bingo")?.count || 0;
  const pendingBingoCount = stats?.pendingBingo ?? 0;

  const quizGame = state.games.find((game) => game.key === "quiz");
  const quizOpenGroups = quizGame?.quizOpenGroups || [];
  const eliminationGame = state.games.find((game) => game.key === "elimination");
  const eliminationOpenMissions = eliminationGame?.quizOpenGroups || [];
  const storyGame = state.games.find((game) => game.key === "story");
  const storyOpenGroups = storyGame?.quizOpenGroups || [];

  const quizSectors = useMemo(() => {
    const activeQuizQuestions = allQuestions
      .filter((question) => question.gameKey === "quiz" && question.isActive === true)
      .map((question) => ({
        ...question,
        quizSessionIndex: Number.isInteger(question.quizSessionIndex)
          ? question.quizSessionIndex as number
          : getQuizSessionIndexFromOrder(question.order)
      }));

    return Array.from({ length: QUIZ_SECTOR_COUNT }, (_, index) => {
      const questions = activeQuizQuestions
        .filter((question) => question.quizSessionIndex === index)
        .sort((a, b) => a.order - b.order);

      return {
        index,
        sectorName: getSectorName(index, questions),
        questions,
        isOpen: quizOpenGroups.includes(index),
        completedCount: stats?.quizSectorCounts?.[index] ?? 0
      };
    });
  }, [quizOpenGroups, stats, allQuestions]);

  const eliminationMissions = useMemo(() => {
    const activeQuestions = allQuestions
      .filter((question) => question.gameKey === "elimination" && question.isActive === true)
      .sort((a, b) => a.order - b.order)
      .slice(0, ELIMINATION_MISSION_COUNT);

    return Array.from({ length: ELIMINATION_MISSION_COUNT }, (_, index) => ({
      index,
      missionName: getMissionName(index),
      questions: activeQuestions[index] ? [activeQuestions[index]] : [],
      isOpen: eliminationOpenMissions.includes(index),
      completedCount: stats?.resultCounts?.elimination ?? 0
    }));
  }, [eliminationOpenMissions, stats, allQuestions]);

  const storyGroups = useMemo(() => {
    const activeQuestions = allQuestions
      .filter((question) => question.gameKey === "story" && question.isActive === true)
      .sort((a, b) => a.order - b.order)
      .slice(0, STORY_GROUP_COUNT);

    return Array.from({ length: STORY_GROUP_COUNT }, (_, index) => ({
      index,
      groupName: getGroupName(index),
      questions: activeQuestions[index] ? [activeQuestions[index]] : [],
      isOpen: storyOpenGroups.includes(index),
      completedCount: stats?.resultCounts?.story ?? 0
    }));
  }, [storyOpenGroups, stats, allQuestions]);

  async function refreshOnce() {
    await refresh();
  }

  async function handleToggle(key: GameKey) {
    await toggleGameOpen(key);
    await refreshOnce();
    setExportText(`${GAME_DISPLAY_NAMES[key]} 已切换开关状态`);
  }

  async function handleBingoScore() {
    try {
      await triggerBingoScore();
      setExportText(`判分完成，Bingo 已完全关闭。本次结算 ${pendingBingoCount} 名等待用户。`);
      await refreshOnce();
    } catch (error) {
      setExportText(error instanceof Error ? `操作失败：${error.message}` : "操作失败");
    }
  }

  async function handleCloseBingo() {
    try {
      await closeBingoGame();
      setExportText("Bingo 已完全关闭，未完成用户不可再进入。");
      await refreshOnce();
    } catch (error) {
      setExportText(error instanceof Error ? `关闭失败：${error.message}` : "关闭失败");
    }
  }

  async function handleOpenQuizSector(index: number) {
    try {
      await openQuizGroup(index);
      setExportText(`已开启 Sector ${index + 1}`);
      await refreshOnce();
    } catch (error) {
      setExportText(error instanceof Error ? `开启失败：${error.message}` : "开启失败");
    }
  }

  async function handleCloseQuizSector(index: number) {
    try {
      await closeQuizGroup(index);
      setExportText(`已关闭 Sector ${index + 1}`);
      await refreshOnce();
    } catch (error) {
      setExportText(error instanceof Error ? `关闭失败：${error.message}` : "关闭失败");
    }
  }

  async function handleOpenEliminationMission(index: number) {
    try {
      await openQuizGroup(index, "elimination");
      setExportText(`已开启 Mission ${index + 1}`);
      await refreshOnce();
    } catch (error) {
      setExportText(error instanceof Error ? `开启失败：${error.message}` : "开启失败");
    }
  }

  async function handleCloseEliminationMission(index: number) {
    try {
      await closeQuizGroup(index, "elimination");
      setExportText(`已关闭 Mission ${index + 1}`);
      await refreshOnce();
    } catch (error) {
      setExportText(error instanceof Error ? `关闭失败：${error.message}` : "关闭失败");
    }
  }

  async function handleOpenStoryGroup(index: number) {
    try {
      await openQuizGroup(index, "story");
      setExportText(`已开启 Group ${index + 1}`);
      await refreshOnce();
    } catch (error) {
      setExportText(error instanceof Error ? `开启失败：${error.message}` : "开启失败");
    }
  }

  async function handleCloseStoryGroup(index: number) {
    try {
      await closeQuizGroup(index, "story");
      setExportText(`已关闭 Group ${index + 1}`);
      await refreshOnce();
    } catch (error) {
      setExportText(error instanceof Error ? `关闭失败：${error.message}` : "关闭失败");
    }
  }

  async function handleExport() {
    const state = await loadStateFromPB();
    setExportText(JSON.stringify(state, null, 2));
  }

  async function handleReset() {
    await resetDemoData();
    setExportText("");
    await refreshOnce();
  }

  return (
    <Layout title="现场控制台" eyebrow="ADMIN CONTROL">
      <section className="scoreGrid">
        <div>
          <span>参与人数</span>
          <b>{stats?.participantCount ?? 0}</b>
        </div>
        <div>
          <span>结果记录</span>
          <b>{totalResults}</b>
        </div>
        <div>
          <span>等待判分</span>
          <b>{pendingBingoCount}</b>
        </div>
      </section>

      <section className="sectionBlock">
        <h2>游戏开关</h2>
        <div className="adminList">
          {[...state.games].sort((a, b) => a.order - b.order).map((game) => (
            <div className="adminRow" key={game.key}>
              <div>
                <b>{GAME_DISPLAY_NAMES[game.key as GameKey]}</b>
                <span>
                  当前状态：{game.isOpen ? "开放中" : "已关闭"} / 完成人数{" "}
                  {completion.find((item) => item.key === game.key)?.count || 0}
                </span>
              </div>
              <button
                className={game.isOpen ? "primaryButton smallButton" : "secondaryButton smallButton"}
                type="button"
                onClick={() => handleToggle(game.key)}
              >
                {game.isOpen ? "点击关闭" : "点击开启"}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="sectionBlock">
        <h2>Bingo 控制</h2>
        <div className="adminRow" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <b>当前阶段</b>
            <span>
              {bingoPhase === "open" && "正常开放，提交后等待判分"}
              {bingoPhase === "closed" && "已完全关闭，未完成用户不可进入"}
              {" / 完成 "}{bingoCompletionCount}{" 人 / 等待判分 "}{pendingBingoCount}{" 人"}
            </span>
          </div>
        </div>
        <div className="adminRow" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <b>判分并关闭 Bingo</b>
            <span>结算所有等待用户并完全关闭游戏，未完成用户不可再进入</span>
          </div>
          <button
            className="primaryButton smallButton"
            type="button"
            disabled={bingoPhase !== "open"}
            onClick={handleBingoScore}
          >
            {bingoPhase === "open" ? "判分并关闭" : "已关闭"}
          </button>
        </div>
      </section>

      <section className="sectionBlock">
        <h2>猎人快答 控制</h2>
        <div className="adminList" style={{ marginTop: 16 }}>
          {quizSectors.map((sector) => (
            <div key={sector.index} style={{ marginBottom: 16 }}>
              <div className="adminRow" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <b>{sector.sectorName}</b>
                  <span>当前状态：{sector.isOpen ? "已开启" : "未开启"} / 已完成人数：{sector.completedCount}</span>
                </div>
              </div>

              {sector.questions.length > 0 && (
                <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                  {sector.questions.map((question, questionIndex) => (
                    <div key={question.id} style={{ padding: 8, borderRadius: 4, background: "rgba(64, 216, 138, 0.08)", border: "1px solid rgba(64, 216, 138, 0.15)" }}>
                      <span style={{ fontSize: "14px", fontWeight: 600 }}>题目 {questionIndex + 1}：</span>
                      <span style={{ fontSize: "14px", color: "var(--ink)" }}>{question.title}</span>
                    </div>
                  ))}
                </div>
              )}

              {sector.questions.length === 0 && (
                <div style={{ padding: "12px 16px", color: "var(--ink)" }}>
                  <span>暂无题目，请检查 questions 数据是否设置 gameKey=quiz 且 isActive=true。</span>
                </div>
              )}

              <div className="adminRow" style={{ justifyContent: "flex-end", alignItems: "center" }}>
                <div className="pageActions" style={{ marginTop: 0 }}>
                  <button
                    className="primaryButton smallButton"
                    type="button"
                    disabled={sector.isOpen}
                    onClick={() => handleOpenQuizSector(sector.index)}
                  >
                    开启此 Sector
                  </button>
                  <button
                    className="secondaryButton smallButton"
                    type="button"
                    disabled={!sector.isOpen}
                    onClick={() => handleCloseQuizSector(sector.index)}
                  >
                    关闭此 Sector
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="sectionBlock">
        <h2>狼人悍跳 控制</h2>
        <div className="adminList" style={{ marginTop: 16 }}>
          {storyGroups.map((group) => (
            <div key={group.index} style={{ marginBottom: 16 }}>
              <div className="adminRow" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <b>{group.groupName}</b>
                  <span>当前状态：{group.isOpen ? "已开启" : "未开启"} / 已完成人数：{group.completedCount}</span>
                </div>
              </div>

              {group.questions.length > 0 && (
                <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                  {group.questions.map((question) => (
                    <div key={question.id} style={{ padding: 8, borderRadius: 4, background: "rgba(64, 216, 138, 0.08)", border: "1px solid rgba(64, 216, 138, 0.15)" }}>
                      <span style={{ fontSize: "14px", fontWeight: 600 }}>题目：</span>
                      <span style={{ fontSize: "14px", color: "var(--ink)" }}>{question.title}</span>
                    </div>
                  ))}
                </div>
              )}

              {group.questions.length === 0 && (
                <div style={{ padding: "12px 16px", color: "var(--ink)" }}>
                  <span>暂无题目，请检查 questions 数据是否设置 gameKey=story 且 isActive=true。</span>
                </div>
              )}

              <div className="adminRow" style={{ justifyContent: "flex-end", alignItems: "center" }}>
                <div className="pageActions" style={{ marginTop: 0 }}>
                  <button
                    className="primaryButton smallButton"
                    type="button"
                    disabled={group.isOpen}
                    onClick={() => handleOpenStoryGroup(group.index)}
                  >
                    开启此 Group
                  </button>
                  <button
                    className="secondaryButton smallButton"
                    type="button"
                    disabled={!group.isOpen}
                    onClick={() => handleCloseStoryGroup(group.index)}
                  >
                    关闭此 Group
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="sectionBlock">
        <h2>守卫者之夜 控制</h2>
        <div className="adminList" style={{ marginTop: 16 }}>
          {eliminationMissions.map((mission) => (
            <div key={mission.index} style={{ marginBottom: 16 }}>
              <div className="adminRow" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <b>{mission.missionName}</b>
                  <span>当前状态：{mission.isOpen ? "已开启" : "未开启"} / 已完成人数：{mission.completedCount}</span>
                </div>
              </div>

              {mission.questions.length > 0 && (
                <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                  {mission.questions.map((question) => (
                    <div key={question.id} style={{ padding: 8, borderRadius: 4, background: "rgba(64, 216, 138, 0.08)", border: "1px solid rgba(64, 216, 138, 0.15)" }}>
                      <span style={{ fontSize: "14px", fontWeight: 600 }}>题目：</span>
                      <span style={{ fontSize: "14px", color: "var(--ink)" }}>{question.title}</span>
                    </div>
                  ))}
                </div>
              )}

              {mission.questions.length === 0 && (
                <div style={{ padding: "12px 16px", color: "var(--ink)" }}>
                  <span>暂无题目，请检查 questions 数据是否设置 gameKey=elimination 且 isActive=true。</span>
                </div>
              )}

              <div className="adminRow" style={{ justifyContent: "flex-end", alignItems: "center" }}>
                <div className="pageActions" style={{ marginTop: 0 }}>
                  <button
                    className="primaryButton smallButton"
                    type="button"
                    disabled={mission.isOpen}
                    onClick={() => handleOpenEliminationMission(mission.index)}
                  >
                    开启此 Mission
                  </button>
                  <button
                    className="secondaryButton smallButton"
                    type="button"
                    disabled={!mission.isOpen}
                    onClick={() => handleCloseEliminationMission(mission.index)}
                  >
                    关闭此 Mission
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="sectionBlock">
        <h2>数据导出</h2>
        <div className="pageActions">
          <button className="primaryButton" type="button" onClick={handleExport}>
            生成 JSON
          </button>
          <button className="secondaryButton" type="button" onClick={handleReset}>
            重置 DEMO 数据
          </button>
        </div>
        {exportText && <textarea className="exportBox" value={exportText} readOnly />}
      </section>
    </Layout>
  );
}
