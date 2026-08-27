import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApprovalDecisionDTO,
  ApprovalRequestDTO,
  ChatItem,
  ConnectState,
  EngineStatus,
  ModelDTO,
  RecentProjectDTO,
  SessionSummaryDTO,
  ThinkingLevel,
  TodoItemDTO,
  ToolResultDTO,
} from "../../shared/protocol";
import { api } from "./api";
import { Titlebar } from "./components/Titlebar";
import { Sidebar } from "./components/Sidebar";
import { Transcript, StreamingState } from "./components/Transcript";
import { Composer } from "./components/Composer";
import { ApprovalModal } from "./components/ApprovalModal";
import { SettingsModal } from "./components/SettingsModal";
import { DiffModal } from "./components/DiffModal";
import { SessionsModal } from "./components/SessionsModal";
import { ChatsModal } from "./components/ChatsModal";
import { ProjectModal } from "./components/ProjectModal";
import { TodoList } from "./components/ToolCard";
import { TerminalPanel } from "./components/TerminalPanel";
import { AboutModal } from "./components/AboutModal";
import { SkillsModal } from "./components/SkillsModal";
import { Modal, baseName } from "./components/common";
import { Lang, LangContext, loadLang, saveLang, translate, useT, StringKey } from "./i18n";

type ModalName =
  | "settings"
  | "sessions"
  | "chats"
  | "project"
  | "diff"
  | "about"
  | "skills"
  | null;

interface ConfirmState {
  message: string;
  action: () => void;
  danger?: boolean;
}

const IDLE_STREAM: StreamingState = { active: false, iteration: 0, tail: "" };

// -- top-strip icons (13px strokes, lucide-style) ----------------------------

const stripIconProps = {
  width: 13,
  height: 13,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function TerminalIcon(): React.ReactElement {
  return (
    <svg {...stripIconProps}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function DiffIcon(): React.ReactElement {
  return (
    <svg {...stripIconProps}>
      <path d="M12 4v10" />
      <path d="M7 9h10" />
      <path d="M7 20h10" />
    </svg>
  );
}

function UndoIcon(): React.ReactElement {
  return (
    <svg {...stripIconProps}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

function ExportIcon(): React.ReactElement {
  return (
    <svg {...stripIconProps}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function SearchIcon(): React.ReactElement {
  return (
    <svg {...stripIconProps}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.2" y2="16.2" />
    </svg>
  );
}

export function App(): React.ReactElement {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [connect, setConnect] = useState<ConnectState>("connecting");
  const [connectDetail, setConnectDetail] = useState<string | undefined>();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [streaming, setStreaming] = useState<StreamingState>(IDLE_STREAM);
  const [toolProgress, setToolProgress] = useState<Record<string, string>>({});
  const [todos, setTodos] = useState<TodoItemDTO[]>([]);
  const [sessions, setSessions] = useState<SessionSummaryDTO[]>([]);
  const [projects, setProjects] = useState<RecentProjectDTO[]>([]);
  const [models, setModels] = useState<ModelDTO[]>([]);
  const [approval, setApproval] = useState<{ id: number; request: ApprovalRequestDTO } | null>(null);
  const [modal, setModal] = useState<ModalName>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [engineDown, setEngineDown] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  /** Set while a session/project switch is in flight; drives the spinners. */
  const [loading, setLoading] = useState<{ label: string; sessionId?: string } | null>(null);
  const [turnActive, setTurnActive] = useState(false);
  /** Session whose last turn ended in an error, marked red in the sidebar. */
  const [failedSessionId, setFailedSessionId] = useState<string | null>(null);
  /** Delivery state per user message: did it actually reach ChatGPT? */
  const [deliveries, setDeliveries] = useState<
    Record<string, "pending" | "read" | "sent" | "failed">
  >({});
  /** Text pushed back into the composer by "edit message". */
  const [draft, setDraft] = useState<{ text: string; nonce: number } | null>(null);
  /** Sidebar width in px, draggable and remembered. */
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem("onflip.sidebarWidth"));
      return stored >= 200 && stored <= 520 ? stored : 268;
    } catch {
      return 268;
    }
  });
  /** True mid-drag, to suspend the layout transition. */
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  /** Terminal panel width in px, draggable and remembered. */
  const [termWidth, setTermWidth] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem("onflip.termWidth"));
      return stored >= 280 && stored <= 720 ? stored : 380;
    } catch {
      return 380;
    }
  });
  const [resizingTerm, setResizingTerm] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Ctrl+F opens in-chat search wherever focus is.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [lang, setLang] = useState<Lang>(() => loadLang());
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return localStorage.getItem("onflip.theme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });

  // Theme is applied at the document root so every var() follows, and the
  // native window chrome is kept in step by the main process.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("onflip.theme", theme);
    } catch {
      /* cosmetic */
    }
    void window.onflip.setTheme(theme);
  }, [theme]);

  useEffect(() => saveLang(lang), [lang]);

  const sessionIdRef = useRef<string>("");
  const sessionTitleRef = useRef<string>("");

  const pushLocal = useCallback((item: ChatItem) => {
    setItems((prev) => [...prev, item]);
  }, []);

  const notify = useCallback(
    (text: string) => pushLocal({ type: "notice", id: crypto.randomUUID(), text }),
    [pushLocal]
  );
  const notifyError = useCallback(
    (text: string) => pushLocal({ type: "error", id: crypto.randomUUID(), text }),
    [pushLocal]
  );

  const refreshLists = useCallback(() => {
    void api.listSessions(60).then(setSessions).catch(() => {});
    void api.recentProjects().then(setProjects).catch(() => {});
  }, []);

  const refreshStatus = useCallback(() => {
    void api.status().then(setStatus).catch(() => {});
  }, []);

  const boot = useCallback(() => {
    setEngineDown(false);
    setConnect("connecting");
    setConnectDetail(undefined);
    api
      .init()
      .then((s) => {
        setStatus(s);
        refreshLists();
      })
      .catch((e: Error) => {
        setConnect("error");
        setConnectDetail(e.message);
        notifyError(`Could not connect: ${e.message}`);
        refreshLists();
      });
  }, [notifyError, refreshLists]);

  // ---- engine event wiring -------------------------------------------------

  useEffect(() => {
    const offEvent = window.onflip.onEvent((event, raw) => {
      const data = raw as never;
      switch (event) {
        case "status": {
          const next = data as EngineStatus;
          setStatus(next);
          // A new session, or a title arriving from ChatGPT, both change what
          // the sidebar should show.
          if (
            next.sessionId !== sessionIdRef.current ||
            next.sessionTitle !== sessionTitleRef.current
          ) {
            sessionIdRef.current = next.sessionId;
            sessionTitleRef.current = next.sessionTitle;
            refreshLists();
          }
          break;
        }
        case "connect": {
          const c = data as { state: ConnectState; detail?: string };
          setConnect(c.state);
          setConnectDetail(c.detail);
          if (c.state === "signed-out" && c.detail) notifyError(c.detail);
          break;
        }
        case "transcript": {
          const t = data as { items: ChatItem[] };
          setItems(t.items);
          setToolProgress({});
          // Replayed messages are history; delivery badges are for live sends.
          setDeliveries({});
          break;
        }
        case "item": {
          const item = data as ChatItem;
          setItems((prev) => [...prev, item]);
          setStreaming((s) => (s.active ? { ...s, tail: "" } : s));
          if (item.type === "user") {
            setDeliveries((prev) => ({ ...prev, [item.id]: "pending" }));
          }
          break;
        }
        case "delivery": {
          const d = data as { id: string; state: "read" | "sent" | "failed" };
          setDeliveries((prev) => {
            // Streaming proves the message was read. Later transport
            // bookkeeping must not regress that fact to sent or failed.
            if (prev[d.id] === "read" && d.state !== "read") return prev;
            return { ...prev, [d.id]: d.state };
          });
          break;
        }
        case "tool-update": {
          const u = data as { id: string; result: ToolResultDTO };
          setItems((prev) =>
            prev.map((item) =>
              item.type === "tool" && item.id === u.id ? { ...item, result: u.result } : item
            )
          );
          setToolProgress((prev) => {
            if (!(u.id in prev)) return prev;
            const next = { ...prev };
            delete next[u.id];
            return next;
          });
          break;
        }
        case "tool-progress": {
          const p = data as { id: string; chunk: string };
          setToolProgress((prev) => ({
            ...prev,
            [p.id]: `${prev[p.id] ?? ""}${p.chunk}`.slice(-4000),
          }));
          break;
        }
        case "thinking": {
          const t = data as { iteration: number };
          setStreaming({ active: true, iteration: t.iteration, tail: "" });
          break;
        }
        case "delta": {
          const d = data as { tail: string };
          setStreaming((s) => (s.active ? { ...s, tail: d.tail } : s));
          break;
        }
        case "turn": {
          const t = data as { state: "start" | "end"; exhausted?: boolean; error?: string };
          if (t.state === "start") {
            setTurnActive(true);
            setFailedSessionId(null);
            // The session is persisted at turn start, so the sidebar can show
            // the new card (with its working spinner) right away.
            refreshLists();
            // Animate immediately: compaction and transport retries happen
            // before the first "thinking" event, and a static screen while
            // they run reads as a hang.
            setStreaming({ active: true, iteration: 0, tail: "" });
          } else {
            setTurnActive(false);
            setStreaming(IDLE_STREAM);
            if (t.exhausted && t.error) {
              setItems((prev) => [
                ...prev,
                { type: "error", id: crypto.randomUUID(), text: t.error! },
              ]);
            }
            // Any error ending the turn marks the session's card, so a failed
            // first message is visible in the sidebar instead of vanishing.
            if (t.error) setFailedSessionId(sessionIdRef.current || null);
            // A tool the turn never answered (interrupt, crash) must not keep
            // its working spinner once the turn is over.
            setItems((prev) =>
              prev.map((item) =>
                item.type === "tool" && !item.result
                  ? {
                      ...item,
                      result: {
                        output: "",
                        error: true,
                        title: "interrupted",
                        display: { kind: "none" as const },
                      },
                    }
                  : item
              )
            );
            refreshLists();
          }
          break;
        }
        case "todos": {
          setTodos((data as { items: TodoItemDTO[] }).items);
          break;
        }
        case "log":
          // Engine diagnostics; visible in the devtools console only.
          console.debug("[engine]", (data as { line: string }).line);
          break;
      }
    });

    const offApproval = window.onflip.onApproval((id, request) => {
      setApproval({ id, request: request as ApprovalRequestDTO });
    });

    const offExit = window.onflip.onEngineExit(() => {
      setEngineDown(true);
      setConnect("error");
      setConnectDetail("The engine process exited.");
      setTurnActive(false);
      setStreaming(IDLE_STREAM);
    });

    boot();
    return () => {
      offEvent();
      offApproval();
      offExit();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- actions -------------------------------------------------------------

  const guard = useCallback(
    (p: Promise<unknown>) => {
      p.catch((e: Error) => notifyError(e.message));
    },
    [notifyError]
  );

  const sendPrompt = useCallback(
    (text: string) => {
      guard(api.send(text));
    },
    [guard]
  );

  const loadModels = useCallback(() => {
    if (models.length === 0) void api.listModels().then(setModels).catch(() => {});
  }, [models.length]);

  /**
   * Take a user message out of the conversation (with everything after it)
   * and either put it back into the composer or send it again. Editing any
   * message but the last discards later turns, so that asks first.
   */
  const reviseMessage = useCallback(
    (id: string, mode: "edit" | "resend") => {
      const lastUserId = [...items].reverse().find((i) => i.type === "user")?.id;
      const run = () =>
        void api
          .rollback(id)
          .then((r) => {
            refreshLists();
            if (mode === "edit") setDraft({ text: r.text, nonce: Date.now() });
            else sendPrompt(r.text);
          })
          .catch((e: Error) => notifyError(e.message));
      if (id === lastUserId) run();
      else {
        setConfirm({
          message:
            "This message is not the latest — editing it removes it and everything after it from the conversation. Continue?",
          action: run,
          danger: true,
        });
      }
    },
    [items, notifyError, refreshLists, sendPrompt]
  );

  /** Resume a session with visible progress — reattaching a ChatGPT thread can take a while. */
  const resumeSession = useCallback(
    (id: string) => {
      if (loading) return;
      setLoading({ label: translate(loadLang(), "openingSession"), sessionId: id });
      void api
        .resumeSession(id)
        .catch((e: Error) => notifyError(e.message))
        .finally(() => setLoading(null));
    },
    [loading, notifyError]
  );

  const openProject = useCallback(
    (dir: string) => {
      if (loading) return;
      setLoading({ label: translate(loadLang(), "openingProject") });
      void api
        .openProject(dir)
        .catch((e: Error) => notifyError(e.message))
        .finally(() => setLoading(null));
    },
    [loading, notifyError]
  );

  const pickFolder = useCallback(() => {
    void api.pickFolder().then((dir) => {
      if (dir) openProject(dir);
    });
  }, [openProject]);

  const doUndo = useCallback(() => {
    void api.undoPreview().then((preview) => {
      if (!preview) {
        notify("Nothing to undo.");
        return;
      }
      if (preview.unavailable) {
        notifyError(`Cannot undo ${preview.rel}: its contents were omitted from the saved session. The file was left unchanged.`);
        return;
      }
      setConfirm({
        message: preview.existedBefore
          ? `Revert ${preview.rel} to its state before the last change?`
          : `Delete ${preview.rel}? It did not exist before this session.`,
        danger: true,
        action: () =>
          void api.undo().then((r) => {
            if (!r.ok) notifyError(r.message);
          }),
      });
    });
  }, [notify, notifyError]);

  const doExport = useCallback(() => {
    void api
      .exportTranscript()
      .then(async (result) => {
        const saved = await api.saveFile(result.suggestedName, result.markdown);
        if (saved) notify(`Transcript written to ${saved}`);
      })
      .catch((e: Error) => notifyError(e.message));
  }, [notify, notifyError]);

  const runCommand = useCallback(
    (name: string, arg: string) => {
      switch (name) {
        case "/new":
          guard(api.newSession());
          break;
        case "/open":
          if (arg) openProject(arg);
          else pickFolder();
          break;
        case "/cwd":
          if (arg) guard(api.changeCwd(arg));
          else notify(`cwd: ${status?.cwd ?? "unknown"}`);
          break;
        case "/sessions":
          setModal("sessions");
          break;
        case "/chats":
          setModal("chats");
          break;
        case "/project":
          setModal("project");
          break;
        case "/model":
          if (arg) guard(api.setModel(arg));
          else setModal("settings");
          break;
        case "/thinking":
          if (["off", "low", "medium", "high"].includes(arg)) {
            guard(api.setThinking(arg as ThinkingLevel));
          } else if (arg === "default" || arg === "") {
            guard(api.setThinking(null));
          } else {
            notify("Usage: /thinking off | low | medium | high | default");
          }
          break;
        case "/approve":
          if (["read-only", "ask", "auto-edit", "full-auto", "yolo"].includes(arg)) {
            if (arg === "yolo") {
              setConfirm({
                message:
                  "yolo runs everything without asking, including destructive commands. Turn it on?",
                danger: true,
                action: () => guard(api.setApproval("yolo")),
              });
            } else {
              guard(api.setApproval(arg as EngineStatus["approvalMode"]));
            }
          } else {
            notify("Usage: /approve read-only | ask | auto-edit | full-auto | yolo");
          }
          break;
        case "/shell":
          if (arg === "on" || arg === "off") guard(api.setShell(arg === "on"));
          else notify("Usage: /shell on | off");
          break;
        case "/compact":
          notify("Compacting the transcript…");
          guard(api.compact());
          break;
        case "/diff":
          setModal("diff");
          break;
        case "/undo":
          doUndo();
          break;
        case "/export":
          doExport();
          break;
        case "/init":
          sendPrompt(
            "If this project has no AGENTS.md, create one; otherwise improve it. Explore the codebase and make AGENTS.md accurately describe the project: what it is, the build/test/lint commands that actually work (verify them), the architecture worth knowing, and the conventions to follow. Keep it concise."
          );
          break;
        case "/settings":
          setModal("settings");
          break;
        default:
          notify(`Unknown command: ${name}`);
      }
    },
    [guard, notify, pickFolder, openProject, doUndo, doExport, sendPrompt, status?.cwd]
  );

  // ---- render --------------------------------------------------------------

  const busy = turnActive || Boolean(status?.busy);
  const homePath = status?.home ?? "";
  const shortCwd =
    status && homePath && status.cwd.toLowerCase().startsWith(homePath.toLowerCase())
      ? `~${status.cwd.slice(homePath.length)}`
      : (status?.cwd ?? "");

  const t = useCallback(
    (key: StringKey, params?: Record<string, string | number>) => translate(lang, key, params),
    [lang]
  );

  const startSidebarDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    setResizingSidebar(true);
    const clamp = (x: number) => Math.min(520, Math.max(200, x));
    const move = (ev: MouseEvent) => setSidebarWidth(clamp(ev.clientX));
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setResizingSidebar(false);
      try {
        localStorage.setItem("onflip.sidebarWidth", String(clamp(ev.clientX)));
      } catch {
        /* cosmetic */
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const startTermDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    setResizingTerm(true);
    const clamp = (x: number) => Math.min(720, Math.max(280, x));
    const widthAt = (ev: MouseEvent) => clamp(window.innerWidth - ev.clientX);
    const move = (ev: MouseEvent) => setTermWidth(widthAt(ev));
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setResizingTerm(false);
      try {
        localStorage.setItem("onflip.termWidth", String(widthAt(ev)));
      } catch {
        /* cosmetic */
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <LangContext.Provider value={lang}>
    <div
      className={`app${sidebarHidden ? " sidebar-hidden" : ""}${resizingSidebar || resizingTerm ? " resizing" : ""}${terminalOpen ? " term-open" : ""}`}
      style={
        {
          "--sidebar-w": `${sidebarWidth}px`,
          "--term-w": terminalOpen ? `${termWidth}px` : "0px",
          // Content keeps its width even while the column animates shut.
          "--term-cw": `${termWidth}px`,
        } as React.CSSProperties
      }
    >
      <Titlebar status={status} onToggleSidebar={() => setSidebarHidden((h) => !h)} />

      {!sidebarHidden && (
        <div
          className="sidebar-resizer"
          style={{ left: sidebarWidth - 3 }}
          onMouseDown={startSidebarDrag}
          onDoubleClick={() => {
            setSidebarWidth(268);
            try {
              localStorage.setItem("onflip.sidebarWidth", "268");
            } catch {
              /* cosmetic */
            }
          }}
          title="Drag to resize · double-click to reset"
        />
      )}

      <Sidebar
        status={status}
        connect={connect}
        connectDetail={connectDetail}
        sessions={sessions}
        projects={projects}
        onNewSession={() => guard(api.newSession())}
        onResumeSession={resumeSession}
        resumingId={loading?.sessionId ?? null}
        switching={loading !== null}
        workingId={turnActive && status ? status.sessionId : null}
        failedId={failedSessionId}
        onDeleteSession={(id) =>
          setConfirm({
            message: t("deleteSessionConfirm"),
            danger: true,
            action: () => void api.deleteSession(id).then(refreshLists).catch(() => {}),
          })
        }
        onOpenProject={openProject}
        onPickFolder={pickFolder}
        onOpenSettings={() => setModal("settings")}
        onOpenAbout={() => setModal("about")}
        onOpenSkills={() => setModal("skills")}
        onSignOut={() =>
          setConfirm({
            message: t("signOutConfirm"),
            danger: true,
            action: () => {
              void window.onflip
                .signOut()
                .then((r) => {
                  if (!r.ok && r.reason) notifyError(r.reason);
                  refreshStatus();
                })
                .catch((e: Error) => notifyError(e.message));
            },
          })
        }
        onSignIn={() => {
          void window.onflip
            .signIn()
            .then((r) => {
              if (r.ok) {
                refreshStatus();
                refreshLists();
              } else if (r.reason && r.reason !== "cancelled") {
                notifyError(`Sign-in did not complete: ${r.reason}`);
              }
            })
            .catch((e: Error) => notifyError(e.message));
        }}
      />

      <main className="main">
        {engineDown && (
          <div className="banner-error">
            <span className="grow">The engine process stopped.</span>
            <button
              className="btn"
              onClick={() => {
                void api.restartEngine(status?.cwd).then(() => boot());
              }}
            >
              Restart
            </button>
          </div>
        )}
        {connect === "signed-out" && !engineDown && (
          <div className="banner-error">
            <span className="grow">
              Not signed in to ChatGPT. Sign in at chatgpt.com in Chrome, Edge or Firefox,
              then run `onflip login` in a terminal and restart the engine.
            </span>
            <button
              className="btn"
              onClick={() => void api.restartEngine(status?.cwd).then(() => boot())}
            >
              Retry
            </button>
          </div>
        )}

        <div className="context-strip">
          <span className="path" title={status?.cwd}>
            {shortCwd}
          </span>
          {status?.gitBranch && (
            <span className="branch">
              ⎇ {status.gitBranch}
              {status.gitDirty ? " •" : ""}
            </span>
          )}
          <span className="spacer" />
          <button
            className={`strip-btn${terminalOpen ? " badged" : ""}`}
            onClick={() => setTerminalOpen((o) => !o)}
            title={t("stripTerminalTip")}
          >
            <TerminalIcon /> {t("stripTerminal")}
          </button>
          <button
            className={`strip-btn${(status?.snapshotCount ?? 0) > 0 ? " badged" : ""}`}
            onClick={() => setModal("diff")}
            title={t("stripDiffTip")}
          >
            <DiffIcon /> {t("stripDiff")}{status?.snapshotCount ? ` (${status.snapshotCount})` : ""}
          </button>
          <button className="strip-btn" onClick={doUndo} title={t("stripUndoTip")}>
            <UndoIcon /> {t("stripUndo")}
          </button>
          <button className="strip-btn" onClick={doExport} title={t("stripExportTip")}>
            <ExportIcon /> {t("stripExport")}
          </button>
          <button
            className={`strip-btn${searchOpen ? " badged" : ""}`}
            onClick={() => setSearchOpen((o) => !o)}
            title={t("stripSearchTip")}
          >
            <SearchIcon /> {t("stripSearch")}
          </button>
        </div>

        {loading ? (
          <div className="transcript">
            <div className="content-loading">
              <span className="spinner big" />
              <span>{loading.label}</span>
            </div>
          </div>
        ) : (
          <Transcript
            items={items}
            streaming={streaming}
            queued={status?.queued ?? []}
            toolProgress={toolProgress}
            onSuggest={sendPrompt}
            emptyProject={status ? baseName(status.cwd) : null}
            deliveries={deliveries}
            onRevise={busy || engineDown ? undefined : reviseMessage}
            searchOpen={searchOpen}
            onCloseSearch={() => setSearchOpen(false)}
          />
        )}

        <TodoPanel items={todos} />

        <Composer
          status={status}
          busy={busy}
          models={models}
          draft={draft}
          disabled={engineDown || loading !== null}
          onSend={sendPrompt}
          onInterrupt={() => {
            if (busy) guard(api.interrupt());
            else if ((status?.queued.length ?? 0) > 0) guard(api.clearQueue());
          }}
          onCommand={runCommand}
          onSetModel={(slug) => guard(api.setModel(slug))}
          onSetThinking={(level) => guard(api.setThinking(level))}
          onSetApproval={(mode) => {
            if (mode === "yolo") {
              setConfirm({
                message:
                  "yolo runs everything without asking, including destructive commands. Turn it on?",
                danger: true,
                action: () => guard(api.setApproval("yolo")),
              });
            } else {
              guard(api.setApproval(mode));
            }
          }}
          onLoadModels={loadModels}
        />
      </main>

      {terminalOpen && (
        <div
          className="term-resizer"
          style={{ right: termWidth - 3 }}
          onMouseDown={startTermDrag}
          onDoubleClick={() => {
            setTermWidth(380);
            try {
              localStorage.setItem("onflip.termWidth", "380");
            } catch {
              /* cosmetic */
            }
          }}
          title="Drag to resize · double-click to reset"
        />
      )}

      <TerminalPanel
        open={terminalOpen}
        projectCwd={status?.cwd ?? null}
        onClose={() => setTerminalOpen(false)}
      />

      {approval && (
        <ApprovalModal
          request={approval.request}
          onDecision={(decision: ApprovalDecisionDTO) => {
            window.onflip.respondApproval(approval.id, decision);
            setApproval(null);
          }}
        />
      )}

      {modal === "settings" && (
        <SettingsModal
          status={status}
          onClose={() => setModal(null)}
          onStatusChange={refreshStatus}
          notify={notify}
          theme={theme}
          onSetTheme={setTheme}
          lang={lang}
          onSetLang={setLang}
        />
      )}
      {modal === "diff" && <DiffModal onClose={() => setModal(null)} />}
      {modal === "about" && <AboutModal status={status} onClose={() => setModal(null)} />}

      {modal === "skills" && (
        <SkillsModal
          onClose={() => setModal(null)}
          onUse={(prompt) => setDraft({ text: prompt, nonce: Date.now() })}
        />
      )}

      {modal === "sessions" && (
        <SessionsModal
          currentId={status?.sessionId}
          onClose={() => setModal(null)}
          onResume={resumeSession}
        />
      )}
      {modal === "chats" && (
        <ChatsModal
          status={status}
          onClose={() => setModal(null)}
          onAttached={refreshLists}
          notify={notify}
        />
      )}
      {modal === "project" && (
        <ProjectModal
          status={status}
          onClose={() => setModal(null)}
          onChanged={refreshStatus}
          notify={notify}
        />
      )}

      {confirm && (
        <Modal
          title="Are you sure?"
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(null)}>
                {t("cancel")}
              </button>
              <button
                className={`btn ${confirm.danger ? "danger" : "primary"}`}
                onClick={() => {
                  confirm.action();
                  setConfirm(null);
                }}
              >
                {t("confirm")}
              </button>
            </>
          }
        >
          <div style={{ fontSize: 13.5 }}>{confirm.message}</div>
        </Modal>
      )}
    </div>
    </LangContext.Provider>
  );
}

/**
 * The agent's plan, pinned above the composer the way Codex shows its task
 * list. Collapsed it keeps one line — progress plus the step in flight — and
 * it disappears entirely when no plan exists.
 */
function TodoPanel({ items }: { items: TodoItemDTO[] }): React.ReactElement | null {
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  const visible = items.filter((t) => t.status !== "cancelled");
  if (visible.length === 0) return null;
  const done = visible.filter((t) => t.status === "completed").length;
  const current = visible.find((t) => t.status === "in_progress");
  const pct = Math.round((done / visible.length) * 100);

  return (
    <div className="todo-panel-wrap">
      <div className="todo-panel">
        <button className="todo-head" onClick={() => setCollapsed(!collapsed)}>
          <span className="todo-caption">{t("plan")}</span>
          <span className="todo-track">
            <span className="todo-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="todo-counter">
            {done}/{visible.length}
          </span>
          <span className="chev">{collapsed ? "▴" : "▾"}</span>
        </button>
        {collapsed ? (
          current && (
            <div className="todo-current">
              <span className="current-mark">◐</span>
              <span className="current-text">{current.content}</span>
            </div>
          )
        ) : (
          <div className="todo-body">
            <TodoList items={visible} />
          </div>
        )}
      </div>
    </div>
  );
}
