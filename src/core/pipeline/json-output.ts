import { runInNewContext } from "node:vm";

import type { z } from "zod";

const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i;

// 開始候補の走査は各試行が O(N) のため、無制限だと不正入力で O(N^2) に達しうる
const MAX_START_ATTEMPTS = 10;

export class JsonParseTimeoutError extends RangeError {
  constructor() {
    super("parse-timeout");
  }
}

function parseJson(value: string, timeoutMs?: number): unknown {
  if (timeoutMs === undefined) return JSON.parse(value);
  if (timeoutMs <= 0) throw new JsonParseTimeoutError();
  try {
    return runInNewContext("JSON.parse(value)", { value }, { timeout: timeoutMs });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new JsonParseTimeoutError();
    }
    throw cause;
  }
}

function balancedJson(value: string): string | undefined {
  let attempts = 0;
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== "{" && value[start] !== "[") continue;
    if (++attempts > MAX_START_ATTEMPTS) break;
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const character = value[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{" || character === "[") stack.push(character);
      else if (character === "}" || character === "]") {
        const opening = stack.pop();
        if ((opening === "{" && character !== "}") || (opening === "[" && character !== "]")) break;
        if (stack.length === 0) return value.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

export function extractJson(raw: string, timeoutMs?: number): unknown {
  const value = fenced.exec(raw)?.[1] ?? raw.trim();
  try {
    return parseJson(value, timeoutMs);
  } catch (cause) {
    if (cause instanceof JsonParseTimeoutError) throw cause;
    const extracted = balancedJson(value);
    if (!extracted) throw new Error("JSON object is missing or incomplete");
    return parseJson(extracted, timeoutMs);
  }
}

export function parseAgentOutput<T extends z.ZodType>(raw: string, schema: T): z.infer<T> {
  return schema.parse(extractJson(raw));
}
