/// <reference path="../pb_data/types.d.ts" />

// 题目按语言返回:请求头 `ua` 决定返回中文还是英文字段。
// 默认（缺省或 zh）返回原始 title/options/correctAnswer；
// `ua: en` 时用英文字段覆盖对应字段。
//
// 字段命名兼容:生产库用 camelCase(titleEn/optionsEn/correctAnswerEn),
// 早期种子库用 snake_case(title_en/...)。这里两种都读,camelCase 优先。
// 无论何种语言,英文辅助字段都不会出现在接口返回中。
onRecordEnrich((e) => {
  try {
    const headers = (e.requestInfo && e.requestInfo.headers) || {};
    const lang = String(headers["ua"] || "zh").toLowerCase();

    if (lang === "en") {
      const titleEn = e.record.get("titleEn") || e.record.get("title_en");
      if (titleEn) {
        e.record.set("title", titleEn);
      }

      const optionsEn = e.record.get("optionsEn");
      const optionsEnSnake = e.record.get("options_en");
      const optsSource = (optionsEn !== null && optionsEn !== undefined && optionsEn !== "") ? optionsEn : optionsEnSnake;
      if (optsSource !== null && optsSource !== undefined && optsSource !== "") {
        e.record.set("options", optsSource);
      }

      const correctEn = e.record.get("correctAnswerEn") || e.record.get("correctAnswer_en");
      if (correctEn !== null && correctEn !== undefined && correctEn !== "") {
        e.record.set("correctAnswer", correctEn);
      }
    }
  } catch (err) {
    // 任意异常都回退到默认（中文），不阻断响应
  }

  // 不向客户端暴露英文辅助字段(两种命名都隐藏)
  e.record.hide("titleEn", "optionsEn", "correctAnswerEn", "title_en", "options_en", "correctAnswer_en");

  e.next();
}, "questions");
