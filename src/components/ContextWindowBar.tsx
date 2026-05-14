import { useMemo } from "react";
import { computeContextBreakdown, formatTokens } from "../lib/tokenCount";
import type { Message } from "../lib/types";
import type { RetrievedChunk } from "../lib/rag";

interface Props {
  messages: Message[];
  ragChunks: RetrievedChunk[];
  systemPrompt: string;
  currentInput: string;
  /** Model context window in tokens. 0 = unknown (bar hidden). */
  contextLength: number;
}

// Colour stops for the fill bar: green → amber → red
function barColor(fraction: number): string {
  if (fraction < 0.6) return "var(--ctx-bar-ok, #22c55e)";
  if (fraction < 0.85) return "var(--ctx-bar-warn, #f59e0b)";
  return "var(--ctx-bar-danger, #ef4444)";
}

export function ContextWindowBar({
  messages,
  ragChunks,
  systemPrompt,
  currentInput,
  contextLength,
}: Props) {
  const bd = useMemo(
    () => computeContextBreakdown(messages, ragChunks, systemPrompt, currentInput, contextLength),
    [messages, ragChunks, systemPrompt, currentInput, contextLength],
  );

  // Don't render if context length is unknown
  if (contextLength <= 0) return null;

  // Show real percentage even when > 100%; clamp only the visual bar fill
  const pct = (bd.fraction * 100).toFixed(1);
  const color = barColor(bd.fraction);

  // Each segment is proportional to its share of the context window.
  // When total > contextLength the segments are scaled down so they still
  // fit within the track (overflow indicator covers the remainder).
  const scale = bd.fraction > 1 ? 1 / bd.fraction : 1;
  const seg = (tokens: number) =>
    contextLength > 0 ? `${((tokens / contextLength) * 100 * scale).toFixed(2)}%` : "0%";

  return (
    <div className="ctx-bar-wrap" title={`Context: ${formatTokens(bd.total)} / ${formatTokens(contextLength)} tokens`}>
      {/* Stacked segment bar */}
      <div className="ctx-bar-track">
        <div className="ctx-bar-seg ctx-seg-system"  style={{ width: seg(bd.system) }}  title={`System: ~${formatTokens(bd.system)} tok`} />
        <div className="ctx-bar-seg ctx-seg-history" style={{ width: seg(bd.history) }} title={`History: ~${formatTokens(bd.history)} tok`} />
        <div className="ctx-bar-seg ctx-seg-rag"     style={{ width: seg(bd.rag) }}     title={`RAG: ~${formatTokens(bd.rag)} tok`} />
        <div className="ctx-bar-seg ctx-seg-input"   style={{ width: seg(bd.input) }}   title={`Input: ~${formatTokens(bd.input)} tok`} />
        {/* Overflow indicator */}
        {bd.fraction >= 1 && (
          <div className="ctx-bar-overflow" title="Context limit exceeded" />
        )}
      </div>

      {/* Label row */}
      <div className="ctx-bar-label">
        <span className="ctx-bar-used" style={{ color }}>
          {formatTokens(bd.total)}
        </span>
        <span className="ctx-bar-sep">/</span>
        <span className="ctx-bar-max">{formatTokens(contextLength)}</span>
        <span className="ctx-bar-pct" style={{ color }}>{pct}%</span>

        {/* Breakdown legend */}
        <span className="ctx-legend">
          <span className="ctx-legend-dot ctx-seg-system" />sys
          <span className="ctx-legend-dot ctx-seg-history" />hist
          {bd.rag > 0 && <><span className="ctx-legend-dot ctx-seg-rag" />rag</>}
          {bd.input > 0 && <><span className="ctx-legend-dot ctx-seg-input" />input</>}
        </span>
      </div>
    </div>
  );
}
