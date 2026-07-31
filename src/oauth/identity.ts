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

import { TokenSet } from "./storage";

/**
 * Field paths the acting user's id might appear under. The `/api/auth/discover` response
 * shape is not contractually guaranteed here, so probe the plausible ones rather than
 * hard-coding a guess — and always surface the raw body so a miss is visible instead of
 * being reported as a mismatch.
 */
const USER_ID_PATHS = [
  "userId",
  "user.id",
  "user.userId",
  "id",
  "sub",
  "data.userId",
  "data.id",
  "session.userId",
  "identity.id",
  "identity.userId",
];

/** Staffbase ids are 24-character hex ObjectIds; used to prefer a plausible candidate. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

const at = (source: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((value, key) => {
    if (value && typeof value === "object") {
      return (value as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);

/**
 * Pick the acting user's id out of an arbitrary JSON body.
 *
 * Prefers a value that looks like a Staffbase ObjectId, because several of the candidate
 * paths (`id`, `sub`) can legitimately hold something else — a client id, a session id —
 * on a response shape we did not anticipate.
 */
export const extractUserId = (body: unknown): string | null => {
  const candidates = USER_ID_PATHS.map((path) => at(body, path)).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  return candidates.find((value) => OBJECT_ID.test(value)) ?? candidates[0] ?? null;
};

export interface TokenIdentity {
  status: number;
  /** Raw response body, truncated for display. */
  raw: string;
  userId: string | null;
}

/**
 * Ask the API who the access token belongs to.
 *
 * `base` is normally the current origin, since the token is only meaningful against the
 * app the OAuth client is registered in. It has to be passed explicitly for the native
 * webview, where the current origin is `capacitor://…` and a relative path would be served
 * from local assets rather than reaching the API.
 */
export const fetchTokenIdentity = async (
  path: string,
  tokens: TokenSet,
  base: string = window.location.origin,
): Promise<TokenIdentity> => {
  const response = await fetch(new URL(path, base).href, {
    headers: { Authorization: `${tokens.tokenType} ${tokens.accessToken}` },
  });

  const raw = await response.text();
  const parsed = ((): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })();

  return { status: response.status, raw: raw.slice(0, 1500), userId: extractUserId(parsed) };
};

export type Verdict = "match" | "mismatch" | "inconclusive";

export interface IdentityComparison {
  verdict: Verdict;
  tokenUserId: string | null;
  platformUserId: string | null;
  detail: string;
}

/**
 * Compare who the *token* says it is against who the *platform* says the viewer is.
 *
 * A match is what makes this a genuine user-context flow: it shows the token is bound to
 * the acting user rather than being an app-wide credential that merely happened to be
 * obtained through a user-interactive redirect.
 */
export const compareIdentity = (tokenUserId: string | null, platformUserId: string | null): IdentityComparison => {
  if (!tokenUserId || !platformUserId) {
    return {
      verdict: "inconclusive",
      tokenUserId,
      platformUserId,
      detail: !tokenUserId
        ? "Could not find a user id in the identity response — check the raw body below and set the identity-path attribute to an endpoint that returns one."
        : "widgetApi.getUserInformation() returned no id.",
    };
  }

  if (tokenUserId === platformUserId) {
    return {
      verdict: "match",
      tokenUserId,
      platformUserId,
      detail:
        "The token is bound to the acting user — this is a genuine user-context token, not an app-wide credential.",
    };
  }

  return {
    verdict: "mismatch",
    tokenUserId,
    platformUserId,
    detail:
      "The token does not represent the user viewing the page. Do not treat this as a user-context flow.",
  };
};
