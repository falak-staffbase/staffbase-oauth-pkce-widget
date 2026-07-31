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

import { OauthConfig } from "./config";
import { createCodeChallenge, createCodeVerifier, createState } from "./pkce";
import { TokenSet, Transaction } from "./storage";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
}

/**
 * An `error`/`error_description` pair from the IdP, per RFC 6749 §5.2.
 */
export class OauthError extends Error {
  public constructor(
    public readonly code: string,
    description?: string,
  ) {
    super(description ? `${code}: ${description}` : code);
    this.name = "OauthError";
  }
}

/**
 * Build the `/oauth2/auth` URL and the transaction that has to be remembered in order
 * to finish the flow.
 *
 * The verifier is generated here and *never leaves the browser* — only its SHA-256 hash
 * travels with the authorization request. That is what makes an intercepted code useless
 * to anyone but us.
 */
export const beginAuthorization = async (
  config: OauthConfig,
  mode: Transaction["mode"],
  returnTo: string,
): Promise<{ url: string; transaction: Transaction }> => {
  const codeVerifier = createCodeVerifier();
  const state = createState();
  const codeChallenge = await createCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return {
    url: `${config.authorizeUri}?${params.toString()}`,
    transaction: { state, codeVerifier, codeChallenge, returnTo, mode, createdAt: Date.now() },
  };
};

const toTokenSet = (raw: TokenResponse, previous?: TokenSet): TokenSet => ({
  accessToken: raw.access_token,
  // A refresh_token rotation may omit the new token; keep the one we already hold.
  refreshToken: raw.refresh_token ?? previous?.refreshToken,
  tokenType: raw.token_type ?? "bearer",
  scope: raw.scope ?? previous?.scope,
  expiresAt: raw.expires_in ? Date.now() + raw.expires_in * 1000 : undefined,
});

/**
 * The token endpoint is on a different origin (`id-us1.staffbase.com`) than the widget
 * (`ccmuhammad.staffbase.com`), so this only works because the client registration
 * lists our origin under "Allowed CORS Origins". A CORS failure here surfaces as a
 * `TypeError: Failed to fetch` with no status — hence the wrapper.
 */
const postToTokenEndpoint = async (
  config: OauthConfig,
  body: URLSearchParams,
  previous?: TokenSet,
): Promise<TokenSet> => {
  let response: Response;
  try {
    response = await fetch(config.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (cause) {
    throw new OauthError(
      "network_error",
      `Could not reach ${config.tokenUri}. Check that ${window.location.origin} is an allowed CORS origin for this client. (${String(cause)})`,
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | (TokenResponse & { error?: string; error_description?: string })
    | null;

  if (!response.ok || !payload?.access_token) {
    throw new OauthError(
      payload?.error ?? `http_${response.status}`,
      payload?.error_description ?? response.statusText,
    );
  }

  return toTokenSet(payload, previous);
};

/**
 * Exchange the authorization code for tokens.
 *
 * No client secret and no `Authorization` header: this is a public client, and the
 * `code_verifier` is what proves we are the same party that made the request.
 * `redirect_uri` must be sent again and match the authorization request exactly.
 */
export const exchangeCode = (config: OauthConfig, code: string, codeVerifier: string): Promise<TokenSet> =>
  postToTokenEndpoint(
    config,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: codeVerifier,
    }),
  );

/**
 * Trade a refresh token for a fresh access token. Requires the `offline` scope to have
 * been granted — without it the IdP never issues a refresh token in the first place.
 */
export const refreshTokens = (config: OauthConfig, tokens: TokenSet): Promise<TokenSet> => {
  if (!tokens.refreshToken) {
    throw new OauthError("no_refresh_token", "No refresh token available. Was the `offline` scope granted?");
  }

  return postToTokenEndpoint(
    config,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: config.clientId,
    }),
    tokens,
  );
};

/**
 * End the IdP session as well as the local one, so the next authorization does not
 * silently succeed against a still-live SSO session.
 */
export const buildLogoutUrl = (config: OauthConfig): string => {
  const params = new URLSearchParams({ post_logout_redirect_uri: config.redirectUri });
  return `${config.logoutUri}?${params.toString()}`;
};
