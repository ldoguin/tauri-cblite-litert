import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary. Catches render-phase exceptions that would
 * otherwise produce a blank white screen and shows a minimal recovery UI.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", height: "100vh", padding: "2rem",
          fontFamily: "system-ui, sans-serif", gap: "1rem",
        }}>
          <h2 style={{ margin: 0 }}>Something went wrong</h2>
          <pre style={{
            background: "#f4f4f4", padding: "1rem", borderRadius: "6px",
            maxWidth: "600px", overflow: "auto", fontSize: "0.8rem",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
          }}>
            {this.state.error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: "0.5rem 1.5rem", cursor: "pointer" }}
          >
            Reload app
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
