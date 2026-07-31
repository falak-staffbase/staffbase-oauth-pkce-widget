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

import React, { CSSProperties, ReactElement, useEffect, useMemo, useState } from "react";
import { BlockAttributes, WidgetApi } from "widget-sdk";

import { isPopupCallback, respondToOpener } from "./oauth/callback";
import { capacitorFindings, inspectCapacitor, PopupProbe, probePopup } from "./oauth/capacitor";
import { forEnvironment, OauthAttributeName, resolveConfig, usingNativeClient } from "./oauth/config";
import {
  configurationBlockers,
  environmentBlockers,
  environmentWarnings,
  inspectEnvironment,
  isCrossSite,
  registrableDomain,
} from "./oauth/environment";
import { compareIdentity, fetchTokenIdentity, IdentityComparison, TokenIdentity } from "./oauth/identity";
import { useOauth } from "./oauth/use-oauth";

/**
 * What arrives from DOM attributes. An intersection rather than an `extends`: every
 * attribute is optional (the widget falls back to the registered defaults), which an
 * interface cannot express against `BlockAttributes`' index signature.
 */
export type OauthClientAttributes = BlockAttributes & Partial<Record<OauthAttributeName, string>>;

/**
 * What the component receives. Deliberately *not* intersected with `BlockAttributes`:
 * its `string | number | boolean` index signature would reject `widgetApi`, which is an
 * object and therefore cannot travel as a DOM attribute.
 */
export type OauthClientProps = Partial<Record<OauthAttributeName, string>> & {
  contentLanguage: string;
  /** Supplied by the block factory, not by a DOM attribute. Absent in unit tests. */
  widgetApi?: Pick<WidgetApi, "getUserInformation">;
};

const styles: Record<string, CSSProperties> = {
  card: {
    border: "1px solid #e0e0e0",
    borderRadius: 6,
    padding: 16,
    fontFamily: "inherit",
    fontSize: 14,
    lineHeight: 1.5,
  },
  row: { display: "flex", flexWrap: "wrap", gap: 8, margin: "12px 0" },
  button: {
    padding: "8px 14px",
    borderRadius: 4,
    border: "1px solid #c0c0c0",
    background: "#fff",
    cursor: "pointer",
    font: "inherit",
  },
  pre: {
    background: "#f7f7f7",
    border: "1px solid #ececec",
    borderRadius: 4,
    padding: 10,
    margin: 0,
    overflowX: "auto",
    fontSize: 12,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  error: {
    background: "#fdecea",
    border: "1px solid #f5c6c2",
    borderRadius: 4,
    padding: 10,
    color: "#8a1c14",
  },
  warning: {
    background: "#fff8e1",
    border: "1px solid #ffe0a3",
    borderRadius: 4,
    padding: 10,
    color: "#6b4e00",
  },
  label: { fontWeight: 600 },
};

/**
 * Access tokens are the point of the widget, but showing one in full invites it being
 * pasted into a ticket. Show enough to identify it, not enough to use it.
 */
const abbreviate = (value: string): string =>
  value.length <= 24 ? value : `${value.slice(0, 12)}…${value.slice(-8)} (${value.length} chars)`;

const formatTime = (at: number): string => new Date(at).toISOString().slice(11, 23);

/**
 * The document the IdP redirected back to when running in popup mode.
 *
 * This is the same widget bundle as the one that started the flow — the redirect URI is
 * the Staffbase app root, so the popup boots the whole SPA and mounts this widget again.
 * All it has to do is hand the response to its opener and get out of the way.
 */
const PopupCallback = (): ReactElement => {
  useEffect(() => {
    respondToOpener();
  }, []);

  return (
    <div style={styles.card}>
      <p>Completing sign-in — you can close this window.</p>
    </div>
  );
};

export const OauthClient = (props: OauthClientProps): ReactElement => {
  /** Static for the document's lifetime, and needed before the flow is configured. */
  const environment = useMemo(inspectEnvironment, []);
  const capacitor = useMemo(inspectCapacitor, []);

  // Swaps in the custom-scheme client and forces redirect mode inside the native webview.
  const config = forEnvironment(resolveConfig(props), environment.nativeWebview);
  const native = usingNativeClient(config, environment.nativeWebview);

  const oauth = useOauth(config, environment);
  const [apiResult, setApiResult] = useState<string | null>(null);
  const [identity, setIdentity] = useState<{ comparison: IdentityComparison; probe: TokenIdentity } | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [popupProbe, setPopupProbe] = useState<PopupProbe | null>(null);

  /**
   * Base for API calls.
   *
   * Consulted *only* in the native webview: under `capacitor://` a relative path is served
   * from local assets by Capacitor's scheme handler rather than reaching the Staffbase API.
   * On the web the current origin is always right — it is the origin the OAuth client is
   * registered against — so it wins there regardless of what `api-base-url` says.
   */
  const apiBase =
    environment.nativeWebview && config.apiBaseUrl !== "" ? config.apiBaseUrl : window.location.origin;

  /**
   * The decisive check that this is a user-context token: ask the API who the token
   * belongs to, and compare against who the platform says is viewing the page.
   */
  const verifyIdentity = (): void => {
    if (!oauth.tokens || !props.widgetApi) return;

    setIdentity(null);
    setIdentityError("Checking…");

    void Promise.all([
      fetchTokenIdentity(config.identityPath, oauth.tokens, apiBase),
      props.widgetApi.getUserInformation(),
    ])
      .then(([probe, profile]) => {
        setIdentityError(null);
        setIdentity({ comparison: compareIdentity(probe.userId, profile.id ?? null), probe });
      })
      .catch((cause: unknown) => setIdentityError(`Identity check failed: ${String(cause)}`));
  };

  /**
   * `testApiPath` is normally relative, so it resolves against the origin the widget is
   * served from — which is the same app the OAuth client is registered in, and therefore
   * the only app whose API this token means anything to. Resolving it eagerly lets the UI
   * show the absolute URL, so it is obvious which app is being called.
   */
  const apiUrl = ((): string => {
    try {
      return new URL(config.testApiPath, apiBase).href;
    } catch {
      return config.testApiPath;
    }
  })();

  const callTestApi = (): void => {
    if (!oauth.tokens) return;

    setApiResult("Calling…");
    void fetch(apiUrl, {
      headers: { Authorization: `${oauth.tokens.tokenType} ${oauth.tokens.accessToken}` },
    })
      .then(async (response) => {
        const body = await response.text();
        setApiResult(`HTTP ${response.status}\n\n${body.slice(0, 2000)}`);
      })
      .catch((cause: unknown) => setApiResult(`Request failed: ${String(cause)}`));
  };

  if (isPopupCallback()) {
    return <PopupCallback />;
  }

  const { status, tokens, error } = oauth;
  const busy = status === "authorizing" || status === "exchanging";
  const blockers = [
    ...environmentBlockers(oauth.environment, { nativeFlowConfigured: config.nativeClientId !== "" }),
    ...configurationBlockers(config.redirectUri, oauth.environment),
  ];
  const warnings = environmentWarnings(oauth.environment, config.authorizeUri);

  return (
    <div style={styles.card}>
      <div>
        <span style={styles.label}>Status:</span> {status}
        {" · "}
        <span style={styles.label}>Mode:</span> {config.flowMode}
      </div>

      {blockers.length > 0 && (
        <div role="alert" style={{ ...styles.error, marginTop: 12 }}>
          <p style={{ ...styles.label, marginTop: 0 }}>This environment cannot complete an OAuth flow</p>
          {blockers.map((blocker) => (
            <p key={blocker} style={{ marginBottom: 0 }}>
              {blocker}
            </p>
          ))}
        </div>
      )}

      {/* Warnings, unlike blockers, never disable sign-in — they explain a failure if one comes. */}
      {warnings.length > 0 && (
        <div style={{ ...styles.warning, marginTop: 12 }}>
          <p style={{ ...styles.label, marginTop: 0 }}>Heads up</p>
          {warnings.map((warning) => (
            <p key={warning} style={{ marginBottom: 0 }}>
              {warning}
            </p>
          ))}
        </div>
      )}

      <div style={styles.row}>
        <button
          style={styles.button}
          onClick={oauth.login}
          disabled={busy || blockers.length > 0}
          // Surfaced on the button itself: on a phone the blocker banner may be scrolled
          // out of view, leaving a disabled button with no visible explanation.
          title={blockers.length > 0 ? blockers[0] : undefined}
        >
          {tokens ? "Re-authorize" : "Sign in with Staffbase ID"}
          {blockers.length > 0 ? " (blocked — see above)" : ""}
        </button>
        <button style={styles.button} onClick={oauth.refresh} disabled={!tokens?.refreshToken}>
          Refresh token
        </button>
        <button style={styles.button} onClick={callTestApi} disabled={!tokens}>
          Call API
        </button>
        <button
          style={styles.button}
          onClick={verifyIdentity}
          disabled={!tokens || !props.widgetApi}
          title={props.widgetApi ? undefined : "widgetApi is only available when hosted by Staffbase"}
        >
          Verify identity
        </button>
        <button style={styles.button} onClick={oauth.reset} disabled={!tokens && status === "idle"}>
          Clear local state
        </button>
        <button style={styles.button} onClick={oauth.logout}>
          Logout at IdP
        </button>
      </div>

      {error && (
        <div role="alert" style={styles.error}>
          {error}
        </div>
      )}

      {oauth.returnTo && status === "authenticated" && (
        <p>
          You started this flow at <a href={oauth.returnTo}>{oauth.returnTo}</a>.
        </p>
      )}

      {oauth.callback && (
        <>
          <p style={styles.label}>Authorization callback</p>
          <pre style={styles.pre}>
            {[
              `code:            ${oauth.callback.code}`,
              `state:           ${oauth.callback.state}`,
              `code_verifier:   ${oauth.callback.codeVerifier}`,
              `code_challenge:  ${oauth.callback.codeChallenge}`,
              `challenge method: S256  (= BASE64URL(SHA256(verifier)))`,
              `collected via:   ${oauth.callback.collectedVia}`,
            ].join("\n")}
          </pre>
          <p style={{ fontSize: 12, color: "#767676", margin: "4px 0 12px" }}>
            The code is single-use and already spent — but the verifier is shown in full, so treat this panel as
            sensitive and keep it out of screenshots.
          </p>
        </>
      )}

      {tokens && (
        <>
          <p style={styles.label}>Token</p>
          <pre style={styles.pre}>
            {[
              `token_type:    ${tokens.tokenType}`,
              `access_token:  ${abbreviate(tokens.accessToken)}`,
              `refresh_token: ${tokens.refreshToken ? abbreviate(tokens.refreshToken) : "(none — was `offline` granted?)"}`,
              `scope:         ${tokens.scope ?? "(not reported)"}`,
              `expires_at:    ${tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : "(not reported)"}`,
            ].join("\n")}
          </pre>
        </>
      )}

      {apiResult && (
        <>
          <p style={styles.label}>
            {"GET "}
            {apiUrl}
          </p>
          <pre style={styles.pre}>{apiResult}</pre>
        </>
      )}

      {identityError && <p style={styles.pre}>{identityError}</p>}

      {identity && (
        <>
          <p style={styles.label}>Identity check</p>
          <div
            style={
              identity.comparison.verdict === "match"
                ? { ...styles.pre, background: "#eaf6ec", border: "1px solid #c3e6cb" }
                : styles.error
            }
          >
            <p style={{ ...styles.label, marginTop: 0 }}>
              {identity.comparison.verdict === "match"
                ? "MATCH — token is bound to the acting user"
                : identity.comparison.verdict === "mismatch"
                  ? "MISMATCH — token is not the viewing user"
                  : "INCONCLUSIVE"}
            </p>
            <p style={{ marginBottom: 0 }}>{identity.comparison.detail}</p>
          </div>
          <pre style={{ ...styles.pre, marginTop: 8 }}>
            {[
              `token user id     (${config.identityPath}): ${identity.comparison.tokenUserId ?? "not found"}`,
              `platform user id  (widgetApi):              ${identity.comparison.platformUserId ?? "not found"}`,
              "",
              `HTTP ${identity.probe.status}`,
              identity.probe.raw,
            ].join("\n")}
          </pre>
        </>
      )}

      <details>
        <summary style={{ cursor: "pointer", fontWeight: 600, margin: "12px 0 8px" }}>Diagnostics</summary>
        <pre style={styles.pre}>
          {[
            `build:            ${typeof __BUILD_TIME__ === "string" ? __BUILD_TIME__ : "unknown"}`,
            "",
            `client:           ${native ? "NATIVE (custom scheme)" : "web"}`,
            `native client set: ${config.nativeClientId === "" ? "NO — native flow disabled" : "yes"}`,
            `client_id:        ${config.clientId}`,
            `redirect_uri:     ${config.redirectUri}`,
            `flow mode:        ${config.flowMode}${native ? "  (forced: window.open is unusable here)" : ""}`,
            `token endpoint:   ${config.tokenUri}`,
            `API base:         ${apiBase}${native ? "  (api-base-url; required under capacitor://)" : "  (current origin)"}`,
            `API call target:  ${apiUrl}`,
            "",
            `scheme:           ${oauth.environment.scheme}${oauth.environment.nativeWebview ? "  ← native webview, not HTTPS" : ""}`,
            `app site:         ${registrableDomain(oauth.environment.origin) ?? "?"}`,
            `idp site:         ${registrableDomain(config.authorizeUri) ?? "?"}`,
            `cross-site:       ${isCrossSite(oauth.environment.origin, config.authorizeUri) ? "YES — ITP applies on Safari/iOS" : "no"}`,
            `webkit engine:    ${oauth.environment.webkit ? "yes (Safari / any iOS browser)" : "no"}`,
            "",
            `in iframe:        ${oauth.environment.framed ? "yes" : "no"}`,
            `origin:           ${oauth.environment.origin}`,
            `opaque origin:    ${oauth.environment.opaqueOrigin ? "YES — sandboxed, popup flow cannot work" : "no"}`,
            `sessionStorage:   ${oauth.environment.storageAvailable ? "available" : "BLOCKED"}`,
            `crypto.subtle:    ${oauth.environment.subtleCryptoAvailable ? "available" : "MISSING"}`,
            `secure context:   ${oauth.environment.secureContext ? "yes" : "no"}`,
          ].join("\n")}
        </pre>
        <p style={{ ...styles.label, marginTop: 12 }}>Native bridge probe</p>
        <pre style={styles.pre}>
          {[
            `Capacitor bridge: ${capacitor.bridgePresent ? "present" : "absent"}`,
            `platform:         ${capacitor.platform ?? "n/a"}`,
            `native platform:  ${capacitor.nativePlatform ?? "n/a"}`,
            `App plugin:       ${capacitor.appPluginPresent ? "reachable" : "not reachable"}`,
            `CapacitorHttp:    ${capacitor.httpPluginPresent ? "present (CORS likely bypassed)" : "not detected"}`,
            `plugins:          ${capacitor.plugins.length > 0 ? capacitor.plugins.join(", ") : "none exposed"}`,
          ].join("\n")}
        </pre>
        {capacitorFindings(capacitor).map((finding) => (
          <p key={finding} style={{ fontSize: 12, color: "#555", margin: "6px 0 0" }}>
            {finding}
          </p>
        ))}

        {/* Needs a user gesture, and must stay available even when the flow is blocked. */}
        <button style={{ ...styles.button, marginTop: 12 }} onClick={() => setPopupProbe(probePopup())}>
          Probe window.open
        </button>
        {popupProbe && (
          <pre style={{ ...styles.pre, marginTop: 8 }}>
            {[
              `opened:            ${popupProbe.opened ? "yes" : "no"}`,
              `opener intact:     ${popupProbe.openerIntact ? "yes" : "no"}`,
              `location readable: ${popupProbe.sameOriginReadable ? "yes" : "no"}`,
              "",
              popupProbe.detail,
            ].join("\n")}
          </pre>
        )}
      </details>

      {oauth.log.length > 0 && (
        <>
          <p style={styles.label}>Flow trace</p>
          <pre style={styles.pre}>
            {oauth.log
              .map((entry) => `${formatTime(entry.at)} ${entry.level === "error" ? "✗" : "·"} ${entry.message}`)
              .join("\n")}
          </pre>
        </>
      )}
    </div>
  );
};
