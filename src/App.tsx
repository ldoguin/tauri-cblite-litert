import { useState } from "react";
import { useChat } from "./hooks/useChat";
import { Sidebar } from "./components/Sidebar";
import { ChatPane } from "./components/ChatPane";
import { KnowledgePanel } from "./components/KnowledgePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import "./App.css";

type Modal = "knowledge" | "settings" | null;

export default function App() {
  const chat = useChat();
  const [modal, setModal] = useState<Modal>(null);

  const handleNewConversation = async () => {
    const id = await chat.createConversation();
    await chat.selectConversation(id);
  };

  if (chat.status === "loading-models" && !chat.config) {
    return (
      <div className="splash">
        <div className="spinner" />
        <p>Initialising database…</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        conversations={chat.conversations}
        activeConvId={chat.activeConvId}
        onSelect={chat.selectConversation}
        onCreate={handleNewConversation}
        onDelete={chat.removeConversation}
        onShowKnowledge={() => setModal("knowledge")}
        onShowSettings={() => setModal("settings")}
      />

      <main className="main-area">
        {/* Status bar */}
        {(chat.status === "loading-models" || chat.status === "embedding") && (
          <div className="status-bar">
            <span className="spinner-sm" />
            {chat.status === "loading-models"
              ? "Loading models…"
              : "Embedding…"}
          </div>
        )}

        {chat.error && (
          <div className="error-bar">
            ⚠️ {chat.error}
            <button onClick={chat.clearError}>✕</button>
          </div>
        )}

        <ChatPane
          messages={chat.messages}
          streamingContent={chat.streamingContent}
          status={chat.status}
          onSend={chat.sendMessage}
          onNewConversation={handleNewConversation}
        />
      </main>

      {modal === "knowledge" && chat.config && (
        <KnowledgePanel
          chunks={chat.knowledgeChunks}
          status={chat.status}
          onIngest={chat.ingestText}
          onDelete={chat.removeKnowledgeChunk}
          onClose={() => setModal(null)}
        />
      )}

      {modal === "settings" && chat.config && (
        <SettingsPanel
          config={chat.config}
          onSave={chat.updateConfig}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
