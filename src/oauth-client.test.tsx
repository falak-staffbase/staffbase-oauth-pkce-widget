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

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { OauthClient } from "./oauth-client";
import {
  configurationBlockers,
  EnvironmentReport,
  environmentBlockers,
  environmentWarnings,
  inspectEnvironment,
  isCrossSite,
} from "./oauth/environment";
import { compareIdentity, extractUserId } from "./oauth/identity";
import { navigate } from "./oauth/navigate";
import { createCodeChallenge, createCodeVerifier } from "./oauth/pkce";
import { loadTransaction } from "./oauth/storage";

// jsdom makes `location.assign` non-configurable, so full-page navigation is stubbed at
// the module seam instead. Also silences jsdom's "navigation not implemented" noise.
jest.mock("./oauth/navigate", () => ({ navigate: jest.fn() }));

const openMock = jest.fn();

/** jsdom serves the tests from http://localhost, so the redirect URI must live there too. */
const REDIRECT_URI = `${window.location.origin}/`;

/**
 * The widget refuses to run when the redirect URI is on another origin, so every flow
 * test has to point it at the test origin.
 */
const renderWidget = () =>
  render(<OauthClient {...{ contentLanguage: "en_US", "redirect-uri": REDIRECT_URI }} />);

beforeEach(() => {
  sessionStorage.clear();
  jest.mocked(navigate).mockClear();
  openMock.mockReset().mockReturnValue({ closed: false, opener: window });
  Object.defineProperty(window, "open", { value: openMock, writable: true });
});

describe("OauthClient", () => {
  it("starts idle and offers sign-in", () => {
    renderWidget();

    expect(screen.getByText(/Status:/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sign in with Staffbase ID/ })).toBeEnabled();
  });

  it("disables token actions until a token exists", () => {
    renderWidget();

    expect(screen.getByRole("button", { name: /Refresh token/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Call API/ })).toBeDisabled();
  });

  it("opens a popup with an S256 challenge and persists the verifier", async () => {
    renderWidget();

    fireEvent.click(screen.getByRole("button", { name: /Sign in with Staffbase ID/ }));

    await waitFor(() => expect(openMock).toHaveBeenCalled());

    const url = new URL(openMock.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe("https://id-us1.staffbase.com/oauth2/auth");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);

    // Asks for a separate window rather than a tab. Browsers may still override this.
    const features = openMock.mock.calls[0][2] as string;
    expect(features).toContain("popup=true");
    expect(features).toMatch(/width=\d+/);
    expect(features).toMatch(/height=\d+/);
    expect(features).toMatch(/left=\d+/);
    expect(features).toMatch(/top=\d+/);

    const transaction = loadTransaction();
    expect(transaction).not.toBeNull();
    // The verifier stays local; only its hash is on the wire.
    expect(url.toString()).not.toContain(transaction!.codeVerifier);
    expect(url.searchParams.get("state")).toBe(transaction!.state);
    expect(url.searchParams.get("code_challenge")).toBe(await createCodeChallenge(transaction!.codeVerifier));
  });

  it("collects the code by reading the popup's location, with no script running in the popup", async () => {
    // Simulates the real failure: the redirect URI is the app root, this widget is not
    // mounted there, so nothing in the popup ever posts a message back.
    const popup = { closed: false, close: jest.fn(), opener: window, location: { search: "" }, sessionStorage };
    openMock.mockReturnValue(popup);

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "at-123", token_type: "bearer", expires_in: 3600, scope: "offline" }),
    });
    Object.defineProperty(window, "fetch", { value: fetchMock, writable: true });

    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: /Sign in with Staffbase ID/ }));
    await waitFor(() => expect(openMock).toHaveBeenCalled());

    // The IdP redirects the popup back to our origin.
    const state = loadTransaction()!.state;
    popup.location.search = `?code=ory_ac_test&scope=offline&state=${state}`;

    expect(await screen.findByText(/access_token:/)).toBeInTheDocument();
    expect(popup.close).toHaveBeenCalled();

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("ory_ac_test");
    expect(body.get("code_verifier")).toBeTruthy();
    // Public client: PKCE stands in for a secret.
    expect(body.get("client_secret")).toBeNull();
  });

  it("surfaces the authorization code and both halves of the PKCE pair", async () => {
    const popup = { closed: false, close: jest.fn(), opener: window, location: { search: "" }, sessionStorage };
    openMock.mockReturnValue(popup);
    Object.defineProperty(window, "fetch", {
      value: jest.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: "at", token_type: "bearer" }) }),
      writable: true,
    });

    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: /Sign in with Staffbase ID/ }));
    await waitFor(() => expect(openMock).toHaveBeenCalled());

    const { state, codeVerifier, codeChallenge } = loadTransaction()!;
    popup.location.search = `?code=ory_ac_visible&state=${state}`;

    const panel = await screen.findByText(/code:\s+ory_ac_visible/);

    expect(panel).toHaveTextContent(codeVerifier);
    expect(panel).toHaveTextContent(codeChallenge);
    expect(panel).toHaveTextContent(/collected via:\s+popup location/);
    // The displayed challenge really is the hash of the displayed verifier.
    expect(codeChallenge).toBe(await createCodeChallenge(codeVerifier));
  });

  it("keeps waiting while the popup is still cross-origin at the IdP", async () => {
    const popup = {
      closed: false,
      close: jest.fn(),
      opener: window,
      sessionStorage,
      get location(): { search: string } {
        throw new DOMException("cross-origin");
      },
    };
    openMock.mockReturnValue(popup);

    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: /Sign in with Staffbase ID/ }));
    await waitFor(() => expect(openMock).toHaveBeenCalled());

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/authorizing/)).toBeInTheDocument();
  });

  it("rejects a callback whose state does not match the transaction", async () => {
    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: /Sign in with Staffbase ID/ }));
    await waitFor(() => expect(openMock).toHaveBeenCalled());

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: { type: "sb-oauth-client:callback", payload: { code: "abc", state: "not-the-real-state" } },
        }),
      );
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/State mismatch/);
  });
});

describe("environment blockers", () => {
  const healthy: EnvironmentReport = {
    framed: false,
    origin: "https://ccmuhammad.staffbase.com",
    opaqueOrigin: false,
    storageAvailable: true,
    subtleCryptoAvailable: true,
    secureContext: true,
    webkit: false,
  };

  it("rejects an opaque origin and names the fix", () => {
    // What a CSP/iframe `sandbox` without `allow-same-origin` produces: the origin
    // serialises to the string "null" and storage is unreachable.
    const blockers = environmentBlockers({
      ...healthy,
      framed: true,
      origin: "null",
      opaqueOrigin: true,
      storageAvailable: false,
    });

    // The storage failure is a symptom of the opaque origin, not a separate finding.
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/opaque origin/);
    expect(blockers[0]).toMatch(/allow-same-origin/);
    expect(blockers[0]).toMatch(/custom widget/);
  });

  it("passes a sandboxed document that kept allow-same-origin", () => {
    // CSP `sandbox allow-popups allow-scripts allow-same-origin`: framed and sandboxed,
    // but the real origin is retained, so the flow can complete.
    expect(environmentBlockers({ ...healthy, framed: true })).toEqual([]);
  });

  it("passes an ordinary custom-widget document", () => {
    expect(environmentBlockers(inspectEnvironment())).toEqual([]);
  });

  it("flags a missing crypto.subtle", () => {
    expect(environmentBlockers({ ...healthy, subtleCryptoAvailable: false })[0]).toMatch(/crypto\.subtle/);
  });

  it("rejects a redirect URI on a different origin than the widget", () => {
    const report = { ...healthy, origin: "https://ccmuhammadtest.staffbase.rocks" };

    const blockers = configurationBlockers("https://ccmuhammad.staffbase.com/", report);

    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("https://ccmuhammadtest.staffbase.rocks");
    expect(blockers[0]).toContain("https://ccmuhammad.staffbase.com");
    // Names the concrete registration change, not just the symptom.
    expect(blockers[0]).toMatch(/allowed CORS origin/);
  });

  it("accepts a redirect URI on the widget's own origin", () => {
    expect(configurationBlockers("https://ccmuhammad.staffbase.com/", healthy)).toEqual([]);
  });

  it("ignores a path difference, comparing only origins", () => {
    expect(configurationBlockers("https://ccmuhammad.staffbase.com/some/landing/page", healthy)).toEqual([]);
  });

  it("rejects a redirect URI that is not an absolute URL", () => {
    expect(configurationBlockers("/callback", healthy)[0]).toMatch(/not a valid absolute URL/);
  });
});

describe("cross-site / WebKit warnings", () => {
  const base: EnvironmentReport = {
    framed: false,
    origin: "https://ccmuhammadtest.staffbase.rocks",
    opaqueOrigin: false,
    storageAvailable: true,
    subtleCryptoAvailable: true,
    secureContext: true,
    webkit: false,
  };
  const IDP = "https://id-us1.staffbase.com/oauth2/auth";

  it("treats an app on the IdP's own site as same-site", () => {
    // partnerjasp.staffbase.com -> id-us1.staffbase.com: same registrable domain.
    expect(isCrossSite("https://partnerjasp.staffbase.com", IDP)).toBe(false);
  });

  it("detects the current setup as cross-site", () => {
    // .rocks vs .com are different registrable domains, so ITP applies on WebKit.
    expect(isCrossSite("https://ccmuhammadtest.staffbase.rocks", IDP)).toBe(true);
  });

  it("detects a white-labeled customer domain as cross-site", () => {
    expect(isCrossSite("https://masternet.euromaster.de", IDP)).toBe(true);
  });

  it("warns without blocking when cross-site on a non-WebKit browser", () => {
    const warnings = environmentWarnings(base, IDP);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Safari\/iOS/);
    // Crucially not a blocker: the flow demonstrably works here.
    expect(environmentBlockers(base)).toEqual([]);
  });

  it("escalates the warning on WebKit and names the popup risk", () => {
    const warnings = environmentWarnings({ ...base, webkit: true }, IDP);

    expect(warnings[0]).toMatch(/window\.open/);
    expect(warnings[0]).toMatch(/opener/);
    expect(environmentBlockers({ ...base, webkit: true })).toEqual([]);
  });

  it("stays quiet when same-site", () => {
    expect(environmentWarnings({ ...base, origin: "https://partnerjasp.staffbase.com" }, IDP)).toEqual([]);
  });
});

describe("popup fallback", () => {
  it("falls back to a full-page redirect when window.open is blocked", async () => {
    // The common in-app WKWebView case on iOS.
    openMock.mockReturnValue(null);

    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: /Sign in with Staffbase ID/ }));

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(String(jest.mocked(navigate).mock.calls[0][0])).toContain("/oauth2/auth");
    // Must not dead-end on an error the user cannot act on.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The transaction has to survive the navigation, or the return leg cannot complete.
    expect(loadTransaction()).not.toBeNull();
  });

  it("falls back to a redirect when the popup's opener is severed", async () => {
    const popup = { closed: false, close: jest.fn(), opener: null, location: { search: "" }, sessionStorage };
    openMock.mockReturnValue(popup);

    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: /Sign in with Staffbase ID/ }));

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    // Don't leave an unreadable popup lying around.
    expect(popup.close).toHaveBeenCalled();
  });
});

describe("identity verification", () => {
  const ACTING_USER = "62ebda2d58db9f0a26f6b1c6";

  it("finds the user id under a variety of response shapes", () => {
    expect(extractUserId({ userId: ACTING_USER })).toBe(ACTING_USER);
    expect(extractUserId({ user: { id: ACTING_USER } })).toBe(ACTING_USER);
    expect(extractUserId({ data: { userId: ACTING_USER } })).toBe(ACTING_USER);
    expect(extractUserId({ sub: ACTING_USER })).toBe(ACTING_USER);
  });

  it("prefers the candidate that looks like a Staffbase id", () => {
    // `id` here is the client id, not the user — the ObjectId shape disambiguates.
    expect(extractUserId({ id: "eeabfffc-6741-4f75-818a-12dac1e634e7", userId: ACTING_USER })).toBe(ACTING_USER);
  });

  it("returns null when no id is present", () => {
    expect(extractUserId({ authMethods: ["saml"] })).toBeNull();
    expect(extractUserId(null)).toBeNull();
  });

  it("confirms a user-context token when both ids agree", () => {
    const result = compareIdentity(ACTING_USER, ACTING_USER);

    expect(result.verdict).toBe("match");
    expect(result.detail).toMatch(/bound to the acting user/);
  });

  it("flags a token that is not the viewing user", () => {
    expect(compareIdentity("someone-else", ACTING_USER).verdict).toBe("mismatch");
  });

  it("reports inconclusive rather than mismatch when no id could be extracted", () => {
    // Guards the real risk: an unexpected response shape must not masquerade as a
    // security finding in either direction.
    const result = compareIdentity(null, ACTING_USER);

    expect(result.verdict).toBe("inconclusive");
    expect(result.detail).toMatch(/identity-path/);
  });
});

describe("PKCE", () => {
  it("produces a verifier of RFC 7636 permitted length and charset", () => {
    const verifier = createCodeVerifier();

    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("hashes the verifier to a base64url challenge with no padding", async () => {
    // Test vector from RFC 7636 appendix B.
    const challenge = await createCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");

    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
