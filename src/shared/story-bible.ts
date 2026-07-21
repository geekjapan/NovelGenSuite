import { z } from "zod";

import {
  ChapterSchema,
  CharacterOutputSchema,
  ConceptOutputSchema,
  EditorOutputSchema,
  ForeshadowingTrackerItemSchema,
  PartSchema,
  PlotOutputSchema,
  PublisherOutputSchema,
  StyleGuideSchema,
  WorldbuildingOutputSchema,
  ContinuityOutputSchema,
} from "./agent-schemas.js";

export const StoryBibleSchema = z.object({
  concept: ConceptOutputSchema.nullable(),
  theme: z.string().nullable(),
  characters: CharacterOutputSchema.nullable(),
  worldbuilding: WorldbuildingOutputSchema.nullable(),
  plot: PlotOutputSchema.nullable(),
  parts: z.array(PartSchema),
  chapters: z.array(ChapterSchema),
  styleGuide: StyleGuideSchema.nullable(),
  foreshadowingTracker: z.array(ForeshadowingTrackerItemSchema),
  editorReport: EditorOutputSchema.nullable(),
  continuityReport: ContinuityOutputSchema.nullable(),
  publisherPackage: PublisherOutputSchema.nullable(),
});

export type StoryBible = z.infer<typeof StoryBibleSchema>;

export const emptyStoryBible = (): StoryBible => ({
  concept: null,
  theme: null,
  characters: null,
  worldbuilding: null,
  plot: null,
  parts: [],
  chapters: [],
  styleGuide: null,
  foreshadowingTracker: [],
  editorReport: null,
  continuityReport: null,
  publisherPackage: null,
});
