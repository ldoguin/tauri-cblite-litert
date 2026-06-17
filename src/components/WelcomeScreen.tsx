interface Props {
  onSelectChat: () => void;
  onSelectRetail: () => void;
  onSelectOracle: () => void;
  logMessages?: string[];
}

export function WelcomeScreen({ onSelectChat, onSelectRetail, onSelectOracle, logMessages }: Props) {
  return (
    <div className="welcome-screen">
      <div className="welcome-hero">
        <h1 className="welcome-title">Welcome</h1>
        <p className="welcome-subtitle">Choose an experience</p>
      </div>
      <div className="welcome-cards">
        <button className="welcome-card" onClick={onSelectChat}>
          <span className="welcome-card-icon">💬</span>
          <h2 className="welcome-card-title">AI Assistant</h2>
          <p className="welcome-card-desc">
            Chat with your on-device AI, search your knowledge base, and get answers with full privacy.
          </p>
        </button>
        <button className="welcome-card" onClick={onSelectRetail}>
          <span className="welcome-card-icon">👗</span>
          <h2 className="welcome-card-title">Fashion Shop</h2>
          <p className="welcome-card-desc">
            Browse and search clothing by description or upload a photo to find similar items in the local catalog.
          </p>
        </button>
        <button className="welcome-card oracle-card-welcome" onClick={onSelectOracle}>
          <span className="welcome-card-icon">◈</span>
          <h2 className="welcome-card-title">Fashion Oracle</h2>
          <p className="welcome-card-desc">
            Speak or show a photo — the AI decodes your style and reveals matching pieces in an instant.
          </p>
        </button>
      </div>
      {logMessages && logMessages.length > 0 && (
        <div className="splash-log">
          {logMessages.map((m, i) => <p key={i}>{m}</p>)}
        </div>
      )}
    </div>
  );
}
