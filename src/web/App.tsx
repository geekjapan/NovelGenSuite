import { FormEvent, useEffect, useState } from "react";
import { z, type ZodType } from "zod";

import {
  ChapterOutlineOutputSchema,
} from "../shared/agent-schemas.js";
import {
  ErrorEnvelopeSchema,
  ProjectListResponseSchema,
  WebProjectStateSchema,
  type ErrorCode,
  type ProjectSummary,
  type WebProjectState as Project,
} from "../shared/contracts.js";
import { chapterProgress, elapsedSeconds } from "./model.js";

type Status = Project["agents"][number]["status"];

class ApiError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

async function api<T>(schema: ZodType<T>, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(path, init);
    body = await response.json();
  } catch {
    throw new Error("サーバーとの通信に失敗しました。");
  }
  if (response.ok) {
    const result = schema.safeParse(body);
    if (result.success) return result.data;
    console.error("API contract validation failed:", result.error);
  } else {
    const result = ErrorEnvelopeSchema.safeParse(body);
    if (result.success) throw new ApiError(result.data.error.code, result.data.error.message);
  }
  throw new Error("サーバーとの通信に失敗しました。");
}

const agentNames: Record<string, string> = {
  concept: "コンセプト",
  character: "キャラクター",
  worldbuilding: "世界観",
  plot: "プロット",
  "chapter-outline": "章構成",
  drafting: "執筆",
  editor: "編集",
  continuity: "連続性",
  publisher: "出版",
};

const statusNames: Record<Status, string> = {
  pending: "待機中",
  running: "実行中",
  completed: "完了",
  failed: "失敗",
};

function useHash() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const update = () => setHash(location.hash || "#/");
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  return hash;
}

function ErrorNotice({ error }: { error: Error | null }) {
  return error ? <p className="error" role="alert">{error.message}</p> : null;
}

async function runProject(id: string) {
  return api(WebProjectStateSchema, `/projects/${encodeURIComponent(id)}/run`, { method: "POST" });
}

async function runChapter(
  id: string,
  operation: "expand" | "revise",
  chapterNumber: number,
) {
  return api(WebProjectStateSchema, `/projects/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation,
      chapterNumber,
      instruction: operation === "expand"
        ? "場面、会話、感覚描写、内的葛藤を加えて章を拡張する"
        : "前提と連続性を守り、読みやすく章を改稿する",
    }),
  });
}

function ProjectList({ onRunFailure }: { onRunFailure: (id: string) => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api(ProjectListResponseSchema, "/projects").then(setProjects).catch((cause: Error) => setError(cause));
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStarting(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const configuration: Record<string, number | boolean> = {
      requireApproval: data.get("requireApproval") === "on",
    };
    const chapterCount = data.get("chapterCount");
    const chapterLength = data.get("chapterLength");
    if (chapterCount) configuration.chapterCount = Number(chapterCount);
    if (chapterLength) configuration.chapterLength = Number(chapterLength);
    try {
      const project = await api(WebProjectStateSchema, "/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: data.get("prompt"), language: "ja", configuration }),
      });
      location.hash = `#/projects/${project.id}`;
      void runProject(project.id).catch((cause) => {
        console.error("failed to trigger run", cause);
        onRunFailure(project.id);
      });
    } catch (cause) {
      setError(cause as Error);
      setStarting(false);
    }
  }

  return <main className="page">
    <section className="hero">
      <p className="eyebrow">NOVEL GENERATION WORKSPACE</p>
      <h1>物語の種を、<br /><span>一冊の小説へ。</span></h1>
      <p className="lead">9つの専門役が構想から出版準備までを順番に進めます。</p>
    </section>

    <section className="panel create-panel">
      <div>
        <p className="section-number">01</p>
        <h2>新しい小説</h2>
      </div>
      <form onSubmit={create}>
        <label>物語のプロンプト
          <textarea name="prompt" defaultValue="月面都市の最後の書店" required rows={4} />
        </label>
        <div className="field-row">
          <label>章数 <span>既定 2</span>
            <input name="chapterCount" type="number" min="1" max="64" placeholder="2" />
          </label>
          <label>一章の文字数 <span>既定 2000</span>
            <input name="chapterLength" type="number" min="1" placeholder="2000" />
          </label>
        </div>
        <label className="check"><input name="requireApproval" type="checkbox" /> 章構成を確認してから執筆する</label>
        <ErrorNotice error={error} />
        <button className="primary" disabled={starting}>{starting ? "開始しています…" : "生成を開始"}<span aria-hidden="true">→</span></button>
      </form>
    </section>

    <section className="projects">
      <div className="section-heading"><p className="section-number">02</p><h2>最近のプロジェクト</h2></div>
      {projects.length === 0 && !error ? <p className="empty">まだプロジェクトはありません。</p> : null}
      {projects.map((project) => <a className="project-link" href={`#/projects/${project.id}`} key={project.id}>
        <code>{project.id}</code><time>{new Date(project.createdAt).toLocaleString("ja-JP")}</time><span aria-hidden="true">↗</span>
      </a>)}
    </section>
  </main>;
}

function Report({ title, value }: { title: string; value: unknown }) {
  if (value === undefined) return null;
  return <details className="report"><summary>{title}<span>開く</span></summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

function ProjectView({ id, runFailed, onRunStarted }: { id: string; runFailed: boolean; onRunStarted: () => void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [resuming, setResuming] = useState(false);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    let active = true;
    let interval: ReturnType<typeof setInterval> | undefined;
    const load = () => api(WebProjectStateSchema, `/projects/${encodeURIComponent(id)}/state`)
      .then((next) => {
        if (!active) return;
        setProject(next);
        setError(null);
        if (interval && next.agents.every(({ status }) => status === "completed")) {
          clearInterval(interval);
          interval = undefined;
        }
      })
      .catch((cause: Error) => { if (active) setError(cause); });
    void load();
    interval = setInterval(load, 1500);
    return () => { active = false; if (interval) clearInterval(interval); };
  }, [id]);

  async function resume() {
    setResuming(true);
    setError(null);
    try {
      setProject(await runProject(id));
      onRunStarted();
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setResuming(false);
    }
  }

  async function moveStage(stage: Project["workflow"]["stage"]) {
    if (!project || project.workflow.stage === stage) return;
    const current = project.workflow.stage;
    const order = ["launcher", "planning", "approval", "drafting", "final"];
    const confirmed = order.indexOf(stage) >= order.indexOf(current)
      || confirm("前の段階へ戻りますか？");
    if (!confirmed) return;
    try {
      setProject(await api(WebProjectStateSchema, `/projects/${encodeURIComponent(id)}/stage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stage, confirmed }),
      }));
    } catch (cause) {
      setError(cause as Error);
    }
  }

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project) return;
    setActing(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    const outline = {
      parts: project.bible.parts.map((part) => ({
        ...part,
        chapters: part.chapters.map((chapter) => {
          const {
            draft: _draft,
            chapterSummary: _chapterSummary,
            continuityNotes: _continuityNotes,
            needsRevision: _needsRevision,
            ...editable
          } = chapter;
          return {
            ...editable,
            title: data.get(`title-${chapter.number}`),
            lengthPlan: {
              ...chapter.lengthPlan,
              target: Number(data.get(`length-${chapter.number}`)),
              min: Number(data.get(`min-${chapter.number}`)),
              max: Number(data.get(`max-${chapter.number}`)),
            },
          };
        }),
      })),
      styleGuide: project.bible.styleGuide,
      foreshadowingTracker: project.bible.foreshadowingTracker,
    };
    try {
      await api(ChapterOutlineOutputSchema, `/projects/${encodeURIComponent(id)}/outline`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(outline),
      });
      await api(WebProjectStateSchema, `/projects/${encodeURIComponent(id)}/approve`, {
        method: "POST",
      });
      setProject(await runProject(id));
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setActing(false);
    }
  }

  async function chapterAction(operation: "expand" | "revise", chapterNumber: number) {
    setActing(true);
    setError(null);
    try {
      setProject(await runChapter(id, operation, chapterNumber));
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setActing(false);
    }
  }

  async function revisePlanAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project) return;
    if (
      project.workflow.stage !== "planning"
      && !confirm("計画段階へ戻って改稿しますか？")
    ) return;
    setActing(true);
    setError(null);
    const instruction = new FormData(event.currentTarget).get("instruction");
    try {
      if (project.workflow.stage !== "planning") {
        await api(WebProjectStateSchema, `/projects/${encodeURIComponent(id)}/stage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stage: "planning", confirmed: true }),
        });
      }
      const revised = await api(WebProjectStateSchema, `/projects/${encodeURIComponent(id)}/plan/revise`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction }),
      });
      const planStatus = revised.agents.find(({ id: agentId }) =>
        agentId === "chapter-outline")?.status;
      setProject(
        revised.workflow.awaitingApproval || planStatus !== "completed"
          ? revised
          : await runProject(id),
      );
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setActing(false);
    }
  }

  async function abort() {
    try {
      await api(z.object({ aborted: z.literal(true) }), `/projects/${encodeURIComponent(id)}/abort`, {
        method: "POST",
      });
    } catch (cause) {
      setError(cause as Error);
    }
  }

  if (error instanceof ApiError && error.code === "project-not-found") return <main className="page narrow">
    <a className="back" href="#/">← 一覧へ戻る</a>
    <section className="panel not-found"><p className="eyebrow">PROJECT NOT FOUND</p><h1>プロジェクトが<br />見つかりません。</h1><ErrorNotice error={error} /></section>
  </main>;
  if (!project) return <main className="page narrow"><a className="back" href="#/">← 一覧へ戻る</a><p className="loading">状態を読み込んでいます…</p><ErrorNotice error={error} /></main>;

  const failed = project.agents.filter(({ status }) => status === "failed");
  const startFailed = runFailed && project.agents.every(({ status }) => status === "pending");
  const completed = project.agents.filter(({ status }) => status === "completed").length;
  const finished = completed === project.agents.length;
  const canAdjustChapters = finished && project.workflow.stage === "final";
  return <main className="page narrow">
    <a className="back" href="#/">← 一覧へ戻る</a>
    <header className="project-header">
      <div><p className="eyebrow">PROJECT / {project.id.slice(0, 8)}</p><h1>{project.prompt}</h1></div>
      <div className="total"><strong>{completed}</strong><span>/ 9 ROLES</span></div>
    </header>
    <ErrorNotice error={error} />
    {project.warnings.map((warning) =>
      <p role="status" key={warning.code}>{warning.message}</p>)}

    <nav className="stages" aria-label="制作段階">
      {([
        ["launcher", "開始"],
        ["planning", "計画"],
        ["approval", "承認"],
        ["drafting", "執筆"],
        ["final", "最終"],
      ] as const).map(([stage, label]) =>
        <button
          className={project.workflow.stage === stage ? "current" : ""}
          disabled={!project.workflow.reached.includes(stage)}
          key={stage}
          onClick={() => void moveStage(stage)}
        >{label}</button>)}
    </nav>

    {project.agents.some(({ status }) => status === "running") ?
      <button className="danger" onClick={() => void abort()}>生成を停止</button> : null}

    {project.workflow.reached.includes("approval")
      && (project.workflow.stage === "approval" || project.workflow.stage === "planning")
      ? <section className="panel approval-panel">
          <p className="eyebrow">CHAPTER OUTLINE APPROVAL</p>
          <h2>{project.workflow.awaitingApproval ? "章構成を確認" : "計画を改稿"}</h2>
          <p>題名と章長を編集して承認すると、執筆を続けます。</p>
          <form onSubmit={approve}>
            {project.bible.chapters.map((chapter) =>
              <fieldset key={chapter.number}>
                <legend>第{chapter.number}章</legend>
                <label>題名<input name={`title-${chapter.number}`} defaultValue={chapter.title} required /></label>
                <div className="field-row">
                  <label>目標<input name={`length-${chapter.number}`} type="number" min="1" defaultValue={chapter.lengthPlan.target} required /></label>
                  <label>最小<input name={`min-${chapter.number}`} type="number" min="1" defaultValue={chapter.lengthPlan.min} required /></label>
                  <label>最大<input name={`max-${chapter.number}`} type="number" min="1" defaultValue={chapter.lengthPlan.max} required /></label>
                </div>
              </fieldset>)}
            <button className="primary" disabled={acting}>{acting ? "処理しています…" : "章構成を承認して再開"}<span aria-hidden="true">→</span></button>
          </form>
        </section>
      : null}

    {startFailed ? <section className="failure" role="alert">
      <p className="eyebrow">RUN NOT STARTED</p>
      <h2>生成を開始できませんでした</h2>
      <p>サーバーとの通信に失敗しました。もう一度開始できます。</p>
      <button className="primary" onClick={resume} disabled={resuming}>{resuming ? "開始しています…" : "開始/再試行"}<span aria-hidden="true">↻</span></button>
    </section> : null}

    {failed.length > 0 ? <section className="failure" role="alert">
      <p className="eyebrow">RUN INTERRUPTED</p>
      <h2>生成が中断されました</h2>
      {failed.map((agent) => <p key={agent.id}><strong>{agentNames[agent.id]}</strong> — {agent.error}</p>)}
      <button className="primary" onClick={resume} disabled={resuming}>{resuming ? "再開しています…" : "続きから再開"}<span aria-hidden="true">↻</span></button>
    </section> : null}

    <section className="progress-panel">
      <div className="section-heading"><p className="section-number">進捗</p><h2>制作チーム</h2></div>
      <ol className="agent-list">
        {project.agents.map((agent, index) => {
          const end = agent.completedAt ?? (agent.status === "failed" ? project.meta.updatedAt : undefined);
          const seconds = elapsedSeconds(agent.startedAt, end);
          return <li className={`agent ${agent.status}`} key={agent.id}>
            <span className="agent-index">{String(index + 1).padStart(2, "0")}</span>
            <span className="status-dot" aria-hidden="true" />
            <strong>{agentNames[agent.id] ?? agent.id}{agent.id === "drafting" ? ` ${chapterProgress(project.chapterRuns)}` : ""}</strong>
            <span className="status-name">{statusNames[agent.status]}</span>
            <time>{seconds === undefined ? "—" : `${seconds}秒`}</time>
          </li>;
        })}
      </ol>
    </section>

    {project.bible.chapters.some((chapter) => chapter.draft) ?
      <section className="chapter-actions">
        <div className="section-heading"><p className="section-number">操作</p><h2>章の調整</h2></div>
        <form className="plan-revise" onSubmit={revisePlanAction}>
          <label>計画の改稿指示<input name="instruction" required placeholder="中盤の緊張感を高める" /></label>
          <button disabled={acting}>計画を改稿</button>
        </form>
        {canAdjustChapters ? project.bible.chapters.filter((chapter) => chapter.draft).map((chapter) =>
          <article key={chapter.number}>
            <strong>第{chapter.number}章 {chapter.title}</strong>
            <div>
              <button disabled={acting} onClick={() => void chapterAction("expand", chapter.number)}>章を拡張</button>
              <button disabled={acting} onClick={() => void chapterAction("revise", chapter.number)}>章を改稿</button>
            </div>
          </article>) : null}
      </section>
      : null}

    {finished && project.manuscript ? <section className="outputs">
      <div className="section-heading"><p className="section-number">成果物</p><h2>完成した小説</h2></div>
      <article className="manuscript"><pre>{project.manuscript}</pre></article>
      <div className="reports">
        <Report title="編集レポート" value={project.bible.editorReport} />
        <Report title="連続性レポート" value={project.bible.continuityReport} />
        <Report title="出版レポート" value={project.bible.publisherPackage} />
      </div>
    </section> : null}
  </main>;
}

export function App() {
  const hash = useHash();
  const [failedRunId, setFailedRunId] = useState<string | null>(null);
  const match = /^#\/projects\/([A-Za-z0-9_-]+)$/.exec(hash);
  return <><header className="topbar"><a href="#/" className="brand">NOVEL<span>GEN</span></a><p>STORY PRODUCTION SYSTEM</p></header>{match
    ? <ProjectView id={match[1]} runFailed={failedRunId === match[1]} onRunStarted={() => setFailedRunId(null)} />
    : <ProjectList onRunFailure={setFailedRunId} />}</>;
}
