import type { PipelineProjectState } from "./project-state.js";

export type ChapterOperation =
  | { type: "resume" }
  | { type: "retry" | "regenerate"; chapterNumber: number };

export function measuredLength(draft: string, unit: "characters" | "words"): number {
  return unit === "characters"
    ? draft.replace(/\s/g, "").length
    : (draft.trim().match(/\S+/g)?.length ?? 0);
}

export function classifyLength(
  plan: { target: number; min: number; max: number; unit: "characters" | "words" },
  draft: string,
) {
  const length = measuredLength(draft, plan.unit);
  if (length < plan.target * 0.75) return "too-short" as const;
  if (length < plan.min) return "under" as const;
  if (length <= plan.max) return "near" as const;
  return "over" as const;
}

export function hasChapterCoverage(state: PipelineProjectState): boolean {
  return state.bible.chapters.filter(({ draft }) => Boolean(draft?.trim())).length
    >= state.configuration.chapterCount;
}

export function selectChapterNumbers(
  state: PipelineProjectState,
  operation: ChapterOperation,
): number[] {
  const ordered = state.bible.chapters.slice().sort((left, right) => left.number - right.number);
  if (operation.type === "resume") {
    return ordered
      .filter(({ number, draft }) =>
        !draft && state.chapterRuns.find((run) => run.chapterNumber === number)?.status === "pending")
      .map(({ number }) => number);
  }

  const chapter = ordered.find(({ number }) => number === operation.chapterNumber);
  const run = state.chapterRuns.find(({ chapterNumber }) => chapterNumber === operation.chapterNumber);
  if (!chapter || !run) return [];
  if (operation.type === "regenerate") return [chapter.number];
  return run.status === "failed"
    || run.needsExpansion
    || (chapter.draft !== undefined && classifyLength(chapter.lengthPlan, chapter.draft) === "under")
    ? [chapter.number]
    : [];
}
