import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PipelineProjectState } from "./project-state.js";

const bullets = (values: string[]) => values.map((value) => `- ${value}`).join("\n") || "- なし";

export function rebuildManuscript(state: PipelineProjectState): string {
  return state.bible.chapters
    .slice()
    .sort((left, right) => left.number - right.number)
    .map(({ title, draft }) => `# ${title}\n\n${draft}`)
    .join("\n\n");
}

export async function writeArtifacts(root: string, state: PipelineProjectState): Promise<void> {
  const editor = state.bible.editorReport!;
  const continuity = state.bible.continuityReport!;
  const publisher = state.bible.publisherPackage!;
  const files = {
    "manuscript.md": state.manuscript!,
    "editor-report.md": `# 編集レポート\n\n## 強み\n\n${bullets(editor.strengths)}\n\n## 弱点\n\n${bullets(editor.weakPoints)}\n\n## 改稿案\n\n${bullets(editor.revisionSuggestions)}\n`,
    "continuity-report.md": `# 連続性レポート\n\n${continuity.overallAssessment}\n\n## 問題\n\n${bullets(continuity.issues.map(({ description }) => description))}\n`,
    "publisher-report.md": `# 出版レポート\n\n## 題名案\n\n${bullets(publisher.titleIdeas)}\n\n## ログライン\n\n${publisher.logline}\n\n## あらすじ\n\n${publisher.longSynopsis}\n`,
  };
  await Promise.all(Object.entries(files).map(([name, contents]) =>
    writeFile(join(root, state.id, name), contents, "utf8")));
}
