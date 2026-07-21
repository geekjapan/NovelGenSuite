export function chapterProgress(chapters: Array<{ status: string }>): string {
  return `${chapters.filter(({ status }) => status === "completed" || status === "edited").length}/${chapters.length}`;
}

export function elapsedSeconds(startedAt?: string, endedAt?: string): number | undefined {
  if (!startedAt) return undefined;
  return Math.max(0, Math.floor((new Date(endedAt ?? Date.now()).getTime() - new Date(startedAt).getTime()) / 1000));
}
