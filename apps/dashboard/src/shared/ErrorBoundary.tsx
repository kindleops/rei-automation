import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  label?: string
  resetKey?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[DASHBOARD_ROUTE_RENDER_ERROR]', {
      label: this.props.label ?? null,
      resetKey: this.props.resetKey ?? null,
      message: error.message,
      componentStack: info.componentStack,
    })
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

    return (
      <div className="app-state">
        <div className="app-state__panel">
          <span className="app-state__eyebrow">Render Error</span>
          <h1>{this.props.label || 'Dashboard surface'} crashed</h1>
          <p>{this.state.error.message || 'An unexpected render error occurred.'}</p>
          <button
            className="app-state__button"
            type="button"
            onClick={() => this.setState({ error: null })}
          >
            Retry surface
          </button>
        </div>
      </div>
    )
  }
}
