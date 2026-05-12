import ReactMarkdown from "react-markdown";
import type { Message } from "../lib/types";

interface Props {
  message: Message;
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === "user";

  return (
    <div className={`bubble-row ${isUser ? "user" : "assistant"}`}>
      <div className="bubble-avatar">{isUser ? "🧑" : "🤖"}</div>
      <div className="bubble">
        <div className="bubble-content">
          <ReactMarkdown>{message.content}</ReactMarkdown>
        </div>
        <div className="bubble-meta">
          {message.latencyMs !== undefined && (
            <span className="latency">{message.latencyMs.toFixed(0)} ms</span>
          )}
          {message.ragSourceIds && message.ragSourceIds.length > 0 && (
            <span className="rag-badge" title="Response used retrieved context">
              RAG ✦ {message.ragSourceIds.length}
            </span>
          )}
          <span className="timestamp">
            {new Date(message.createdAt).toLocaleTimeString()}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Animated placeholder for the streaming assistant response. */
export function StreamingBubble({ content }: { content: string }) {
  return (
    <div className="bubble-row assistant">
      <div className="bubble-avatar">🤖</div>
      <div className="bubble streaming">
        <div className="bubble-content">
          <ReactMarkdown>{content || " "}</ReactMarkdown>
        </div>
        <span className="cursor-blink">▌</span>
      </div>
    </div>
  );
}
