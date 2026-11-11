import { Component, type ReactNode } from "react";

// Catches a view that fails to render (in practice: its lazy chunk could not be fetched
// even after the one automatic reload in views/index.ts, e.g. the manager is down) so
// the sidebar stays usable instead of React unmounting the whole app. `resetKey` (the
// route path) clears the error when the user navigates elsewhere.
interface Props {
  resetKey: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  key: string;
}

export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: Props,
    state: State,
  ): Partial<State> | null {
    return props.resetKey !== state.key
      ? { error: null, key: props.resetKey }
      : null;
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ color: "var(--text-dim)" }}>
        <p>This view failed to load: {this.state.error.message}</p>
        <button
          className="btn btn-ghost"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    );
  }
}
