// One bad surface must never kill the rest of the content script: a crashed
// sticky would otherwise unmount the window, the capture bar, and every
// other sticky with it — the user just sees "the button does nothing".
import { Component, type ReactNode } from "react";

export class SurfaceBoundary extends Component<
  { name: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error(`[bb-plugin-notes] ${this.props.name} crashed:`, error);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
