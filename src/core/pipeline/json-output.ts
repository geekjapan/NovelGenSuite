import type { z } from "zod";

const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i;

function balancedJson(value: string): string | undefined {
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== "{" && value[start] !== "[") continue;
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

export function extractJson(raw: string): unknown {
  const value = fenced.exec(raw)?.[1] ?? raw.trim();
  try {
    return JSON.parse(value);
  } catch {
    const extracted = balancedJson(value);
    if (!extracted) throw new Error("JSON object is missing or incomplete");
    return JSON.parse(extracted);
  }
}

export function parseAgentOutput<T extends z.ZodType>(raw: string, schema: T): z.infer<T> {
  return schema.parse(extractJson(raw));
}
