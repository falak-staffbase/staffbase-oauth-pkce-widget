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

import { savePendingCode } from "./storage";

export const CALLBACK_MESSAGE_TYPE = "sb-oauth-client:callback";

export interface AuthorizationResponse {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

export interface CallbackMessage {
  type: typeof CALLBACK_MESSAGE_TYPE;
  payload: AuthorizationResponse;
}

export const parseAuthorizationResponse = (search: string): AuthorizationResponse => {
  const params = new URLSearchParams(search);
  return {
    code: params.get("code") ?? undefined,
    state: params.get("state") ?? undefined,
    error: params.get("error") ?? undefined,
    errorDescription: params.get("error_description") ?? undefined,
  };
};

export const hasAuthorizationResponse = (response: AuthorizationResponse): boolean =>
  Boolean(response.code ?? response.error);

/**
 * Strip the authorization response from the address bar so the code does not sit in
 * browser history, get leaked through `Referer`, or get replayed if the user reloads.
 */
const cleanUrl = (): void => {
  const { pathname, hash } = window.location;
  window.history.replaceState(window.history.state, "", `${pathname}${hash}`);
};

/**
 * Snapshot the authorization response *at module-evaluation time*.
 *
 * This is the earliest point the widget bundle can observe the URL. The Staffbase SPA
 * owns the router on the redirect URI (`/`) and may rewrite the location before React
 * ever mounts, so reading `window.location.search` inside a component or effect is a
 * race we would sometimes lose. Reading it here — and immediately parking the result in
 * `sessionStorage` — turns "did the SPA rewrite the URL yet?" into a non-question.
 */
const snapshot: AuthorizationResponse = parseAuthorizationResponse(window.location.search);

if (snapshot.code && snapshot.state) {
  savePendingCode({ code: snapshot.code, state: snapshot.state });
}

if (hasAuthorizationResponse(snapshot)) {
  cleanUrl();
}

export const authorizationResponse = (): AuthorizationResponse => snapshot;

/**
 * True when this document is the popup that the IdP redirected back to, rather than the
 * page that started the flow. `window.opener` is the only reliable signal — both
 * documents run the same bundle at the same origin.
 */
export const isPopupCallback = (): boolean => {
  try {
    return Boolean(window.opener) && window.opener !== window && hasAuthorizationResponse(snapshot);
  } catch {
    // Cross-origin `opener` access can throw; if we cannot read it, assume we are not a popup.
    return false;
  }
};

/**
 * Hand the authorization response to the widget instance that started the flow, then
 * close. The code never leaves the origin: `targetOrigin` is pinned to our own origin
 * so a hijacked opener on another origin cannot receive it.
 */
export const respondToOpener = (): void => {
  const message: CallbackMessage = { type: CALLBACK_MESSAGE_TYPE, payload: snapshot };
  window.opener?.postMessage(message, window.location.origin);
  window.close();
};
