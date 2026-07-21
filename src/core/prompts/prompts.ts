import { agentDefinitions, type AgentId } from "../registry/agent-registry.js";
import type { GenerateRequest } from "../pipeline/mock-llm.js";

export const promptAgentIds = agentDefinitions.map(({ id }) => id);

const system = [
  "Return valid JSON only.",
  "Do not use markdown, code fences, explanations, or comments.",
  "Close every quote and bracket.",
  "All JSON keys must be English. All creative text values must be Japanese.",
].join(" ");

const instructions: Record<AgentId, string> = {
  concept: "物語の核を設計する。logline, coreTheme, centralConflict, emotionalPromise, uniqueHook を文字列で返す。",
  character: "人物を設計する。protagonist, antagonist, supporting を返す。supporting は人物の配列とする。各人物は name, role, desire, fear, flaw, secret, arc, speechStyle を持つ。",
  worldbuilding: "舞台を設計する。setting, rules, socialContext, atmosphere, locations, symbols を返す。",
  plot: "物語展開を設計する。beginning, middle, climax, ending, twists, foreshadowingPlan を返す。foreshadowingPlan の各項目は item, introduction, payoff を持つ。",
  "chapter-outline": [
    "章構成の決定済みスケルトンを文章で補完する。",
    "parts, styleGuide, foreshadowingTracker を返す。",
    "parts は配列とし、各章は title, purpose, emotionalTurn, keyEvents, foreshadowing も必ず含む。keyEvents と foreshadowing は配列とする。",
    "スケルトンの id, partNumber, number, role, lengthPlan must not change id, partNumber, number, role, or lengthPlan.",
    "章では title, purpose, emotionalTurn, keyEvents(最大2), foreshadowing(最大1)だけを補完し、各文字列は120字以内。",
    "styleGuide は必須オブジェクトで pov, tense, proseStyle, dialogueNotes, taboos(配列) を持つ。",
    "foreshadowingTracker は配列(空も可)で、最大3件の各項目は item, introducedIn, status, suggestedPayoff, payoffChapter, emotionalPurpose を持つ。introducedIn は整数、payoffChapter は整数または null、status は planned, unresolved, paid-off のどれかとする。",
  ].join(" "),
  drafting: "対象章を執筆する。chapterNumber, draft, chapterSummary, continuityNotes だけを返し、continuityNotes は文字列の配列(空も可)とする。既存の前提と連続性を守る。",
  editor: "原稿を編集評価する。strengths, weakPoints, pacing, dialogue, emotionalClarity, revisionSuggestions を配列で返す。",
  continuity: "連続性を監査する。issues, unresolvedForeshadowing, missingPayoffs, overallAssessment を返す。issues は配列(空も可)で、各項目は category, severity, chapterNumber, description, suggestion を持つ。category は character, world, plot, time, foreshadowing のどれか、severity は low, medium, high のどれか、chapterNumber は整数または null とする。unresolvedForeshadowing と missingPayoffs は文字列の配列とする。",
  publisher: "出版用素材を作る。titleIdeas, shortSynopsis, longSynopsis, logline, tagline, socialPosts, submissionDescription を返す。",
};

const compactContext = (request: GenerateRequest) => {
  const { chapterSkeleton: _skeleton, ...context } = request.context;
  const serialized = JSON.stringify(context);
  return request.compact && serialized.length > 500
    ? `${serialized.slice(0, 300)}…省略…${serialized.slice(-200)}`
    : serialized;
};

export function buildPrompt(request: GenerateRequest) {
  return {
    system,
    user: [
      `ROLE=${request.agentId}`,
      request.compact ? "COMPACT RETRY: 最小限の短いJSONで契約を満たす。" : "",
      instructions[request.agentId],
      request.agentId === "chapter-outline"
        ? `SKELETON=${JSON.stringify(request.context.chapterSkeleton)}`
        : "",
      `CONTEXT=${compactContext(request)}`,
    ].filter(Boolean).join("\n"),
  };
}
