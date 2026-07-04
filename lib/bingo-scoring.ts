import { calculateBingoScore } from "@/lib/scoring";
import type { Question } from "@/types";

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function isBingoCorrectQuestion(question: Question): boolean {
  return question.gameKey === "bingo" && typeof question.correctAnswer === "string" && question.correctAnswer === question.title;
}

export function getBingoTargetWords(questions: Question[]): string[] {
  return questions.filter(isBingoCorrectQuestion).map((question) => question.title);
}

export function calculateBingoSelection(
  questions: Question[],
  answers: Record<string, unknown>,
  fallbackScore = 0
): {
  selectedWords: string[];
  targetWords: string[];
  correctCount: number;
  score: number;
} {
  const bingoQuestions = questions.filter((question) => question.gameKey === "bingo");
  const selectedQuestionIds = asStringArray(answers.selectedQuestionIds);
  const selectedQuestions = selectedQuestionIds
    .map((id) => bingoQuestions.find((question) => question.id === id))
    .filter((question): question is Question => Boolean(question));

  const selectedWords = selectedQuestions.length > 0
    ? selectedQuestions.map((question) => question.title)
    : asStringArray(answers.selectedWords);
  const targetWords = getBingoTargetWords(bingoQuestions);

  const correctCount = selectedQuestions.length > 0
    ? selectedQuestions.filter(isBingoCorrectQuestion).length +
      (selectedQuestions.length === 9 && selectedQuestions.every(isBingoCorrectQuestion) ? 1 : 0)
    : selectedWords.filter((word) => targetWords.includes(word)).length +
      (selectedWords.length === 9 && selectedWords.every((word) => targetWords.includes(word)) ? 1 : 0);

  const score = selectedWords.length === 0 && selectedQuestions.length === 0
    ? Math.max(0, Math.min(100, Math.round(fallbackScore)))
    : Math.max(0, Math.min(100, Math.round(calculateBingoScore(correctCount))));

  return { selectedWords, targetWords, correctCount, score };
}
