import { useState, useEffect, useRef } from "react";
import { loadSyncConfig, saveSyncConfig } from "../lib/db";
import type { SyncConfig } from "../lib/types";
import { DEFAULT_SYNC_CONFIG } from "../lib/types";
import { isTauri } from "../lib/llm";

export type SyncActivity = "idle" | "connecting" | "busy" | "stopped" | "error";

interface Props {
  /** Primary CBL collection to replicate (e.g. "_default.photos") */
  collection: string;
  /** Extra collections included in the same replication session */
  extraCollections?: string[];
  /** Called when activity changes — lets the parent show a topbar status dot */
  onActivity?: (a: SyncActivity) => void;
}

function activityFromString(s: string): SyncActivity {
  const l = s.toLowerCase();
  if (l === "connecting") return "connecting";
  if (l === "busy" || l === "offline") return "busy";
  if (l === "stopped") return "stopped";
  if (l === "idle") return "idle";
  return "error";
}

export function SyncPanel({ collection, extraCollections = [], onActivity }: Props) {
  const [cfg, setCfg] = useState<SyncConfig>({ ...DEFAULT_SYNC_CONFIG });
  const [open, setOpen] = useState(false);
  const [activity, setActivity] = useState<SyncActivity>("idle");
  const [msg, setMsg] = useState("");
  const [running, setRunning] = useState(false);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    loadSyncConfig().then(setCfg);
  }, []);

  useEffect(() => {
    return () => { unlistenRef.current?.(); };
  }, []);

  async function startSync() {
    if (!isTauri()) { setMsg("Sync requires the desktop/mobile app."); return; }
    if (!cfg.url.trim()) { setMsg("Enter a Sync Gateway URL first."); return; }

    const { startReplication, onReplicationStatus } = await import("tauri-plugin-cblite");

    const saved = { ...cfg, lastSyncedAt: new Date().toISOString() };
    await saveSyncConfig(saved);
    setCfg(saved);

    // Listen for status events
    unlistenRef.current?.();
    unlistenRef.current = await onReplicationStatus((act, err) => {
      const a = activityFromString(act);
      setActivity(a);
      onActivity?.(a);
      if (err) setMsg(`Error: ${err}`);
      else if (a === "idle") setMsg("Up to date");
      else if (a === "stopped") { setMsg("Sync stopped"); setRunning(false); }
      else if (a === "busy") setMsg("Syncing…");
      else if (a === "connecting") setMsg("Connecting…");
    });

    const auth = cfg.username ? { username: cfg.username, password: cfg.password } : undefined;
    await startReplication(cfg.url.trim(), collection, cfg.direction, auth, undefined, extraCollections.length ? extraCollections : undefined);
    setRunning(true);
    setMsg("Connecting…");
  }

  async function stopSync() {
    if (!isTauri()) return;
    const { stopReplication } = await import("tauri-plugin-cblite");
    await stopReplication().catch(() => {});
    unlistenRef.current?.();
    unlistenRef.current = null;
    setRunning(false);
    setActivity("stopped");
    onActivity?.("stopped");
    setMsg("Sync stopped");
  }

  function field(key: keyof SyncConfig, label: string, type = "text", placeholder = "") {
    return (
      <label className="sync-field">
        <span className="sync-field-label">{label}</span>
        <input
          className="inspect-input"
          type={type}
          placeholder={placeholder}
          value={String(cfg[key] ?? "")}
          onChange={(e) => setCfg((c) => ({ ...c, [key]: e.target.value }))}
        />
      </label>
    );
  }

  const dotClass = `sync-dot sync-dot--${activity}`;

  return (
    <div className="sync-panel-wrap">
      <button
        className={`sync-trigger-btn ${running ? "sync-trigger-btn--active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Sync settings"
      >
        <span className={dotClass} />
        ☁ Sync
      </button>

      {open && (
        <div className="sync-drawer">
          <div className="sync-drawer-header">
            <span className="sync-drawer-title">Sync Gateway</span>
            <button className="btn-sm" onClick={() => setOpen(false)}>✕</button>
          </div>

          <div className="sync-drawer-body">
            {field("url", "Gateway URL", "url", "ws://localhost:4984/db")}
            {field("username", "Username", "text", "optional")}
            {field("password", "Password", "password", "optional")}

            <label className="sync-field sync-field--row">
              <span className="sync-field-label">Direction</span>
              <select
                className="inspect-input"
                value={cfg.direction}
                onChange={(e) => setCfg((c) => ({ ...c, direction: e.target.value as SyncConfig["direction"] }))}
              >
                <option value="both">Push + Pull</option>
                <option value="push">Push only</option>
                <option value="pull">Pull only</option>
              </select>
            </label>

            <label className="sync-field sync-field--row">
              <span className="sync-field-label">Continuous</span>
              <input
                type="checkbox"
                checked={cfg.continuous}
                onChange={(e) => setCfg((c) => ({ ...c, continuous: e.target.checked }))}
                className="sync-checkbox"
              />
            </label>

            <div className="sync-actions">
              {running
                ? <button className="demo-action-btn" onClick={stopSync}>Stop</button>
                : <button className="demo-action-btn" onClick={startSync}>Start sync</button>
              }
            </div>

            {msg && (
              <div className="sync-status-row">
                <span className={dotClass} />
                <span className="sync-status-msg">{msg}</span>
              </div>
            )}

            {cfg.lastSyncedAt && (
              <p className="sync-last">Last synced {new Date(cfg.lastSyncedAt).toLocaleString()}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
