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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AuthorizationResponse,
  CALLBACK_MESSAGE_TYPE,
  CallbackMessage,
  hasAuthorizationResponse,
  parseAuthorizationResponse,
} from "./callback";
import { beginAuthorization, buildLogoutUrl, exchangeCode, refreshTokens } from "./client";
import { OauthConfig } from "./config";
import { navigate } from "./navigate";
import {
  configurationBlockers,
  EnvironmentReport,
  environmentBlockers,
  inspectEnvironment,
} from "./environment";
import {
  clearPendingCode,
  clearTokens,
  clearTransaction,
  loadPendingCode,
  loadPendingCodeFrom,
  loadTokens,
  loadTransaction,
  saveTokens,
  saveTransaction,
  TokenSet,
} from "./storage";

export type Status = "idle" | "authorizing" | "exchanging" | "authenticated" | "error";

const POPUP_WIDTH = 520;
const POPUP_HEIGHT = 680;

/**
 * Ask as hard as the platform allows for a separate window rather than a tab.
 *
 * `popup=true` is the spec'd request; the legacy `menubar`/`toolbar`/`location` hints and
 * explicit `left`/`top` are what older Chrome and Firefox heuristics actually look at.
 *
 * This is only ever a *request*. A browser set to "open new windows in a tab", some
 * extensions, and a document under a CSP `sandbox` without
 * `allow-popups-to-escape-sandbox` can all still hand back a tab. That is cosmetic — the
 * opener-side polling completes the flow either way.
 */
const popupFeatures = (): string => {
  // Centre on the screen the browser window is actually on, not the primary display.
  const left = window.screenX + Math.max(0, (window.outerWidth - POPUP_WIDTH) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - POPUP_HEIGHT) / 2);

  return [
    "popup=true",
    `width=${POPUP_WIDTH}`,
    `height=${POPUP_HEIGHT}`,
    `left=${Math.round(left)}`,
    `top=${Math.round(top)}`,
    "menubar=no",
    "toolbar=no",
    "location=no",
    "status=no",
    "resizable=yes",
    "scrollbars=yes",
  ].join(",");
};

export interface LogEntry {
  at: number;
  level: "info" | "error";
  message: string;
}

/**
 * Everything that went into the code-for-token exchange, kept so the widget can show its
 * work. Useful when debugging a PKCE rejection, where the interesting question is whether
 * the challenge the IdP saw really derives from the verifier being sent.
 */
export interface CallbackDebug {
  code: string;
  /** The `state` the IdP returned, which was checked against the stored one. */
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  /** Which of the three collection paths delivered the response. */
  collectedVia: string;
}

export interface OauthState {
  status: Status;
  tokens: TokenSet | null;
  error: string | null;
  log: LogEntry[];
  callback: CallbackDebug | null;
  environment: EnvironmentReport;
  /** Set in the redirect flow: where the user was before being sent to the IdP. */
  returnTo: string | null;
  login: () => void;
  refresh: () => void;
  logout: () => void;
  reset: () => void;
}

/**
 * Drives the authorization-code + PKCE flow from inside the widget.
 *
 * The hook is written so that *either* document can be the one that finishes the flow:
 * in popup mode this instance receives the code over `postMessage`, in redirect mode a
 * freshly mounted instance picks it up out of `sessionStorage`. Both paths converge on
 * `completeFlow`.
 */
export const useOauth = (config: OauthConfig): OauthState => {
  const [status, setStatus] = useState<Status>(() => (loadTokens() ? "authenticated" : "idle"));
  const [tokens, setTokens] = useState<TokenSet | null>(() => loadTokens());
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [callback, setCallback] = useState<CallbackDebug | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);

  /** Fixed for the lifetime of the document, so probe it once. */
  const environment = useMemo(inspectEnvironment, []);

  /** Guards against the pending code being exchanged twice (codes are single-use). */
  const consumed = useRef(false);
  const popup = useRef<Window | null>(null);

  const append = useCallback((level: LogEntry["level"], message: string) => {
    setLog((entries) => [...entries, { at: Date.now(), level, message }]);
  }, []);

  const fail = useCallback(
    (message: string) => {
      append("error", message);
      setError(message);
      setStatus("error");
    },
    [append],
  );

  const completeFlow = useCallback(
    async (response: AuthorizationResponse, collectedVia = "unknown") => {
      if (response.error) {
        clearTransaction();
        fail(`Authorization denied — ${response.error}${response.errorDescription ? `: ${response.errorDescription}` : ""}`);
        return;
      }

      const transaction = loadTransaction();

      if (!transaction) {
        // A `?code=` on the URL with no transaction of ours is not necessarily an
        // attack — it can just be a stale link — but we have no verifier, so stop.
        fail("Received an authorization code but no matching PKCE transaction was found in this tab.");
        return;
      }

      // The CSRF check. Compare before touching the token endpoint.
      if (!response.state || response.state !== transaction.state) {
        clearTransaction();
        fail("State mismatch — discarding the authorization response.");
        return;
      }

      if (!response.code) {
        clearTransaction();
        fail("Authorization response contained no code.");
        return;
      }

      setReturnTo(transaction.returnTo);
      setStatus("exchanging");
      append("info", "State verified. Exchanging code for tokens…");

      // Recorded before the exchange so the panel still shows the inputs if it fails —
      // which is exactly when they matter.
      setCallback({
        code: response.code,
        state: response.state,
        codeVerifier: transaction.codeVerifier,
        codeChallenge: transaction.codeChallenge,
        collectedVia,
      });

      try {
        const next = await exchangeCode(config, response.code, transaction.codeVerifier);
        saveTokens(next);
        setTokens(next);
        setStatus("authenticated");
        setError(null);
        append(
          "info",
          `Token received. scope="${next.scope ?? "(not reported)"}" refresh_token=${next.refreshToken ? "yes" : "no"}`,
        );
      } catch (cause) {
        fail(String(cause instanceof Error ? cause.message : cause));
      } finally {
        clearTransaction();
      }
    },
    [append, config, fail],
  );

  /**
   * Redirect-flow re-entry: the code was snapshotted at module load and parked in
   * `sessionStorage` before React mounted. Pick it up exactly once.
   */
  useEffect(() => {
    if (consumed.current) return;

    const pending = loadPendingCode();
    if (!pending) return;

    consumed.current = true;
    clearPendingCode();
    append("info", "Found an authorization code from a redirect.");
    void completeFlow(pending, "redirect + sessionStorage");
  }, [append, completeFlow]);

  /**
   * Popup-flow re-entry: the callback document posts the response back to us.
   */
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Same-origin only — the popup runs on our own origin.
      if (event.origin !== window.location.origin) return;

      const data = event.data as CallbackMessage | null;
      if (data?.type !== CALLBACK_MESSAGE_TYPE) return;
      if (consumed.current) return;

      consumed.current = true;
      // The popup already parked the code; drop it so a later mount cannot replay it.
      clearPendingCode();
      append("info", "Authorization response received from popup.");
      void completeFlow(data.payload, "popup postMessage");
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [append, completeFlow]);

  const login = useCallback(() => {
    setError(null);
    setStatus("authorizing");
    consumed.current = false;

    void (async () => {
      try {
        // Checked before anything is stored or navigated, and before the mode branch:
        // these conditions defeat redirect mode too. In a native webview the code would
        // come back to the app's HTTPS origin while the verifier sits under
        // `capacitor://`, so redirecting would navigate the app away for nothing.
        const blockers = [
          ...environmentBlockers(environment),
          ...configurationBlockers(config.redirectUri, environment),
        ];
        if (blockers.length > 0) {
          fail(blockers[0]);
          return;
        }

        const returnUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        const { url, transaction } = await beginAuthorization(config, config.flowMode, returnUrl);
        saveTransaction(transaction);
        append("info", `Authorization request built with S256 challenge (mode: ${config.flowMode}).`);

        if (config.flowMode === "redirect") {
          append("info", "Navigating to the IdP — this widget instance is about to be destroyed.");
          navigate(url);
          return;
        }

        const opened = window.open(url, "sb-oauth-client", popupFeatures());

        // A blocked popup is the common case in an iOS in-app WKWebView. Falling back to a
        // full-page redirect keeps the flow completable instead of dead-ending on an error
        // the user can do nothing about. The transaction is already stored, and
        // `sessionStorage` carries it across the navigation.
        if (!opened) {
          append("info", "window.open was blocked — falling back to a full-page redirect.");
          navigate(url);
          return;
        }

        // `opener` severed (WKWebView, or a COOP header) means we can never read the popup
        // back. Detectable immediately, so close it and redirect rather than polling for
        // five minutes.
        let openerIntact = true;
        try {
          openerIntact = opened.opener === window;
        } catch {
          openerIntact = false;
        }

        if (!openerIntact) {
          append("info", "Popup has no usable opener reference — falling back to a full-page redirect.");
          opened.close();
          navigate(url);
          return;
        }

        popup.current = opened;
        append("info", "Popup opened. Waiting for the callback…");
      } catch (cause) {
        fail(String(cause instanceof Error ? cause.message : cause));
      }
    })();
  }, [append, config, environment, fail]);

  /**
   * Watch the popup from the opener side.
   *
   * This — not `postMessage` — is the primary way the popup flow completes. Once the IdP
   * has redirected the popup back to our own origin, the popup is same-origin and we can
   * read its `location` directly. That matters because the redirect URI is the Staffbase
   * app root: there is no guarantee this widget is mounted on that page, so there may be
   * no code of ours running inside the popup to post anything back. Polling from here
   * works regardless.
   *
   * While the popup sits on the IdP's origin, touching `location` throws — that failure
   * is the signal that the user is still authenticating, not an error.
   *
   * It also covers the popup being dismissed, which would otherwise leave the UI stuck
   * on "authorizing" forever.
   */
  useEffect(() => {
    if (status !== "authorizing" || config.flowMode !== "popup") return;

    const finish = (timer: number, response: AuthorizationResponse, via: string) => {
      consumed.current = true;
      window.clearInterval(timer);
      clearPendingCode();
      popup.current?.close();
      append("info", `Authorization response collected from popup (${via}).`);
      void completeFlow(response, `popup ${via}`);
    };

    // If the widget *is* mounted on the redirect page it posts a message and closes
    // itself, which can happen between two ticks. Tolerate one tick of "closed" so that
    // already-queued message has a chance to be delivered before we call it a failure.
    let closedTicks = 0;
    const startedAt = Date.now();
    /** Generous: a real user may need to type credentials and clear an MFA prompt. */
    const deadline = 5 * 60 * 1000;
    /**
     * A freshly opened popup is at `about:blank`, which is same-origin — so "readable"
     * alone does not mean it came back from the IdP. Only count a same-origin sighting
     * once we have seen it go cross-origin, otherwise the timeout message would claim the
     * popup returned when it never left.
     */
    let sawCrossOrigin = false;
    let sawOwnOriginAfterIdp = false;

    const timer = window.setInterval(() => {
      const win = popup.current;
      if (!win || consumed.current) return;

      if (win.closed) {
        if (++closedTicks < 2) return;
        window.clearInterval(timer);
        clearTransaction();
        fail("Popup closed before returning an authorization code.");
        return;
      }

      try {
        // Throws (cross-origin) for as long as the popup is still at the IdP.
        const response = parseAuthorizationResponse(win.location.search);

        if (hasAuthorizationResponse(response)) {
          finish(timer, response, "location");
          return;
        }

        // Same-origin but no query left: the SPA already rewrote the popup's URL. If the
        // widget bundle loaded there it will have parked the code before that happened.
        const parked = loadPendingCodeFrom(win.sessionStorage);
        if (parked) {
          finish(timer, parked, "popup sessionStorage");
          return;
        }

        if (sawCrossOrigin && !sawOwnOriginAfterIdp) {
          sawOwnOriginAfterIdp = true;
          append("info", "Popup is back on our origin but carries no code yet.");
        }
      } catch {
        // Cross-origin: the popup has reached the IdP and the user is authenticating.
        if (!sawCrossOrigin) {
          sawCrossOrigin = true;
          append("info", "Popup reached the IdP (location is cross-origin).");
        }
      }

      if (Date.now() - startedAt > deadline) {
        window.clearInterval(timer);
        clearTransaction();
        fail(
          sawOwnOriginAfterIdp
            ? "Timed out: the popup came back to our origin but no authorization code was ever visible. The SPA may be stripping the query string before we can read it — try redirect mode with this widget on the redirect-URI page."
            : sawCrossOrigin
              ? "Timed out: the popup reached the IdP but never came back to this origin. Either the user did not finish signing in, or the IdP session was not recognised — on Safari/iOS a cross-site IdP is subject to ITP restrictions (see Diagnostics)."
              : "Timed out: the popup never even reached the IdP. Its location stayed readable, which suggests navigation was blocked — likely an in-app WKWebView. Try redirect mode.",
        );
      }
    }, 150);

    return () => window.clearInterval(timer);
  }, [append, completeFlow, config.flowMode, fail, status]);

  const refresh = useCallback(() => {
    if (!tokens) return;

    append("info", "Refreshing the access token…");
    void (async () => {
      try {
        const next = await refreshTokens(config, tokens);
        saveTokens(next);
        setTokens(next);
        setStatus("authenticated");
        setError(null);
        append("info", "Access token refreshed.");
      } catch (cause) {
        fail(String(cause instanceof Error ? cause.message : cause));
      }
    })();
  }, [append, config, fail, tokens]);

  const reset = useCallback(() => {
    clearTokens();
    clearTransaction();
    clearPendingCode();
    consumed.current = false;
    setTokens(null);
    setError(null);
    setCallback(null);
    setReturnTo(null);
    setStatus("idle");
    append("info", "Local token state cleared.");
  }, [append]);

  /**
   * Clearing local tokens is not a logout — the IdP session would sign the user straight
   * back in. Send them through the IdP's logout endpoint too.
   */
  const logout = useCallback(() => {
    reset();
    navigate(buildLogoutUrl(config));
  }, [config, reset]);

  return { status, tokens, error, log, callback, environment, returnTo, login, refresh, logout, reset };
};
