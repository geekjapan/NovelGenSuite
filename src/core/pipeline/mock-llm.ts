import type { AgentId } from "../registry/agent-registry.js";
import type { AgentContext } from "../context/build-context.js";
import { canonicalOutputs } from "../../../test/fixtures/canonical-story.js";

export type GenerateRequest = {
  agentId: AgentId;
  context: AgentContext;
  chapterCount: number;
  chapterNumber?: number;
  compact: boolean;
};

export type Generate = (request: GenerateRequest) => Promise<string>;

const role = (number: number, count: number) => {
  if (number === 1) return "Opening" as const;
  if (number === count) return "Resolution" as const;
  if (number === Math.ceil(count / 2)) return "Climax" as const;
  return "Development" as const;
};

function projectedOutline(count: number) {
  if (count === 2) return canonicalOutputs["chapter-outline"];
  const templates = canonicalOutputs["chapter-outline"].parts[0]!.chapters;
  return {
    ...canonicalOutputs["chapter-outline"],
    parts: [{
      ...canonicalOutputs["chapter-outline"].parts[0]!,
      chapters: Array.from({ length: count }, (_, index) => {
        const number = index + 1;
        const template = templates[index % templates.length]!;
        return {
          ...template,
          number,
          role: role(number, count),
          title: `第${number}章 ${template.title}`,
        };
      }),
    }],
  };
}

function projectedDraft(number: number, count: number) {
  const template = canonicalOutputs.drafting[(number - 1) % canonicalOutputs.drafting.length]!;
  if (count === 2) return template;
  return {
    ...template,
    chapterNumber: number,
    chapterSummary: `第${number}章: ${template.chapterSummary}`,
  };
}

export const generateMock: Generate = async ({ agentId, chapterCount, chapterNumber }) => {
  const output = agentId === "chapter-outline"
    ? projectedOutline(chapterCount)
    : agentId === "drafting"
      ? projectedDraft(chapterNumber!, chapterCount)
      : canonicalOutputs[agentId];
  return JSON.stringify(output);
};
