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

/**
 * How the widget gets the user out to the IdP and the authorization code back.
 *
 * `popup`    keeps the hosting page alive, so the widget instance that started the
 *            flow is the same one that finishes it. The popup lands on the redirect
 *            URI, where a *second* instance of this widget picks up the code and
 *            posts it back to its opener.
 * `redirect` navigates the whole page. The starting widget instance is destroyed;
 *            continuity comes from `sessionStorage` alone.
 */
export type FlowMode = "popup" | "redirect";

export interface OauthConfig {
  clientId: string;
  authorizeUri: string;
  tokenUri: string;
  /**
   * Must match a registered redirect URI *byte for byte* — Staffbase ID does exact
   * matching, so the trailing slash matters and extra query params will be rejected.
   */
  redirectUri: string;
  scopes: string;
  logoutUri: string;
  flowMode: FlowMode;
  /** Same-origin path used by the "Call API" button to prove the token works. */
  testApiPath: string;
  /**
   * Same-origin endpoint that reports who the access token belongs to, used to prove the
   * token is bound to the acting user rather than being app-wide.
   */
  identityPath: string;
  /**
   * A second OAuth client whose redirect URI is the native webview's custom scheme
   * (e.g. `capacitor://staffbase.com/`). Empty disables the native attempt entirely.
   *
   * A separate client is required because a single client cannot hold both an HTTPS and a
   * custom-scheme redirect URI for the *same* flow — the redirect URI sent must match the
   * origin the code has to come back to, and that origin differs between web and native.
   */
  nativeClientId: string;
  nativeRedirectUri: string;
  /**
   * Absolute base for API calls in the **native webview only**. A relative `/api/users`
   * there resolves to `capacitor://staffbase.com/api/users`, which Capacitor's internal
   * scheme handler serves from local assets instead of reaching the Staffbase API.
   *
   * Ignored on the web, where the current origin is by definition the right one.
   */
  apiBaseUrl: string;
  /**
   * Staffbase deep-link URL for this widget's own plugin instance, of the form
   * `https://<app>/openlink/content/<pluginID>/<pluginInstanceID>/`.
   *
   * Used to bridge the one gap iOS creates: a universal link fires on a user *tap* but not
   * as the target of an HTTP redirect, so the IdP's 302 always lands in the system browser.
   * When the widget finds an authorization code but no verifier — i.e. it is running in the
   * browser, while the flow was started in the app — it offers this as a link to tap, and
   * the code travels back into the app where the verifier still lives.
   *
   * Empty disables the handoff.
   */
  openlinkUrl: string;
}

/**
 * Registration of the `oauth-client` SPA client in Staffbase ID (US1), for the
 * `ccmuhammadtest.staffbase.rocks` app.
 *
 * Nothing here is secret: a public OAuth client has no client secret, which is the
 * whole reason PKCE exists.
 */
export const defaultConfig: OauthConfig = {
  clientId: "eeabfffc-6741-4f75-818a-12dac1e634e7",
  authorizeUri: "https://id-us1.staffbase.com/oauth2/auth",
  tokenUri: "https://id-us1.staffbase.com/oauth2/token",
  /**
   * Defaults to the origin the widget is actually served from, because the flow only
   * works when the code comes back to *this* origin — see `configurationBlockers`. The
   * registered redirect URI has to be updated to match; a hardcoded value from a
   * different environment silently breaks everything.
   */
  redirectUri: `${window.location.origin}/`,
  /**
   * A deliberate subset of what the client is granted: the registration also allows
   * `Users.Manage.All` and `installations:manage:all`, which a read-only test widget has
   * no business holding a token for. Widen via the `scopes` attribute if needed.
   */
  scopes: "offline Users.Read.All Groups.Read.All",
  logoutUri: "https://id-us1.staffbase.com/oauth2/sessions/logout",
  flowMode: "popup",
  testApiPath: "/api/users?limit=3",
  identityPath: "/auth/discover",
  /**
   * Empty on purpose: the native flow was tried on iOS and does not work.
   *
   * `location.assign` to the IdP is handed to the system browser rather than staying in
   * the webview, and Safari then cannot deliver the `capacitor://` redirect back —
   * "Safari cannot open the page because the address is invalid", because `capacitor://`
   * is not registered as an external URL scheme for the app.
   *
   * Set `native-client-id` (e.g. to the `native_oauth_test` client
   * `c725e000-2bc8-487c-885c-a18758ff060f`) to re-attempt, should the app ever register
   * the scheme. Until then the blocker message is more useful than a broken redirect.
   */
  nativeClientId: "",
  nativeRedirectUri: "capacitor://staffbase.com/",
  /**
   * Hardcoded to the test app rather than left empty, because under `capacitor://` the
   * app's HTTPS origin cannot be derived from `window.location` — the webview host is
   * `staffbase.com`, not the app. Override via `api-base-url` for a different app.
   */
  apiBaseUrl: "https://ccmuhammad.staffbase.com",
  openlinkUrl: "",
};

/**
 * DOM attribute names, which Staffbase requires to be kebab-case. This is the single
 * source of truth shared by the block definition, the configuration schema and
 * `resolveConfig`.
 */
export const oauthAttributes = [
  "client-id",
  "authorize-uri",
  "token-uri",
  "redirect-uri",
  "scopes",
  "logout-uri",
  "flow-mode",
  "test-api-path",
  "identity-path",
  "native-client-id",
  "native-redirect-uri",
  "api-base-url",
  "openlink-url",
] as const;

export type OauthAttributeName = (typeof oauthAttributes)[number];

/**
 * Widget attributes arrive as strings (or not at all). Fold them onto the defaults so
 * an unconfigured widget still runs against the registration above.
 */
export const resolveConfig = (attrs: Record<string, unknown>): OauthConfig => {
  const str = (key: string, fallback: string): string => {
    const value = attrs[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
  };

  const flowMode = str("flow-mode", defaultConfig.flowMode);

  return {
    clientId: str("client-id", defaultConfig.clientId),
    authorizeUri: str("authorize-uri", defaultConfig.authorizeUri),
    tokenUri: str("token-uri", defaultConfig.tokenUri),
    redirectUri: str("redirect-uri", defaultConfig.redirectUri),
    scopes: str("scopes", defaultConfig.scopes),
    logoutUri: str("logout-uri", defaultConfig.logoutUri),
    flowMode: flowMode === "redirect" ? "redirect" : "popup",
    testApiPath: str("test-api-path", defaultConfig.testApiPath),
    identityPath: str("identity-path", defaultConfig.identityPath),
    nativeClientId: str("native-client-id", defaultConfig.nativeClientId),
    nativeRedirectUri: str("native-redirect-uri", defaultConfig.nativeRedirectUri),
    apiBaseUrl: str("api-base-url", defaultConfig.apiBaseUrl),
    openlinkUrl: str("openlink-url", defaultConfig.openlinkUrl),
  };
};

/**
 * Pick the client to use for the environment we are actually running in.
 *
 * On the web nothing changes. In the native webview, swap to the custom-scheme client and
 * force `redirect` mode — `window.open` returns null there, so popup mode has nothing to
 * poll, and the redirect keeps the callback on the `capacitor://` origin where the PKCE
 * verifier lives.
 */
export const forEnvironment = (config: OauthConfig, nativeWebview: boolean): OauthConfig => {
  if (!nativeWebview) {
    return config;
  }

  // Always redirect in the webview: window.open returns null there, so popup mode has
  // nothing to poll.
  const flowMode = "redirect" as const;

  if (config.nativeClientId !== "") {
    return { ...config, clientId: config.nativeClientId, redirectUri: config.nativeRedirectUri, flowMode };
  }

  // No dedicated native client: attempt the HTTPS callback with the web client.
  //
  // An explicitly configured HTTPS `redirect-uri` wins, so one field can serve both web and
  // native — which matters because the callback should land on the *page* the widget sits
  // on, not the app root. Only when it is still the webview's own `capacitor://` origin
  // (the default) do we fall back to `apiBaseUrl`, since the app's HTTPS origin cannot be
  // derived from `window.location` here.
  const configuredIsHttps = /^https?:\/\//.test(config.redirectUri);

  return {
    ...config,
    redirectUri: configuredIsHttps
      ? config.redirectUri
      : config.apiBaseUrl !== ""
        ? `${config.apiBaseUrl}/`
        : config.redirectUri,
    flowMode,
  };
};

/** True when a dedicated native client is configured, rather than reusing the web one. */
export const usingNativeClient = (config: OauthConfig, nativeWebview: boolean): boolean =>
  nativeWebview && config.nativeClientId !== "";
