import { useEffect, useRef, useState } from "react";
import { MessageBubble, StreamingBubble } from "./MessageBubble";
import type { Message, AppStatus } from "../lib/types";

interface Props {
  messages: Message[];
  streamingContent: string | null;
  status: AppStatus;
  onSend: (text: string) => void;
  onNewConversation: () => void;
}

export function ChatPane({
  messages,
  streamingContent,
  status,
  onSend,
  onNewConversation,
}: Props) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || status === "generating" || status === "embedding") return;
    setInput("");
    onSend(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isGenerating = status === "generating" || status === "embedding";
  const isEmpty = messages.length === 0 && streamingContent === null;

  return (
    <div className="chat-pane">
      <div className="chat-messages">
        {isEmpty && (
          <div className="chat-empty">
            <div className="chat-empty-icon">🧠</div>
            <h2>Offline RAG Chatbot</h2>
            <p>
              Ask anything. When a knowledge base is loaded, answers are
              grounded in your documents — all inference runs on-device.
            </p>
            <button className="btn-primary" onClick={onNewConversation}>
              Start a conversation
            </button>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {streamingContent !== null && (
          <StreamingBubble content={streamingContent} />
        )}

        {isGenerating && streamingContent === null && (
          <div className="bubble-row assistant">
            <div className="bubble-avatar">🤖</div>
            <div className="bubble thinking">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="chat-input-bar">
        <textarea
          ref={textareaRef}
          className="chat-input"
          rows={1}
          placeholder={
            isGenerating ? "Generating…" : "Ask a question… (Enter to send)"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isGenerating}
        />
        <button
          className="send-btn"
          onClick={handleSend}
          disabled={isGenerating || !input.trim()}
          title="Send"
        >
          {isGenerating ? "⏳" : "➤"}
        </button>
      </div>
    </div>
  );
}
