import { FormEvent, useEffect, useState } from "react";
import type { ZodType } from "zod";

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
  const response = await fetch(path, init);
  let body: unknown;
  try {
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

function ProjectList() {
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
    const configuration: Record<string, number> = {};
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
      void runProject(project.id).catch(() => undefined);
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

function ProjectView({ id }: { id: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    let active = true;
    const load = () => api(WebProjectStateSchema, `/projects/${encodeURIComponent(id)}/state`)
      .then((next) => { if (active) { setProject(next); setError(null); } })
      .catch((cause: Error) => { if (active) setError(cause); });
    void load();
    const interval = setInterval(load, 1500);
    return () => { active = false; clearInterval(interval); };
  }, [id]);

  async function resume() {
    setResuming(true);
    setError(null);
    try {
      setProject(await runProject(id));
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setResuming(false);
    }
  }

  if (error instanceof ApiError && error.code === "project-not-found") return <main className="page narrow">
    <a className="back" href="#/">← 一覧へ戻る</a>
    <section className="panel not-found"><p className="eyebrow">PROJECT NOT FOUND</p><h1>プロジェクトが<br />見つかりません。</h1><ErrorNotice error={error} /></section>
  </main>;
  if (!project) return <main className="page narrow"><a className="back" href="#/">← 一覧へ戻る</a><p className="loading">状態を読み込んでいます…</p><ErrorNotice error={error} /></main>;

  const failed = project.agents.filter(({ status }) => status === "failed");
  const completed = project.agents.filter(({ status }) => status === "completed").length;
  const finished = completed === project.agents.length;
  return <main className="page narrow">
    <a className="back" href="#/">← 一覧へ戻る</a>
    <header className="project-header">
      <div><p className="eyebrow">PROJECT / {project.id.slice(0, 8)}</p><h1>{project.prompt}</h1></div>
      <div className="total"><strong>{completed}</strong><span>/ 9 ROLES</span></div>
    </header>
    <ErrorNotice error={error} />

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
  const match = /^#\/projects\/([A-Za-z0-9_-]+)$/.exec(hash);
  return <><header className="topbar"><a href="#/" className="brand">NOVEL<span>GEN</span></a><p>STORY PRODUCTION SYSTEM</p></header>{match ? <ProjectView id={match[1]} /> : <ProjectList />}</>;
}
