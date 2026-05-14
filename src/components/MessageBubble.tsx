import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Message } from "../lib/types";
import { loadImageFromBlob, isBlobRef } from "../lib/db";

// ── Code block with copy button ────────────────────────────────────────────

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current); }, []);
  const code = String(children ?? "").replace(/\n$/, "");

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => { copyTimerRef.current = null; setCopied(false); }, 1500);
    }).catch(() => { /* clipboard permission denied — silently ignore */ });
  };

  return (
    <div className="code-block-wrap">
      <button className="code-copy-btn" onClick={handleCopy} title="Copy code">
        {copied ? "✓" : "⎘"}
      </button>
      <pre className={className}>
        <code>{children}</code>
      </pre>
    </div>
  );
}

// ── Markdown renderer ──────────────────────────────────────────────────────

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        pre({ children }) {
          return <>{children}</>;
        },
        code({ className, children, ...props }) {
          const isBlock = className?.startsWith("language-");
          if (isBlock) {
            return <CodeBlock className={className}>{children}</CodeBlock>;
          }
          return <code className={className} {...props}>{children}</code>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// ── Message bubble ─────────────────────────────────────────────────────────

type RagChunkDetail = {
  id: string;
  source: string;
  text: string;
  type: "knowledge" | "message";
  score?: number;
};

interface Props {
  message: Message;
  onEdit?: (id: string, newContent: string) => void | Promise<void>;
  onBranch?: (id: string) => void | Promise<void>;
  onBookmark?: (id: string) => void;
  onFetchRagChunks?: (ids: string[]) => Promise<RagChunkDetail[]>;
}

export function MessageBubble({ message, onEdit, onBranch, onBookmark, onFetchRagChunks }: Props) {
  const isUser = message.role === "user";
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current); }, []);
  // Resolved image: either the original data URL or one fetched from a CBL blob ref
  const [resolvedImageUrl, setResolvedImageUrl] = useState<string | null>(
    message.imageDataUrl && !isBlobRef(message.imageDataUrl)
      ? message.imageDataUrl
      : null,
  );
  const [ragPopover, setRagPopover] = useState<RagChunkDetail[] | null>(null);
  const [ragLoading, setRagLoading] = useState(false);
  const [imageModalOpen, setImageModalOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  // Track whether blob resolution failed so we can show an error instead of
  // spinning forever when the blob is unavailable (deleted or web context).
  const [imageLoadFailed, setImageLoadFailed] = useState(false);

  // Resolve CBL blob reference to a data URL when the message first renders
  useEffect(() => {
    if (!message.imageDataUrl) return;
    if (!isBlobRef(message.imageDataUrl)) {
      setResolvedImageUrl(message.imageDataUrl);
      return;
    }
    let cancelled = false;
    setImageLoadFailed(false);
    loadImageFromBlob(message.imageDataUrl).then((url) => {
      if (cancelled) return;
      if (url) {
        setResolvedImageUrl(url);
      } else {
        // loadImageFromBlob returned null — blob unavailable
        setImageLoadFailed(true);
      }
    }).catch(() => {
      if (!cancelled) setImageLoadFailed(true);
    });
    return () => { cancelled = true; };
  }, [message.imageDataUrl]);

  // Close popover on outside click
  useEffect(() => {
    if (!ragPopover) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setRagPopover(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ragPopover]);

  const handleRagBadgeClick = async () => {
    if (ragPopover) { setRagPopover(null); return; }
    if (!onFetchRagChunks || !message.ragSourceIds?.length) return;
    setRagLoading(true);
    try {
      const chunks = await onFetchRagChunks(message.ragSourceIds);
      if (isMountedRef.current) setRagPopover(chunks);
    } catch {
      if (isMountedRef.current) setRagPopover([]); // show empty popover rather than leaving badge stuck
    } finally {
      if (isMountedRef.current) setRagLoading(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => { copyTimerRef.current = null; setCopied(false); }, 1500);
    }).catch(() => { /* clipboard permission denied — silently ignore */ });
  };

  const handleShare = async () => {
    if (navigator.share) {
      await navigator.share({ text: message.content }).catch(() => {});
    } else {
      handleCopy();
    }
  };

  const commitEdit = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== message.content) {
      Promise.resolve(onEdit?.(message.id, trimmed)).catch((e) =>
        console.error("[MessageBubble] onEdit failed:", e),
      );
    }
    setEditing(false);
  };

  return (
    <div id={`msg-${message.id}`} className={`bubble-row ${isUser ? "user" : "assistant"}`}>
      <div className="bubble-avatar">{isUser ? "🧑" : "🤖"}</div>
      <div className="bubble">
        {resolvedImageUrl && (
          <>
            <div className="bubble-image-wrap">
              <img
                src={resolvedImageUrl}
                className="bubble-image"
                alt="attached image"
                role="button"
                tabIndex={0}
                aria-label="View full-size image"
                onClick={() => setImageModalOpen(true)}
                onKeyDown={(e) => e.key === "Enter" && setImageModalOpen(true)}
                style={{ cursor: "zoom-in" }}
              />
            </div>
            {imageModalOpen && (
              <div
                className="image-modal-overlay"
                role="dialog"
                aria-modal="true"
                aria-label="Full-size image"
                onClick={() => setImageModalOpen(false)}
                onKeyDown={(e) => e.key === "Escape" && setImageModalOpen(false)}
                tabIndex={-1}
              >
                <img
                  src={resolvedImageUrl}
                  className="image-modal-img"
                  alt="attached image full size"
                  onClick={(e) => e.stopPropagation()}
                />
                <button
                  className="image-modal-close"
                  onClick={() => setImageModalOpen(false)}
                  aria-label="Close image"
                >✕</button>
              </div>
            )}
          </>
        )}
        {message.imageDataUrl && !resolvedImageUrl && (
          <div className="bubble-image-wrap bubble-image-loading">
            {imageLoadFailed ? "Image unavailable" : "Loading image…"}
          </div>
        )}
        <div className="bubble-content">
          {editing ? (
            <div className="bubble-edit">
              <textarea
                className="bubble-edit-input"
                value={editValue}
                autoFocus
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEdit(); }
                  if (e.key === "Escape") { setEditing(false); setEditValue(message.content); }
                }}
              />
              <div className="bubble-edit-actions">
                <button className="btn-sm" onClick={commitEdit}>Send</button>
                <button className="btn-sm secondary" onClick={() => { setEditing(false); setEditValue(message.content); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <MarkdownContent content={message.content} />
          )}
        </div>

        <div className="bubble-meta">
          {message.stopped && (
            <span className="stopped-badge" title="Generation was stopped early">⏹ stopped</span>
          )}
          {message.latencyMs !== undefined && !message.stopped && (
            <span className="latency">{message.latencyMs.toFixed(0)} ms</span>
          )}
          {message.ragSourceIds && message.ragSourceIds.length > 0 && (
            <span className="rag-badge-wrap">
              <button
                className={`rag-badge rag-badge-btn ${ragPopover ? "rag-badge-open" : ""}`}
                title="View retrieved context chunks"
                onClick={handleRagBadgeClick}
                disabled={ragLoading}
              >
                {ragLoading ? "…" : `RAG ✦ ${message.ragSourceIds.length}`}
              </button>
              {ragPopover && (
                <div className="rag-popover" ref={popoverRef}>
                  <div className="rag-popover-header">
                    <span>Retrieved context ({ragPopover.length} chunks)</span>
                    <button className="rag-popover-close" onClick={() => setRagPopover(null)}>✕</button>
                  </div>
                  <div className="rag-popover-list">
                    {ragPopover.map((chunk, i) => (
                      <div key={chunk.id} className="rag-popover-chunk">
                        <div className="rag-chunk-meta">
                          <span className={`rag-chunk-type rag-type-${chunk.type}`}>
                            {chunk.type === "knowledge" ? "📚" : "💬"}
                          </span>
                          <span className="rag-chunk-source">{chunk.source}</span>
                          {chunk.score !== undefined && (
                            <span className="rag-chunk-score" title="Retrieval score">
                              {(chunk.score * 100).toFixed(0)}%
                            </span>
                          )}
                          <span className="rag-chunk-num">#{i + 1}</span>
                        </div>
                        <p className="rag-chunk-text">{chunk.text.slice(0, 300)}{chunk.text.length > 300 ? "…" : ""}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </span>
          )}
          <span className="timestamp">
            {new Date(message.createdAt).toLocaleTimeString()}
          </span>
          {/* Copy / share — available on all messages */}
          {!editing && (
            <button
              className="bubble-action-btn"
              title={"share" in navigator ? "Share" : "Copy to clipboard"}
              onClick={isUser ? handleCopy : handleShare}
            >
              {copied ? "✓" : isUser ? "⎘" : "⎘"}
            </button>
          )}
          {/* Bookmark */}
          {onBookmark && !editing && (
            <button
              className={`bubble-action-btn bookmark-btn ${message.bookmarked ? "bookmarked" : ""}`}
              title={message.bookmarked ? "Remove bookmark" : "Bookmark"}
              onClick={() => onBookmark(message.id)}
            >
              {message.bookmarked ? "★" : "☆"}
            </button>
          )}
          {isUser && onEdit && !editing && (
            <button
              className="bubble-edit-btn"
              title="Edit message"
              onClick={() => { setEditValue(message.content); setEditing(true); }}
            >
              ✎
            </button>
          )}
          {onBranch && !editing && (
            <button
              className="bubble-branch-btn"
              title="Branch conversation from here"
              onClick={() => Promise.resolve(onBranch(message.id)).catch((e) =>
                console.error("[MessageBubble] onBranch failed:", e),
              )}
            >
              ⎇
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Animated placeholder for the streaming assistant response. */
export function StreamingBubble({
  content,
  tokensPerSec,
  maxTokens,
  tokensGenerated,
}: {
  content: string;
  tokensPerSec?: number;
  /** Model's max output tokens — used to estimate remaining time */
  maxTokens?: number;
  /** Tokens generated so far */
  tokensGenerated?: number;
}) {
  // Estimate seconds remaining: (maxTokens - generated) / tokensPerSec
  let etaLabel: string | null = null;
  if (tokensPerSec && tokensPerSec > 1 && maxTokens && tokensGenerated !== undefined) {
    const remaining = Math.max(0, maxTokens - tokensGenerated);
    const secs = remaining / tokensPerSec;
    if (secs > 1) {
      etaLabel = secs < 60
        ? `~${Math.round(secs)}s remaining`
        : `~${Math.round(secs / 60)}m remaining`;
    }
  }

  return (
    <div className="bubble-row assistant">
      <div className="bubble-avatar">🤖</div>
      <div className="bubble streaming">
        <div className="bubble-content">
          <MarkdownContent content={content || " "} />
        </div>
        <div className="bubble-meta">
          {tokensPerSec !== undefined && tokensPerSec > 0 && (
            <span className="token-speed">{tokensPerSec.toFixed(1)} tok/s</span>
          )}
          {etaLabel && (
            <span className="eta-label">{etaLabel}</span>
          )}
          <span className="cursor-blink">▌</span>
        </div>
      </div>
    </div>
  );
}

/** Thinking dots shown before the first token arrives. */
export function ThinkingBubble({ elapsedMs }: { elapsedMs: number }) {
  const secs = Math.floor(elapsedMs / 1000);
  return (
    <div className="bubble-row assistant">
      <div className="bubble-avatar">🤖</div>
      <div className="bubble thinking">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
        {secs >= 2 && (
          <span className="thinking-elapsed">{secs}s</span>
        )}
      </div>
    </div>
  );
}
