import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallbackName?: string;
  debugInfo?: any;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ error, errorInfo });
    console.error(`[ErrorBoundary caught error in ${this.props.fallbackName || 'Component'}]`, error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '20px',
          background: '#3f1111',
          color: '#ffcccc',
          borderRadius: '8px',
          fontFamily: 'monospace',
          border: '1px solid #ff4444',
          margin: '10px'
        }}>
          <h3 style={{ margin: '0 0 10px 0', color: '#ff6666' }}>
            Crash detected in: {this.props.fallbackName || 'Component'}
          </h3>
          <p style={{ margin: '0 0 10px 0' }}>{this.state.error?.message}</p>
          <div style={{ maxHeight: '200px', overflowY: 'auto', background: '#220000', padding: '10px', fontSize: '11px', whiteSpace: 'pre-wrap' }}>
            {this.state.error?.stack}
          </div>
          {this.props.debugInfo && (
            <div style={{ marginTop: '10px', fontSize: '11px' }}>
              <strong>Debug Info:</strong>
              <pre style={{ margin: '5px 0 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(this.props.debugInfo, null, 2)}
              </pre>
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
