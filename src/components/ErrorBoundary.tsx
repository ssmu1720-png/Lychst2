import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
  isFirestorePermissionError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    errorMessage: '',
    isFirestorePermissionError: false,
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    let parsedMsg = error.message || 'An unexpected application error occurred.';
    let isFirestorePerm = false;
    try {
      const parsed = JSON.parse(error.message) as { error?: string; operationType?: string; path?: string };
      if (parsed && typeof parsed.error === 'string' && parsed.operationType) {
        isFirestorePerm = true;
        parsedMsg = `Cloud database (${parsed.operationType} on ${parsed.path || 'document'}): ${parsed.error}`;
      }
    } catch {
      // Not a serialized FirestoreErrorInfo JSON payload
    }

    return {
      hasError: true,
      errorMessage: parsedMsg,
      isFirestorePermissionError: isFirestorePerm,
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Unhandled application error:', error, errorInfo);
  }

  private handleReset = () => {
    this.setState({
      hasError: false,
      errorMessage: '',
      isFirestorePermissionError: false,
    });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#080305] px-4 text-slate-200">
          <div className="w-full max-w-md rounded-xl border border-red-500/40 bg-[#12070a] p-6 shadow-xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-red-500/40 bg-red-500/15">
                <AlertTriangle className="h-5 w-5 text-red-400" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-100">
                  {this.state.isFirestorePermissionError
                    ? 'Cloud Sync Security Guard'
                    : 'Something went wrong'}
                </h2>
                <p className="text-xs text-slate-400">
                  Lyrihost safely paused rendering to protect your session data.
                </p>
              </div>
            </div>

            <div className="rounded-md border border-red-950/90 bg-[#080305] p-3 font-mono text-[11px] text-red-200 break-words">
              {this.state.errorMessage}
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={this.handleReset}
                className="inline-flex items-center gap-1.5 rounded-md border border-red-500/45 bg-red-600/25 px-3.5 py-2 text-xs font-semibold text-red-100 hover:bg-red-600/40"
              >
                <RotateCw className="h-3.5 w-3.5" />
                Recover Workspace
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
