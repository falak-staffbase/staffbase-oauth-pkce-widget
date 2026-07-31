/*!
 * Copyright 2026, Staffbase SE and contributors.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FlowMode } from "./config";

const TRANSACTION_KEY = "sb-oauth-client:tx";
const TOKENS_KEY = "sb-oauth-client:tokens";
const PENDING_CODE_KEY = "sb-oauth-client:pending-code";

/**
 * The state that has to outlive a full-page navigation out to the IdP and back.
 *
 * `sessionStorage` is the right scope: it is same-origin, survives navigation within
 * the tab, and dies when the tab does — so a shared device does not leak a verifier
 * into the next session. A popup opened from the tab inherits the same storage area,
 * which is what lets the callback instance validate `state` on its own.
 */
export interface Transaction {
  state: string;
  codeVerifier: string;
  /** Kept alongside the verifier purely so the debug panel can show both halves of PKCE. */
  codeChallenge: string;
  /** Where to send the user back to once the redirect flow completes. */
  returnTo: string;
  mode: FlowMode;
  createdAt: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope?: string;
  /** Absolute epoch ms, not the relative `expires_in` the IdP hands back. */
  expiresAt?: number;
}

/**
 * Storage throws rather than no-ops when it is unavailable (Safari private mode, some
 * embedded webviews). Swallow that so a storage-less browser degrades to "cannot
 * complete the flow" instead of an uncaught error mid-render.
 */
const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

const read = <T>(key: string): T | null =>
  safe(() => {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }, null);

const write = (key: string, value: unknown): void => {
  safe(() => sessionStorage.setItem(key, JSON.stringify(value)), undefined);
};

const remove = (key: string): void => {
  safe(() => sessionStorage.removeItem(key), undefined);
};

export const saveTransaction = (tx: Transaction): void => write(TRANSACTION_KEY, tx);
export const loadTransaction = (): Transaction | null => read<Transaction>(TRANSACTION_KEY);
export const clearTransaction = (): void => remove(TRANSACTION_KEY);

export const saveTokens = (tokens: TokenSet): void => write(TOKENS_KEY, tokens);
export const loadTokens = (): TokenSet | null => read<TokenSet>(TOKENS_KEY);
export const clearTokens = (): void => remove(TOKENS_KEY);

/**
 * Authorization codes are single-use and short-lived, so they get their own slot: the
 * snapshot taken at module load has to survive React mounting, remounting, or a
 * StrictMode double-invoke without the code being replayed or lost.
 */
export interface PendingCode {
  code: string;
  state: string;
}

export const savePendingCode = (pending: PendingCode): void => write(PENDING_CODE_KEY, pending);
export const loadPendingCode = (): PendingCode | null => read<PendingCode>(PENDING_CODE_KEY);
export const clearPendingCode = (): void => remove(PENDING_CODE_KEY);

/**
 * Read a parked code out of *another* same-origin document's storage.
 *
 * Used by the opener to peek into the popup: once the popup is back on our origin it is
 * fully scriptable from here, so if the widget bundle happened to load there and snapshot
 * the code, we can collect it even after the SPA has rewritten the popup's URL.
 */
export const loadPendingCodeFrom = (storage: Storage): PendingCode | null =>
  safe(() => {
    const raw = storage.getItem(PENDING_CODE_KEY);
    return raw ? (JSON.parse(raw) as PendingCode) : null;
  }, null);
