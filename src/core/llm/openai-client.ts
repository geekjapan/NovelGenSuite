import { generateMock, type Generate } from "../pipeline/mock-llm.js";
import { buildPrompt } from "../prompts/prompts.js";

export const DEFAULT_OPENAI_BASE_URL = "http://127.0.0.1:20128/v1";

// 呼び出し側 signal が無い場合の保険。ローカル LLM の長い章生成を誤殺しない値に留める
const DEFAULT_TIMEOUT_MS = 600_000;

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly kind: "provider" | "timeout" = "provider",
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export function sanitizeErrorMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/\b(?:sk|token)[-_][A-Za-z0-9._-]+\b/gi, "[redacted]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+(?::\d+(?::\d+)?)?/g, "[redacted]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)+[^\s:]*/g, "[redacted]")
    .slice(0, 280);
}

export function shouldCompactRetry(cause: unknown): boolean {
  if (cause instanceof LlmError) return cause.retryable;
  return !(cause instanceof Error && cause.name === "AbortError");
}

type OpenAIOptions = {
  baseUrl?: string;
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
};

const httpError = (status: number) => {
  if (status === 401 || status === 403) return new LlmError("OpenAI authentication failed", false);
  if (status === 402) return new LlmError("OpenAI billing or credit check failed", false);
  return new LlmError(
    `OpenAI request failed with status ${status}`,
    status === 408 || status === 429 || status >= 500,
  );
};

export function createOpenAIGenerate(options: OpenAIOptions): Generate {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const endpoint = `${(options.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "")}/chat/completions`;

  return async (request) => {
    const prompt = buildPrompt(request);
    const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
        }),
        signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "TimeoutError") {
        throw new LlmError("OpenAI request timed out", true, "timeout");
      }
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new LlmError("OpenAI request aborted", false);
      }
      throw new LlmError(sanitizeErrorMessage(cause), true);
    }
    if (!response.ok) throw httpError(response.status);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LlmError("OpenAI response was not valid JSON", true);
    }
    if (payload === null || typeof payload !== "object") {
      throw new LlmError("OpenAI response was not a JSON object", true);
    }
    const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
      .choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new LlmError("OpenAI response did not contain message content", true);
    }
    return content;
  };
}

export function createGenerateFromEnv(
  suppliedEnv?: Readonly<Record<string, string | undefined>>,
): Generate {
  if (!suppliedEnv) {
    try {
      process.loadEnvFile();
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  const env = suppliedEnv ?? process.env;
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return generateMock;
  const model = env.NOVELGEN_MODEL?.trim();
  if (!model) throw new LlmError("NOVELGEN_MODEL is required when OPENAI_API_KEY is set", false);
  return createOpenAIGenerate({
    apiKey,
    model,
    baseUrl: env.NOVELGEN_OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL,
  });
}
