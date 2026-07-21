import type { PipelineProjectState } from "./project-state.js";

const bullets = (values: string[]) => values.map((value) => `- ${value}`).join("\n") || "- なし";

export function rebuildManuscript(state: PipelineProjectState): string {
  return state.bible.chapters
    .slice()
    .sort((left, right) => left.number - right.number)
    .map(({ title, draft }) => `# ${title}\n\n${draft}`)
    .join("\n\n");
}

export function renderArtifacts(state: PipelineProjectState): Record<string, string> {
  const editor = state.bible.editorReport!;
  const continuity = state.bible.continuityReport!;
  const publisher = state.bible.publisherPackage!;
  return {
    "manuscript.md": state.manuscript!,
    "editor-report.md": `# 編集レポート\n\n## 強み\n\n${bullets(editor.strengths)}\n\n## 弱点\n\n${bullets(editor.weakPoints)}\n\n## 改稿案\n\n${bullets(editor.revisionSuggestions)}\n`,
    "continuity-report.md": `# 連続性レポート\n\n${continuity.overallAssessment}\n\n## 問題\n\n${bullets(continuity.issues.map(({ description }) => description))}\n`,
    "publisher-report.md": `# 出版レポート\n\n## 題名案\n\n${bullets(publisher.titleIdeas)}\n\n## ログライン\n\n${publisher.logline}\n\n## あらすじ\n\n${publisher.longSynopsis}\n`,
  };
}
