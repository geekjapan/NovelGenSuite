import { z } from "zod";

export const DEFAULT_CONFIGURATION = {
  chapterCount: 1,
  chapterLength: 2000,
  requireApproval: false,
} as const;

export const ConfigurationSchema = z.object({
  chapterCount: z.number().int().min(1).max(2).default(DEFAULT_CONFIGURATION.chapterCount),
  chapterLength: z.number().int().positive().default(DEFAULT_CONFIGURATION.chapterLength),
  requireApproval: z.boolean().default(DEFAULT_CONFIGURATION.requireApproval),
});
export type Configuration = z.infer<typeof ConfigurationSchema>;

export const languagePolicies = {
  ja: { locale: "ja-JP" },
} as const;

export const SupportedLanguageSchema = z.enum(["ja"]);
export type SupportedLanguage = z.infer<typeof SupportedLanguageSchema>;

export function findLanguagePolicy(language: string) {
  const result = SupportedLanguageSchema.safeParse(language);
  return result.success ? languagePolicies[result.data] : undefined;
}

export const CreateProjectRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  language: z.string().default("ja"),
  configuration: ConfigurationSchema.default(DEFAULT_CONFIGURATION),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const ProjectStateSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  prompt: z.string().min(1),
  language: SupportedLanguageSchema,
  configuration: ConfigurationSchema,
  meta: z.object({
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  }),
});
export type ProjectState = z.infer<typeof ProjectStateSchema>;

export const ErrorCodeSchema = z.enum([
  "unsupported-language",
  "unsupported-setting",
  "validation-error",
  "project-not-found",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
