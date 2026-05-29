import { useEffect, useRef, useState, useCallback, type RefObject } from "react";
import { ContextWindowBar } from "./ContextWindowBar";
import { MessageBubble, StreamingBubble, ThinkingBubble } from "./MessageBubble";
import type { UseVoiceInputReturn } from "../hooks/useVoiceInput";
import type { Message, AppStatus } from "../lib/types";
import type { RetrievedChunk } from "../lib/rag";
import type { ToolExecution } from "../lib/tools";

const TEMPLATES = [
  { icon: "📝", label: "Summarise",    prompt: "Summarise the key points from the documents in my knowledge base." },
  { icon: "🔍", label: "Explain",      prompt: "Explain the main concepts in my knowledge base as if I'm new to the topic." },
  { icon: "❓", label: "Q&A",          prompt: "What are the most important questions I should be asking about this topic?" },
  { icon: "💡", label: "Brainstorm",   prompt: "Based on what you know, suggest 5 ideas or next steps I could explore." },
  { icon: "🐛", label: "Debug",        prompt: "Here is some code I need help debugging:\n\n```\n\n```" },
  { icon: "✍️", label: "Draft",        prompt: "Help me draft a clear and concise explanation of the following topic:" },
];

interface Props {
  messages: Message[];
  streamingContent: string | null;
  streamingTokensPerSec?: number;
  status: AppStatus;
  voice: UseVoiceInputReturn;
  voiceInput: string;
  voiceError: string | null;
  onVoiceInputChange: (v: string) => void;
  onVoiceErrorDismiss: () => void;
  onSend: (text: string, imageDataUrl?: string) => void;
  onStop: () => void;
  onEdit: (id: string, newContent: string) => void | Promise<void>;
  onBranch: (id: string) => void | Promise<void>;
  onBookmark: (id: string) => void;
  onFetchRagChunks: (ids: string[]) => Promise<{ id: string; source: string; text: string; type: "knowledge" | "message"; score?: number }[]>;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** For context window visualiser */
  ragChunks?: RetrievedChunk[];
  systemPrompt?: string;
  contextLength?: number;
  /** For ETA display in StreamingBubble */
  maxTokens?: number;
  tokensGenerated?: number;
  toolExecutions?: ToolExecution[];
  streamingAgentName?: string | null;
}

export function ChatPane({
  messages,
  streamingContent,
  streamingTokensPerSec,
  status,
  voice,
  voiceInput,
  voiceError,
  onVoiceInputChange,
  onVoiceErrorDismiss,
  onSend,
  onStop,
  onEdit,
  onBranch,
  onBookmark,
  onFetchRagChunks,
  inputRef,
  ragChunks = [],
  systemPrompt = "",
  contextLength = 0,
  maxTokens,
  tokensGenerated,
  toolExecutions = [],
  streamingAgentName,
}: Props) {
  const [input, setInput] = useState("");
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [thinkingElapsedMs, setThinkingElapsedMs] = useState(0);
  const thinkingStartRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = (inputRef ?? internalRef) as RefObject<HTMLTextAreaElement>;

  const handleImageAttach = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => setAttachedImage(e.target?.result as string);
    reader.onerror = () => console.warn("[ChatPane] Failed to read image file");
    reader.readAsDataURL(file);
  }, []);

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleImageAttach(file);
    e.target.value = "";
  };

  // Paste image from clipboard
  const handlePaste = (e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (item) { const file = item.getAsFile(); if (file) handleImageAttach(file); }
  };

  // Drag-and-drop image onto textarea
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
    if (file) handleImageAttach(file);
  };

  // Sync voice result into local input
  useEffect(() => {
    if (voiceInput) {
      setInput((prev) => (prev ? `${prev} ${voiceInput}` : voiceInput));
      onVoiceInputChange("");
      textareaRef.current?.focus();
    }
  }, [voiceInput, onVoiceInputChange]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  const handleSend = () => {
    const text = input.trim();
    if ((!text && !attachedImage) || status === "generating" || status === "embedding") return;
    setInput("");
    const img = attachedImage ?? undefined;
    setAttachedImage(null);
    onSend(text || "Describe this image.", img);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isGenerating = status === "generating" || status === "embedding";
  const isEmpty = messages.length === 0 && streamingContent === null;

  // Tick elapsed time while waiting for the first token ("thinking" state)
  useEffect(() => {
    const isThinking = isGenerating && streamingContent === null;
    if (isThinking) {
      if (thinkingStartRef.current === null) {
        thinkingStartRef.current = Date.now();
        setThinkingElapsedMs(0);
      }
      const id = setInterval(() => {
        setThinkingElapsedMs(Date.now() - (thinkingStartRef.current ?? Date.now()));
      }, 500);
      return () => clearInterval(id);
    } else {
      thinkingStartRef.current = null;
      setThinkingElapsedMs(0);
    }
  }, [isGenerating, streamingContent]);

  return (
    <div className="chat-pane">
      <div className="chat-messages" role="log" aria-live="polite" aria-label="Conversation messages">
        {isEmpty && (
          <div className="chat-empty">
            <div className="chat-empty-icon">🧠</div>
            <h2>Offline RAG Chatbot</h2>
            <p>
              Ask anything. When a knowledge base is loaded, answers are
              grounded in your documents — all inference runs on-device.
            </p>
            <div className="template-grid">
              {TEMPLATES.map((t) => (
                <button
                  key={t.label}
                  className="template-card"
                  disabled={isGenerating}
                  onClick={() => {
                    if (!isGenerating) onSend(t.prompt);
                  }}
                >
                  <span className="template-icon">{t.icon}</span>
                  <span className="template-label">{t.label}</span>
                  <span className="template-prompt">{t.prompt}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            onEdit={msg.role === "user" ? onEdit : undefined}
            onBranch={onBranch}
            onBookmark={onBookmark}
            onFetchRagChunks={onFetchRagChunks}
          />
        ))}

        {streamingContent !== null && (
          <StreamingBubble
            content={streamingContent}
            tokensPerSec={streamingTokensPerSec}
            maxTokens={maxTokens}
            tokensGenerated={tokensGenerated}
            toolExecutions={toolExecutions}
            agentName={streamingAgentName}
          />
        )}

        {isGenerating && streamingContent === null && (
          <ThinkingBubble elapsedMs={thinkingElapsedMs} />
        )}

        <div ref={bottomRef} />
      </div>

      <ContextWindowBar
        messages={messages}
        ragChunks={ragChunks}
        systemPrompt={systemPrompt}
        currentInput={input}
        contextLength={contextLength}
      />

      <div className="chat-input-bar">
        {/* Image preview strip */}
        {attachedImage && (
          <div className="image-preview-strip">
            <img src={attachedImage} className="image-preview-thumb" alt="attachment" />
            <button className="image-preview-remove" onClick={() => setAttachedImage(null)} title="Remove image">✕</button>
          </div>
        )}

        <div className="chat-input-wrap">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleFilePick}
          />
          <textarea
            ref={textareaRef}
            className="chat-input"
            rows={1}
            placeholder={
              voice.state === "recording"
                ? "Listening…"
                : isGenerating
                ? "Generating…"
                : "Ask a question… (Enter to send, paste/drop image)"
            }
            value={voice.state === "recording" ? voice.transcript : input}
            onChange={(e) => {
              if (voice.state !== "recording") setInput(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            disabled={isGenerating || voice.state === "recording"}
          />
          {voiceError && (
            <div className="voice-error">
              ⚠️ {voiceError}
              <button className="voice-error-dismiss" onClick={onVoiceErrorDismiss}>✕</button>
            </div>
          )}
        </div>

        {/* Image attach button */}
        <button
          className="attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={isGenerating}
          title="Attach image (or paste / drop)"
        >
          🖼
        </button>

        {voice.backend !== "none" && (
          <button
            className={`mic-btn ${voice.state === "recording" ? "recording" : ""} ${voice.workerStatus === "loading" ? "loading" : ""}`}
            onClick={voice.toggle}
            disabled={isGenerating || voice.workerStatus === "loading" || voice.state === "processing"}
            title={
              voice.workerStatus === "loading"
                ? "Downloading Whisper model…"
                : voice.state === "recording"
                ? "Stop recording"
                : voice.backend === "whisper"
                ? "Record voice (Whisper)"
                : "Record voice"
            }
            aria-label={voice.state === "recording" ? "Stop recording" : "Start voice input"}
          >
            {voice.workerStatus === "loading"
              ? "⏳"
              : voice.state === "recording"
              ? "⏹"
              : voice.state === "processing"
              ? "⏳"
              : "🎙"}
          </button>
        )}

        {status === "generating" ? (
          <button
            className="stop-btn"
            onClick={onStop}
            title="Stop generation (Esc)"
          >
            ⏹
          </button>
        ) : (
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={isGenerating || (!input.trim() && !attachedImage)}
            title="Send"
          >
            ➤
          </button>
        )}
      </div>
    </div>
  );
}
