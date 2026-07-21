import type { z } from "zod";

import {
  ChapterOutlineOutputSchema,
  CharacterOutputSchema,
  ConceptOutputSchema,
  ContinuityOutputSchema,
  DraftingOutputSchema,
  EditorOutputSchema,
  PlotOutputSchema,
  PublisherOutputSchema,
  WorldbuildingOutputSchema,
  type Chapter,
  type ChapterOutlineOutput,
  type DraftingOutput,
} from "../../shared/agent-schemas.js";
import type { StoryBible } from "../../shared/story-bible.js";
import {
  buildChapterOutlineContext,
  buildCharacterContext,
  buildConceptContext,
  buildContinuityContext,
  buildDraftingContext,
  buildEditorContext,
  buildPlotContext,
  buildPublisherContext,
  buildWorldbuildingContext,
  type AgentContext,
  type BuildContextInput,
} from "../context/build-context.js";

type Definition = {
  id: string;
  schema: z.ZodType;
  buildContext: (input: BuildContextInput) => AgentContext;
  normalize: (output: unknown) => unknown;
  merge: (bible: StoryBible, output: never) => StoryBible;
};

const isPlaceholderTitle = (title: string, number: number) =>
  title === `第${number}章` || title === "（未定）";

const mergeChapterOutline = (
  bible: StoryBible,
  output: ChapterOutlineOutput,
): StoryBible => {
  const parts = bible.parts.length === 0 ? output.parts : bible.parts.map((protectedPart, partIndex) => {
    const proposedPart = output.parts[partIndex];
    return {
      ...protectedPart,
      title: proposedPart?.title ?? protectedPart.title,
      chapters: protectedPart.chapters.map((protectedChapter, chapterIndex): Chapter => {
      const chapter = proposedPart?.chapters.find(({ number }) => number === protectedChapter.number)
        ?? proposedPart?.chapters[chapterIndex];
      if (!chapter) return protectedChapter;
      return {
        ...chapter,
        id: protectedChapter.id,
        partNumber: protectedChapter.partNumber,
        number: protectedChapter.number,
        role: protectedChapter.role,
        title: isPlaceholderTitle(protectedChapter.title, protectedChapter.number)
          ? chapter.title
          : protectedChapter.title,
        lengthPlan: protectedChapter.lengthPlan,
        draft: protectedChapter.draft,
        chapterSummary: protectedChapter.chapterSummary,
        continuityNotes: protectedChapter.continuityNotes,
        needsRevision: protectedChapter.needsRevision,
      };
      }),
    };
  });
  return {
    ...bible,
    parts,
    chapters: parts.flatMap(({ chapters }) => chapters).sort((a, b) => a.number - b.number),
    styleGuide: output.styleGuide,
    foreshadowingTracker: output.foreshadowingTracker,
  };
};

const mergeDraft = (bible: StoryBible, output: DraftingOutput): StoryBible => {
  const update = (chapter: Chapter): Chapter => chapter.number === output.chapterNumber
    ? {
        ...chapter,
        draft: output.draft,
        chapterSummary: output.chapterSummary,
        continuityNotes: output.continuityNotes,
      }
    : chapter;
  return {
    ...bible,
    parts: bible.parts.map((part) => ({
      ...part,
      chapters: part.chapters.map(update),
    })),
    chapters: bible.chapters.map(update),
  };
};

export const agentDefinitions = [
  {
    id: "concept",
    schema: ConceptOutputSchema,
    buildContext: buildConceptContext,
    normalize: (output: unknown) => ConceptOutputSchema.parse(output),
    merge: (bible: StoryBible, output: ReturnType<typeof ConceptOutputSchema.parse>) => ({
      ...bible,
      concept: output,
      theme: output.coreTheme,
    }),
  },
  {
    id: "character",
    schema: CharacterOutputSchema,
    buildContext: buildCharacterContext,
    normalize: (output: unknown) => CharacterOutputSchema.parse(output),
    merge: (bible: StoryBible, output: ReturnType<typeof CharacterOutputSchema.parse>) => ({
      ...bible,
      characters: output,
    }),
  },
  {
    id: "worldbuilding",
    schema: WorldbuildingOutputSchema,
    buildContext: buildWorldbuildingContext,
    normalize: (output: unknown) => WorldbuildingOutputSchema.parse(output),
    merge: (bible: StoryBible, output: ReturnType<typeof WorldbuildingOutputSchema.parse>) => ({
      ...bible,
      worldbuilding: output,
    }),
  },
  {
    id: "plot",
    schema: PlotOutputSchema,
    buildContext: buildPlotContext,
    normalize: (output: unknown) => PlotOutputSchema.parse(output),
    merge: (bible: StoryBible, output: ReturnType<typeof PlotOutputSchema.parse>) => ({
      ...bible,
      plot: output,
    }),
  },
  {
    id: "chapter-outline",
    schema: ChapterOutlineOutputSchema,
    buildContext: buildChapterOutlineContext,
    normalize: (output: unknown) => ChapterOutlineOutputSchema.parse(output),
    merge: mergeChapterOutline,
  },
  {
    id: "drafting",
    schema: DraftingOutputSchema,
    buildContext: buildDraftingContext,
    normalize: (output: unknown) => DraftingOutputSchema.parse(output),
    merge: mergeDraft,
  },
  {
    id: "editor",
    schema: EditorOutputSchema,
    buildContext: buildEditorContext,
    normalize: (output: unknown) => EditorOutputSchema.parse(output),
    merge: (bible: StoryBible, output: ReturnType<typeof EditorOutputSchema.parse>) => ({
      ...bible,
      editorReport: output,
    }),
  },
  {
    id: "continuity",
    schema: ContinuityOutputSchema,
    buildContext: buildContinuityContext,
    normalize: (output: unknown) => ContinuityOutputSchema.parse(output),
    merge: (bible: StoryBible, output: ReturnType<typeof ContinuityOutputSchema.parse>) => ({
      ...bible,
      continuityReport: output,
    }),
  },
  {
    id: "publisher",
    schema: PublisherOutputSchema,
    buildContext: buildPublisherContext,
    normalize: (output: unknown) => PublisherOutputSchema.parse(output),
    merge: (bible: StoryBible, output: ReturnType<typeof PublisherOutputSchema.parse>) => ({
      ...bible,
      publisherPackage: output,
    }),
  },
] as const;

export type AgentId = typeof agentDefinitions[number]["id"];

export function mergeAgentOutput(
  bible: StoryBible,
  id: AgentId,
  rawOutput: unknown,
): StoryBible {
  const definition = agentDefinitions.find((candidate) => candidate.id === id) as Definition;
  return definition.merge(bible, definition.normalize(rawOutput) as never);
}
