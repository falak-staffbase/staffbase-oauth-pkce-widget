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
  };
};
