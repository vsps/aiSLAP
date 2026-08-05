import { Component, Suspense, type ReactNode } from "react";

type Props = {
  /** Rendered while the chunk is in flight. Never pass `null` for a chunk of
   *  any size — a viewer that paints nothing reads as a broken click. */
  fallback: ReactNode;
  /** Rendered if the chunk fails to load. Gets a retry that remounts. */
  onError: (retry: () => void) => ReactNode;
  children: ReactNode;
};

type State = { failed: boolean; nonce: number };

/**
 * Suspense + error boundary for a `React.lazy` component.
 *
 * The error half is the load-bearing part: `main.tsx` installs no boundary of
 * its own, so an un-caught chunk-load failure (corrupt install, half-applied
 * update, a file the antivirus quarantined) propagates to the root and unmounts
 * the entire app to a white screen. Scoping a boundary to the lazy subtree
 * turns that into a dismissable panel.
 */
export class LazyBoundary extends Component<Props, State> {
  state: State = { failed: false, nonce: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("lazy chunk failed to load", error);
  }

  render() {
    if (this.state.failed) {
      return this.props.onError(() =>
        this.setState((s) => ({ failed: false, nonce: s.nonce + 1 })),
      );
    }
    return (
      <Suspense key={this.state.nonce} fallback={this.props.fallback}>
        {this.props.children}
      </Suspense>
    );
  }
}
