import type { Tool, ToolExecution } from "../lib/tools";

interface Props {
  allTools: Tool[];
  enabledToolIds: Set<string>;
  onToggle: (id: string, enabled: boolean) => void;
  lastExecutions: ToolExecution[];
  onClose: () => void;
}

export function ToolsPanel({
  allTools, enabledToolIds, onToggle, lastExecutions, onClose,
}: Props) {
  return (
    <div className="panel-overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <h2>🛠️ Tools</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="panel-body">
          <section className="panel-section">
            <h3>Available tools</h3>
            <p className="hint">
              Enabled tools are described in the system prompt. The LLM decides
              when to call them using a ReAct loop — it emits a tool call, the
              app executes it, and the result is fed back before the final answer.
            </p>

            <ul className="tool-list">
              {allTools.map((tool) => {
                const enabled = enabledToolIds.has(tool.id);
                return (
                  <li key={tool.id} className={`tool-item ${enabled ? "enabled" : ""}`}>
                    <label className="tool-toggle">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => onToggle(tool.id, e.target.checked)}
                      />
                      <div className="tool-info">
                        <div className="tool-header-row">
                          <span className="tool-name">{tool.name}</span>
                          {tool.requiresNetwork && (
                            <span className="tool-badge network">🌐 network</span>
                          )}
                          {!tool.requiresNetwork && (
                            <span className="tool-badge offline">✈️ offline</span>
                          )}
                        </div>
                        <span className="tool-desc">{tool.description}</span>
                        {tool.params.length > 0 && (
                          <div className="tool-params">
                            {tool.params.map((p) => (
                              <span key={p.name} className="tool-param">
                                {p.name}
                                {p.required ? "" : "?"}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>

          {lastExecutions.length > 0 && (
            <section className="panel-section">
              <h3>Last tool calls</h3>
              <ul className="tool-exec-list">
                {lastExecutions.map((ex) => (
                  <li key={ex.id} className="tool-exec-item">
                    <div className="tool-exec-header">
                      <span className="tool-exec-name">{ex.call.tool}</span>
                      <span className="tool-exec-duration">{ex.durationMs.toFixed(0)} ms</span>
                    </div>
                    {Object.keys(ex.call.args).length > 0 && (
                      <pre className="tool-exec-args">
                        {JSON.stringify(ex.call.args, null, 2)}
                      </pre>
                    )}
                    <pre className="tool-exec-result">{ex.result}</pre>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
