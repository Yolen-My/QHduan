/// <reference path="../pb_data/types.d.ts" />

// 题目按语言返回：请求头 `ua` 决定返回中文还是英文字段。
// 默认（缺省或 zh）返回原始 title/options/correctAnswer；
// `ua: en` 时用 titleEn / optionsEn / correctAnswer_en 覆盖对应字段。
// 无论何种语言，*_en 辅助字段都不会出现在接口返回中。
onRecordEnrich((e) => {
  try {
    const headers = (e.requestInfo && e.requestInfo.headers) || {};
    const lang = String(headers["ua"] || "zh").toLowerCase();

    if (lang === "en") {
      const titleEn = e.record.get("titleEn") || e.record.get("title_en");
      if (titleEn) {
        e.record.set("title", titleEn);
      }

      const optionsEn = e.record.get("optionsEn") || e.record.get("options_en");
      if (optionsEn !== null && optionsEn !== undefined && optionsEn !== "") {
        e.record.set("options", optionsEn);
      }

      const correctEn = e.record.get("correctAnswer_en") || e.record.get("correctAnswerEn");
      if (correctEn !== null && correctEn !== undefined && correctEn !== "") {
        e.record.set("correctAnswer", correctEn);
      }
    }
  } catch (err) {
    // 任意异常都回退到默认（中文），不阻断响应
  }

  // 永远不向客户端暴露 *_en 辅助字段
  e.record.hide("titleEn", "title_en", "optionsEn", "options_en", "correctAnswer_en", "correctAnswerEn");

  e.next();
}, "questions");
