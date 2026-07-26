import { z } from "zod";

import { StoryBibleSchema, emptyStoryBible } from "../../shared/story-bible.js";
import { findLanguagePolicy, ProjectStateSchema } from "../../shared/contracts.js";
import { agentDefinitions, type AgentId } from "../registry/agent-registry.js";

const CancellationAttemptSchema = z.object({
  type: z.literal("cancellation"),
  operation: z.enum(["resume", "retry", "regenerate", "auto-expand"]),
  attemptedAt: z.iso.datetime(),
});

const AgentRunSchema = z.object({
  id: z.enum(agentDefinitions.map(({ id }) => id) as [AgentId, ...AgentId[]]),
  status: z.enum(["pending", "running", "completed", "failed"]),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  error: z.string().optional(),
  attempts: z.array(CancellationAttemptSchema).optional(),
});

const ChapterRunSchema = z.object({
  chapterNumber: z.number().int().positive(),
  status: z.enum(["pending", "generating", "completed", "failed", "edited"]),
  lengthStatus: z.enum(["too-short", "under", "near", "over"]).optional(),
  needsExpansion: z.boolean().optional(),
  error: z.string().optional(),
  attempts: z.array(CancellationAttemptSchema).optional(),
});

export const PipelineProjectStateSchema = ProjectStateSchema.extend({
  bible: StoryBibleSchema,
  agents: z.array(AgentRunSchema),
  chapterRuns: z.array(ChapterRunSchema),
  completedOutputs: z.record(z.string(), z.unknown()),
  manuscript: z.string().nullable(),
});

export type PipelineProjectState = z.infer<typeof PipelineProjectStateSchema>;

const chapterRole = (number: number, count: number) => {
  if (number === 1) return "Opening" as const;
  if (number === count) return "Resolution" as const;
  if (number === Math.ceil(count / 2)) return "Climax" as const;
  return "Development" as const;
};

export function initializePipelineState(
  input: z.input<typeof ProjectStateSchema>,
): PipelineProjectState {
  const state = ProjectStateSchema.parse(input);
  const { chapterCount, chapterLength } = state.configuration;
  const unit = findLanguagePolicy(state.language)!.lengthUnit;
  const chapters = Array.from({ length: chapterCount }, (_, index) => {
    const number = index + 1;
    return {
      id: `chapter-${number}`,
      partNumber: 1,
      number,
      role: chapterRole(number, chapterCount),
      title: `第${number}章`,
      purpose: `第${number}章の目的`,
      emotionalTurn: "",
      keyEvents: [],
      foreshadowing: [],
      lengthPlan: {
        target: chapterLength,
        unit,
        min: Math.max(1, Math.floor(chapterLength * 0.85)),
        max: Math.ceil(chapterLength * 1.15),
      },
    };
  });
  const bible = emptyStoryBible();
  bible.parts = [{ id: "part-1", number: 1, title: "第一部", chapters }];
  bible.chapters = chapters;

  return PipelineProjectStateSchema.parse({
    ...state,
    bible,
    agents: agentDefinitions.map(({ id }) => ({ id, status: "pending" })),
    chapterRuns: chapters.map(({ number }) => ({ chapterNumber: number, status: "pending" })),
    completedOutputs: {},
    manuscript: null,
  });
}
