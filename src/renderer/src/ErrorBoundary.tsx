import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** Catches render errors so a bad data shape shows a message instead of a black window. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    // The component stack is the only way to locate a render crash from the
    // main-process log (the console-message bridge flattens objects).
    console.error('[renderer] crashed:', error?.stack ?? String(error), '\ncomponent stack:', info?.componentStack ?? '(none)')
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: '#e6e9f0', fontFamily: 'Segoe UI, monospace', background: '#0f1117', minHeight: '100vh' }}>
          <h2>Something went wrong</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#e5484d' }}>{String(this.state.error)}</pre>
          <button
            style={{ padding: '8px 14px', borderRadius: 6, border: '1px solid #262c3a', background: '#4f8cff', color: '#fff', cursor: 'pointer' }}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
