/**
 * Wave H item 8 — the crash state.
 *
 * A blank white frame is the worst possible failure mode for a dashboard:
 * the user cannot tell whether their readings are gone, whether the app is
 * still working, or whether they broke something. So every failure — a render
 * error inside the tree AND an error thrown from an event handler, which React
 * boundaries do NOT catch — lands on one screen that:
 *
 *   · says what happened in a sentence a person can act on,
 *   · promises what did NOT happen (their data is still in this browser),
 *   · shows a short copyable incident id for a bug report,
 *   · offers Try again (re-mounts the tree) and Reload as ways out.
 *
 * Mounted once in `app/layout.tsx`, above every route.
 */

"use client";

import React from 'react';
// Wave U — this class predates hooks, so it subscribes to the locale store
// directly (the same external-store pattern `useSelectedPlan` uses) instead
// of `useTranslation()`. Without the subscription the crash screen would be
// the one surface that stayed English after a toggle.
import { subscribeLocale, t } from '@/i18n';

type Props = { children: React.ReactNode };
type State = {
  error: Error | null;
  incidentId: string | null;
  source: 'render' | 'runtime' | null;
  /** Bumped on every reset so children remount instead of replaying the crash. */
  generation: number;
  copied: boolean;
};

/**
 * Short, stable id for a failure: same cause => same id, so two reports can
 * be matched, and the user can read it over the phone.
 */
export function incidentIdFor(message: string): string {
  let hash = 5381;
  for (let i = 0; i < message.length; i++) {
    hash = ((hash * 33) ^ message.charCodeAt(i)) >>> 0;
  }
  return `ERR-${hash.toString(16).toUpperCase().padStart(6, '0').slice(-6)}`;
}

export default class AppErrorBoundary extends React.Component<Props, State> {
  /** Wave U — teardown for the locale subscription (instance, not state). */
  private unsubscribeLocale?: () => void;

  state: State = {
    error: null,
    incidentId: null,
    source: null,
    generation: 0,
    copied: false,
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      error,
      incidentId: incidentIdFor(`${error.name}:${error.message}`),
      source: 'render',
    };
  }

  componentDidMount() {
    // Errors thrown inside event handlers / async callbacks never reach a
    // React boundary — they would otherwise only appear in the console.
    window.addEventListener('error', this.onWindowError);
    window.addEventListener('unhandledrejection', this.onRejection);
    // Wave U: re-render (in the current language) when the locale flips.
    this.unsubscribeLocale = subscribeLocale(() => this.forceUpdate());
  }

  componentWillUnmount() {
    window.removeEventListener('error', this.onWindowError);
    window.removeEventListener('unhandledrejection', this.onRejection);
    this.unsubscribeLocale?.();
  }

  private onWindowError = (event: ErrorEvent) => {
    // A render error React already handled must not paint the screen twice.
    if (this.state.error) return;
    const error =
      event.error instanceof Error
        ? event.error
        : new Error(event.message || 'Unknown error');
    this.setState({
      error,
      incidentId: incidentIdFor(`${error.name}:${error.message}`),
      source: 'runtime',
    });
  };

  private onRejection = (event: PromiseRejectionEvent) => {
    if (this.state.error) return;
    const reason: unknown = event.reason;
    const error =
      reason instanceof Error ? reason : new Error(String(reason ?? 'Unhandled rejection'));
    this.setState({
      error,
      incidentId: incidentIdFor(`${error.name}:${error.message}`),
      source: 'runtime',
    });
  };

  private reset = () => {
    this.setState((prev) => ({
      error: null,
      incidentId: null,
      source: null,
      generation: prev.generation + 1,
      copied: false,
    }));
  };

  private copyId = async () => {
    const id = this.state.incidentId;
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      this.setState({ copied: true });
    } catch {
      // Clipboard blocked (permissions / insecure context): selecting the
      // id manually still works — it is selectable text.
      this.setState({ copied: false });
    }
  };

  render() {
    const { error, incidentId, source, generation, copied } = this.state;
    if (error) {
      return (
        <main
          role="alert"
          data-testid="crash-screen"
          data-incident-id={incidentId}
          className="min-h-screen bg-slate-50 flex items-center justify-center p-6"
        >
          <div className="max-w-xl w-full bg-white border-4 md:border-8 border-black rounded-[2rem] md:rounded-[3rem] shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] p-6 md:p-10 text-black font-black uppercase">
            <div className="text-[10px] md:text-xs tracking-[0.3em] text-red-600 mb-3">
              {source === 'runtime' ? t('error.runtime') : t('error.render')}
            </div>
            <h1 className="text-3xl md:text-5xl leading-none tracking-tighter mb-4">
              {t('error.headline')}
            </h1>
            <p className="text-[11px] md:text-sm font-bold normal-case text-slate-700 mb-5">
              {t('error.body')}{' '}
              <span className="font-black">{t('error.dataSafe')}</span>{' '}
              {t('error.retryHint')}
            </p>

            <div className="flex flex-wrap items-center gap-3 mb-6">
              <div className="bg-slate-100 border-4 border-black rounded-xl px-3 py-2">
                <div className="text-[8px] md:text-[10px] text-slate-500">{t('error.incidentId')}</div>
                <code
                  data-testid="crash-id"
                  className="text-sm md:text-base font-black select-all"
                >
                  {incidentId}
                </code>
              </div>
              <button
                type="button"
                data-testid="crash-copy"
                onClick={this.copyId}
                className="px-4 py-3 bg-slate-100 border-4 border-black rounded-xl font-black uppercase text-[10px] md:text-xs shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-none transition-all"
              >
                {copied ? t('error.copied') : t('error.copy')}
              </button>
            </div>

            <div className="flex flex-col md:flex-row gap-3">
              <button
                type="button"
                data-testid="crash-reset"
                onClick={this.reset}
                className="flex-1 py-4 bg-yellow-400 border-4 border-black rounded-xl font-black uppercase text-xs md:text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-0.5 active:shadow-none transition-all"
              >
                {t('error.tryAgain')}
              </button>
              <button
                type="button"
                data-testid="crash-reload"
                onClick={() => window.location.reload()}
                className="flex-1 py-4 bg-black text-white border-4 border-black rounded-xl font-black uppercase text-xs md:text-sm shadow-[4px_4px_0px_0px_rgba(37,99,235,1)] active:translate-y-0.5 active:shadow-none transition-all"
              >
                {t('error.reloadPage')}
              </button>
            </div>

            <details className="mt-5 text-left normal-case">
              <summary className="text-[10px] font-black uppercase cursor-pointer">
                {t('error.technicalDetail')}
              </summary>
              <pre
                data-testid="crash-detail"
                className="mt-2 whitespace-pre-wrap break-words text-[10px] font-bold text-slate-600 bg-slate-50 border-2 border-black rounded-lg p-3"
              >
                {error.name}: {error.message}
              </pre>
            </details>
          </div>
        </main>
      );
    }
    return (
      <React.Fragment key={generation}>{this.props.children}</React.Fragment>
    );
  }
}
