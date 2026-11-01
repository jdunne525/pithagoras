import { useEffect, useState } from "react";
import { LuArrowLeft, LuPlay, LuPlus, LuSquare, LuTrash2 } from "react-icons/lu";
import { api, type Script } from "../api.js";
import { t } from "../i18n.js";

/**
 * The Scripts page: a project's named commands, each runnable on demand. Unlike
 * Tasks, nothing here runs by itself — a click on the play button starts one
 * command in a fresh process in the project folder, and its output streams back
 * live into the console below it, so the server is never blocked.
 */
export function ScriptsPage({ projectName, onBack }: { projectName: string; onBack: () => void }) {
  const [scripts, setScripts] = useState<Script[] | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [error, setError] = useState<string | null>(null);

  // One live run per script id: its streamed text, how it ended, and the EventSource.
  interface Run { text: string; exitCode: number | null; running: boolean; runId?: string; es?: EventSource; }
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const runKey = (s: Script) => `${s.id}`;

  const load = async () => {
    try {
      setScripts(await api.listScripts(projectName));
      setError(null);
    } catch {
      setError(t("Could not load this project's scripts."));
    }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    const n = name.trim();
    const c = command.trim();
    if (!n || !c) return;
    try {
      await api.createScript(projectName, n, c);
      setName("");
      setCommand("");
      await load();
    } catch {
      setError(t("Could not add that script."));
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteScript(projectName, id);
      await load();
    } catch {
      setError(t("Could not delete that script."));
    }
  };

  const startRun = (script: Script) => {
    const existing = runs[runKey(script)];
    if (existing?.es) return; // already streaming, or streamed once and now done
    (async () => {
      try {
        const { runId } = await api.startScriptRun(projectName, script.id);
        const key = runKey(script);
        setRuns((prev) => ({ ...prev, [key]: { text: "", exitCode: null, running: true, runId } }));
        const es = new EventSource(`/api/projects/${encodeURIComponent(projectName)}/scripts/${encodeURIComponent(script.id)}/run/${encodeURIComponent(runId)}/stream`);
        setRuns((prev) => {
          const next = { ...prev, [key]: { ...(prev[key] ?? { text: "", exitCode: null, running: true }), es } };
          return next;
        });
        es.addEventListener("message", (ev) => {
          const payload = JSON.parse(ev.data) as
            | { type: "buffer"; data: string }
            | { type: "chunk"; data: string }
            | { type: "end"; code: number | null };
          setRuns((prev) => {
            const cur = prev[key] ?? { text: "", exitCode: null, running: true };
            if (payload.type === "end") {
              // The run is done: stop the stream so the browser does not retry
              // and replay its output again.
              try { es.close(); } catch { /* already closed */ }
              return { ...prev, [key]: { ...cur, text: cur.text, exitCode: payload.code, running: false } };
            }
            return { ...prev, [key]: { ...cur, text: cur.text + payload.data } };
          });
        });
      } catch {
        setError(t("Could not run that script."));
      }
    })();
  };

  const stopRun = async (script: Script) => {
    const run = runs[runKey(script)];
    if (!run?.es) return;
    if (run.runId) {
      try {
        await api.stopScriptRun(projectName, script.id, run.runId);
      } catch {
        // best effort
      }
    }
    try { run.es.close(); } catch { /* already closed */ }
    setRuns((prev) => {
      const cur = prev[runKey(script)];
      if (!cur) return prev;
      return { ...prev, [runKey(script)]: { ...cur, running: false } };
    });
  };

  const closeRun = (script: Script) => {
    const run = runs[runKey(script)];
    if (run?.es) { try { run.es.close(); } catch { /* ignore */ } }
    setRuns((prev) => { const next = { ...prev }; delete next[runKey(script)]; return next; });
  };

  return (
    <div className="flex h-full flex-col bg-canvas text-fg">
      <header className="flex items-center gap-3 border-b border-line/60 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          aria-label={t("Back to projects")}
          className="rounded-md p-1 text-fg-muted transition hover:bg-fg/5 hover:text-fg"
        >
          <LuArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2 text-base font-medium">
            {t("Scripts")}
            <span className="truncate text-sm text-fg-faint">· {projectName}</span>
          </div>
          <p className="text-xs text-fg-faint">{t("Run any command in this project's folder.")}</p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-4">
          {/* Add a script. */}
          <section className="mb-6 rounded-lg border border-line/60 p-3">
            <p className="mb-2 text-sm font-medium">{t("Add a script")}</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("Name")}
                onKeyDown={(e) => e.key === "Enter" && create()}
                className="flex-1 rounded-md border border-line/70 bg-raised px-2 py-1.5 text-sm text-fg outline-none focus:border-fg/40"
              />
              <input
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={t("Command, e.g. npm run build")}
                onKeyDown={(e) => e.key === "Enter" && create()}
                className="flex-1 rounded-md border border-line/70 bg-raised px-2 py-1.5 text-sm font-mono text-fg outline-none focus:border-fg/40"
              />
              <button
                type="button"
                onClick={create}
                disabled={!name.trim() || !command.trim()}
                className="inline-flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-canvas disabled:text-fg-faint"
              >
                <LuPlus className="h-3.5 w-3.5" />
                {t("Add")}
              </button>
            </div>
          </section>

          {error && <p className="mb-3 text-sm text-danger">{error}</p>}

          {/* The scripts. */}
          {scripts === null ? (
            <p className="text-sm text-fg-muted">{t("Loading…")}</p>
          ) : scripts.length === 0 ? (
            <p className="text-sm text-fg-subtle">{t("No scripts yet. Add one above.")}</p>
          ) : (
            <ul className="space-y-3">
              {scripts.map((s) => {
                const run = runs[runKey(s)];
                return (
                  <li key={s.id} className="rounded-lg border border-line/60 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{s.name}</p>
                        <p className="truncate font-mono text-xs text-fg-faint">{s.command}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => startRun(s)}
                          aria-label={t("Run script")}
                          title={t("Run script")}
                          className="rounded-md p-1.5 text-fg-muted transition hover:bg-fg/5 hover:text-fg"
                        >
                          {run?.running ? <LuSquare className="h-4 w-4" /> : <LuPlay className="h-4 w-4" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(s.id)}
                          aria-label={t("Delete script")}
                          title={t("Delete script")}
                          className="rounded-md p-1.5 text-fg-muted transition hover:bg-fg/5 hover:text-danger"
                        >
                          <LuTrash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    {/* The run's live output and exit status. */}
                    {run && (
                      <div className="mt-3 overflow-hidden rounded-md border border-line/50 bg-surface text-[12px]">
                        <div className="flex items-center justify-between border-b border-line/40 px-3 py-1.5">
                          <span className="text-fg-faint">
                            {run.running ? t("Running…") : t("Finished — exit code {code}", { code: run.exitCode ?? "?" })}
                          </span>
                          <div className="flex items-center gap-1">
                            {run.running && (
                              <button
                                type="button"
                                onClick={() => stopRun(s)}
                                aria-label={t("Stop")}
                                title={t("Stop")}
                                className="rounded px-1.5 py-0.5 text-fg-muted transition hover:bg-fg/5 hover:text-fg"
                              >
                                {t("Stop")}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => closeRun(s)}
                              aria-label={t("Close")}
                              title={t("Close")}
                              className="rounded px-1.5 py-0.5 text-fg-muted transition hover:bg-fg/5 hover:text-fg"
                            >
                              {t("Close")}
                            </button>
                          </div>
                        </div>
                        <pre className="max-h-64 overflow-auto p-3 whitespace-pre-wrap break-words font-mono text-fg-subtle">
                          {run.text || (run.running ? "" : "")}
                        </pre>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
