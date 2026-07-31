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
 * PKCE (RFC 7636) helpers.
 *
 * @see https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce
 */

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const randomBase64Url = (byteLength: number): string =>
  base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));

/**
 * 32 random bytes → 43 base64url chars, the shortest length RFC 7636 allows.
 */
export const createCodeVerifier = (): string => randomBase64Url(32);

/**
 * Opaque value tying the authorization response back to the request that started it.
 * This is the CSRF defence; PKCE alone does not provide it.
 */
export const createState = (): string => randomBase64Url(16);

/**
 * `code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))`, i.e. the `S256` method.
 *
 * `plain` is deliberately not implemented — it offers no protection against an
 * attacker who can observe the authorization request.
 */
export const createCodeChallenge = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
};
