import { createHmac, randomBytes, randomUUID } from "node:crypto";

import type { AgentId } from "../registry/agent-registry.js";
import { LlmError, sanitizeErrorMessage } from "../llm/openai-client.js";
import type { AgentContext } from "../context/build-context.js";

const fingerprintKey = randomBytes(32);

export type RecoveryDecision = "abort" | "hard" | "deny" | "retry";

export function classifyRecovery(cause: unknown): RecoveryDecision {
  if (cause instanceof Error && cause.name === "AbortError") return "abort";
  if (cause instanceof LlmError && !cause.retryable) return "hard";
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/auth|billing|credit|model.+(?:missing|not found)|invalid.+request|permission|401|402|403|404/i.test(message)) {
    return "deny";
  }
  if (/timeout|timed out|rate.?limit|network|invalid json|parse|schema|408|429|5\d\d/i.test(message)) {
    return "retry";
  }
  return "retry";
}

export const shouldClientRetry = (cause: unknown) => classifyRecovery(cause) === "retry";

export const isOutputQualityFailure = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /invalid json|not valid json|not a json object|did not contain message content|parse|schema|response-size|output.+mismatch/i.test(message);
};

export const shouldProviderSwitch = (cause: unknown) =>
  classifyRecovery(cause) === "retry" && !isOutputQualityFailure(cause) && (
    cause instanceof LlmError
    || /timeout|timed out|rate.?limit|network|408|429|5\d\d/i.test(
      cause instanceof Error ? cause.message : String(cause),
    )
  );

export function actionableError(cause: unknown): string {
  const detail = sanitizeErrorMessage(cause);
  if (/billing|credit|402/i.test(detail)) {
    return `クレジットを追加するか、章長を減らして安価なモデルを選んでください。 (${detail})`;
  }
  if (/token|context.+(?:limit|length)|too long/i.test(detail)) {
    return `章長や入力コンテキストを減らすか、上限の大きいモデルを選んでください。 (${detail})`;
  }
  if (cause instanceof LlmError && cause.kind === "timeout" || /timeout|timed out/i.test(detail)) {
    return `構成を簡素化するか章長を減らして、もう一度実行してください。 (${detail})`;
  }
  if (/auth|401|403/i.test(detail)) {
    return `API 認証情報と権限を確認してください。 (${detail})`;
  }
  return `接続またはモデル設定を確認して、もう一度実行してください。 (${detail})`;
}

export type PipelineLog = (event: string, details: Record<string, unknown>) => void;

export function logParseFailure(
  log: PipelineLog,
  raw: string,
  provider: string,
  classification: string,
  localDebug = false,
) {
  const details: Record<string, unknown> = {
    length: raw.length,
    classification,
    provider,
    correlationId: randomUUID(),
    fingerprint: createHmac("sha256", fingerprintKey).update(raw).digest("hex"),
  };
  if (localDebug) {
    console.warn("LOCAL DEBUG ONLY: raw excerpt must not be persisted, shared, or sent to telemetry", {
      correlationId: details.correlationId,
      rawExcerpt: sanitizeErrorMessage(raw.slice(0, 240)),
    });
  }
  log("pipeline.parse.failure", details);
}

const localized = (language: AgentContext["language"], ja: string, en: string) =>
  language === "ja" ? ja : en;

const person = (value: string) => ({
  name: value,
  role: value,
  desire: value,
  fear: value,
  flaw: value,
  secret: value,
  arc: value,
  speechStyle: value,
});

const roleTitle = (language: AgentContext["language"], role: string, number: number) => {
  const titles: Record<string, [string, string]> = {
    Opening: ["導入", "Opening"],
    Development: ["展開", "Development"],
    Climax: ["山場", "Climax"],
    Resolution: ["結末", "Resolution"],
  };
  const title = titles[role] ?? ["章", "Chapter"];
  return language === "ja" ? `第${number}章 ${title[0]}` : `Chapter ${number}: ${title[1]}`;
};

export function localFallback(
  id: AgentId,
  context: AgentContext,
  chapterNumber?: number,
): unknown {
  const text = localized(context.language, "要確認", "Review required");
  switch (id) {
    case "concept":
      return {
        logline: text,
        coreTheme: text,
        centralConflict: text,
        emotionalPromise: text,
        uniqueHook: text,
      };
    case "character":
      return { protagonist: person(text), antagonist: person(text), supporting: [] };
    case "worldbuilding":
      return { setting: text, rules: [text], socialContext: text, atmosphere: text, locations: [], symbols: [] };
    case "plot":
      return { beginning: text, middle: text, climax: text, ending: text, twists: [], foreshadowingPlan: [] };
    case "chapter-outline": {
      const parts = (context.chapterSkeleton ?? []).map((part) => ({
        ...part,
        chapters: part.chapters.map((chapter) => ({
          ...chapter,
          title: roleTitle(context.language, chapter.role, chapter.number),
          purpose: localized(context.language, `${chapter.role}の役割を具体化する`, `Develop the ${chapter.role} role`),
          emotionalTurn: text,
          keyEvents: [text],
          foreshadowing: [],
        })),
      }));
      return {
        parts,
        styleGuide: {
          pov: text,
          tense: text,
          proseStyle: text,
          dialogueNotes: text,
          taboos: [],
        },
        foreshadowingTracker: [],
      };
    }
    case "drafting":
      return { chapterNumber, draft: text, chapterSummary: text, continuityNotes: [text] };
    case "editor":
      return { strengths: [], weakPoints: [text], pacing: [text], dialogue: [text], emotionalClarity: [text], revisionSuggestions: [text] };
    case "continuity":
      return { issues: [], unresolvedForeshadowing: [], missingPayoffs: [], overallAssessment: text };
    case "publisher":
      return { titleIdeas: [text], shortSynopsis: text, longSynopsis: text, logline: text, tagline: text, socialPosts: [], submissionDescription: text };
  }
}
