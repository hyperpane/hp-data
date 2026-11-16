// The server part, from the window: calls, cancellable calls, subscriptions,
// and saving a stream to a file, all to Data's server part; and the app's
// toasts, menus and dialogs.

import type { useHost } from '@hyperpane/sdk/client';
import { ID } from '../../shared/types.ts';

export type Host = ReturnType<typeof useHost>;

export interface Api {
  host: Host;
  call<T = unknown>(op: string, payload?: Record<string, unknown>): Promise<T>;
  /** A call the signal can cancel (a long query). */
  stream<T = unknown>(op: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<T>;
  /** Events until it ends (onEnd, with the error if it failed) or the
   * returned function is called. */
  subscribe<E = unknown>(op: string, payload: Record<string, unknown>, onEvent: (e: E) => void, onEnd?: (error?: string) => void): () => void;
  /** Asks where, then saves what the call streams there. */
  save(op: string, payload: Record<string, unknown>, name: string): Promise<void>;
  toast(message: string, error?: boolean): void;
  /** The error's message as a toast. */
  fail(e: unknown): void;
  confirm(title: string, message: string, confirm?: string, destructive?: boolean): Promise<boolean>;
  prompt(title: string, label: string, value?: string, placeholder?: string): Promise<string | null>;
  copy(text: string, what?: string): void;
}

export function makeApi(host: Host): Api {
  const api: Api = {
    host,
    call: (op, payload = {}) => host.call(ID, { op, ...payload }),
    stream: (op, payload, signal) => host.stream(ID, { op, ...payload }, { signal }),
    subscribe: (op, payload, onEvent, onEnd) => host.subscribe(ID, { op, ...payload }, onEvent as (e: unknown) => void, { resume: false, onEnd }),
    save: (op, payload, name) => host.app.saveStream(ID, { op, ...payload }, { name }).then(() => undefined),
    toast: (message, error) => host.app.toast(message, { error }),
    fail: (e) => host.app.toast(e instanceof Error ? e.message : String(e), { error: true }),
    confirm: (title, message, confirm, destructive) => host.ui.confirm({ title, message, confirm, destructive }),
    prompt: (title, label, value, placeholder) => host.ui.prompt({ title, label, value, placeholder }),
    copy: (text, what) => {
      void host.app.clipboardWrite({ text }).then(
        () => what && host.app.toast(`Copied ${what}`),
        (e: Error) => api.fail(e),
      );
    },
  };
  return api;
}
