interface Props {
  onSelectChat: () => void;
  onSelectRetail: () => void;
  onSelectOracle: () => void;
  onSelectFitness: () => void;
  onSelectStudio: () => void;
  onSelectAccessibility: () => void;
  onSelectTasks: () => void;
  onSelectInspection: () => void;
  onSelectClinical: () => void;
  onSelectPhotos: () => void;
  onSelectAnnotate: () => void;
  onSelectCropDisease: () => void;
  onSelectSettings: () => void;
  logMessages?: string[];
}

interface NavEntry {
  icon: string;
  title: string;
  desc: string;
  action: () => void;
  accent?: string;
}

export function WelcomeScreen({
  onSelectChat, onSelectRetail, onSelectOracle,
  onSelectFitness, onSelectStudio, onSelectAccessibility, onSelectTasks,
  onSelectInspection, onSelectClinical, onSelectPhotos, onSelectAnnotate,
  onSelectCropDisease, onSelectSettings,
  logMessages,
}: Props) {

  const groups: { label: string; entries: NavEntry[] }[] = [
    {
      label: "AI Assistant",
      entries: [
        { icon: "💬", title: "AI Assistant", desc: "On-device chat, knowledge base RAG, full privacy.", action: onSelectChat },
      ],
    },
    {
      label: "On-Device Vision",
      entries: [
        { icon: "🏋️", title: "Fitness Coach",     desc: "Pose detection + joint angle analysis + AI form feedback.",    action: onSelectFitness },
        { icon: "🎨", title: "Background Studio", desc: "Replace your background in photos or live camera, on device.", action: onSelectStudio },
        { icon: "🔍", title: "Scene Describer",   desc: "Object detection + natural language scene narration.",          action: onSelectAccessibility },
        { icon: "🌿", title: "Crop Disease",      desc: "Two-stage edge AI: leaf detection → disease classification, fully offline.", action: onSelectCropDisease },
      ],
    },
    {
      label: "Enterprise",
      entries: [
        { icon: "👗", title: "Fashion Shop",       desc: "Browse and search clothing by text or photo.",                       action: onSelectRetail },
        { icon: "◈",  title: "Fashion Oracle",     desc: "Speak or photograph — AI finds your matching style.",                action: onSelectOracle, accent: "oracle" },
        { icon: "🔦", title: "Field Inspection",   desc: "AI issue detection, structured reports, CouchbaseLite + sync.",      action: onSelectInspection },
        { icon: "🩺", title: "Clinical Notes",     desc: "SOAP notes, PHI field-level encryption, vector case search.",        action: onSelectClinical },
        { icon: "📷", title: "Photo Library",      desc: "On-device object detection + semantic search. Google Photos, private.", action: onSelectPhotos },
        { icon: "🏷️", title: "Dataset Annotator", desc: "Team image labelling with EfficientDet proposals, FTS, vector search, CBL sync.", action: onSelectAnnotate },
      ],
    },
    {
      label: "Configuration",
      entries: [
        { icon: "🔬", title: "Task Models", desc: "Run TFLite models directly — detection, pose, depth, and more.",      action: onSelectTasks },
        { icon: "⚙️", title: "Settings",    desc: "Models, accelerator, RAG, wake word, TTS — global app configuration.", action: onSelectSettings },
      ],
    },
  ];

  return (
    <div className="welcome-screen">
      <div className="welcome-content">
        <div className="welcome-hero">
          <h1 className="welcome-title">Welcome</h1>
          <p className="welcome-subtitle">On-device AI · CouchbaseLite · LiteRT</p>
        </div>

        {groups.map((group) => (
          <section key={group.label} className="welcome-section">
            <p className="welcome-section-label">{group.label}</p>
            <div className="welcome-grid">
              {group.entries.map((e) => (
                <button
                  key={e.title}
                  className={`welcome-tile ${e.accent ? `welcome-tile--${e.accent}` : ""}`}
                  onClick={e.action}
                >
                  <span className="welcome-tile-icon">{e.icon}</span>
                  <div className="welcome-tile-body">
                    <span className="welcome-tile-title">{e.title}</span>
                    <span className="welcome-tile-desc">{e.desc}</span>
                  </div>
                  <span className="welcome-tile-arrow">›</span>
                </button>
              ))}
            </div>
          </section>
        ))}

        {logMessages && logMessages.length > 0 && (
          <div className="splash-log">
            {logMessages.map((m, i) => <p key={i}>{m}</p>)}
          </div>
        )}
      </div>
    </div>
  );
}
