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
import { capacitorFindings, inspectCapacitor, pluginMethods, probePopup, probeSchemes } from "./oauth/capacitor";
import { defaultConfig, forEnvironment, OauthConfig, usingNativeClient } from "./oauth/config";
import {
  configurationBlockers,
  EnvironmentReport,
  environmentBlockers,
  environmentWarnings,
  inspectEnvironment,
  isCrossSite,
  originOf,
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

  it("ignores api-base-url on the web, keeping API calls same-origin", async () => {
    // Guards a regression: api-base-url is defaulted for the native app, and must not
    // redirect web API calls to another app's origin (which would also fail CORS).
    const popup = { closed: false, close: jest.fn(), opener: window, location: { search: "" }, sessionStorage };
    openMock.mockReturnValue(popup);
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ access_token: "at", token_type: "bearer" }), text: async () => "{}", status: 200 });
    Object.defineProperty(window, "fetch", { value: fetchMock, writable: true });

    render(
      <OauthClient
        {...{
          contentLanguage: "en_US",
          "redirect-uri": REDIRECT_URI,
          "api-base-url": "https://some-other-app.staffbase.com",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Sign in with Staffbase ID/ }));
    await waitFor(() => expect(openMock).toHaveBeenCalled());
    popup.location.search = `?code=c&state=${loadTransaction()!.state}`;
    await screen.findByText(/access_token:/);

    fireEvent.click(screen.getByRole("button", { name: /Call API/ }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    expect(String(fetchMock.mock.calls[1][0])).toContain(window.location.origin);
    expect(String(fetchMock.mock.calls[1][0])).not.toContain("some-other-app");
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

  it("hides the authorization code and PKCE values by default", async () => {
    // The verifier is a live secret, so the widget must be safe to record or screen-share
    // without remembering to turn anything off.
    const popup = { closed: false, close: jest.fn(), opener: window, location: { search: "" }, sessionStorage };
    openMock.mockReturnValue(popup);
    Object.defineProperty(window, "fetch", {
      value: jest.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: "at", token_type: "bearer" }) }),
      writable: true,
    });

    renderWidget();
    fireEvent.click(screen.getByRole("button", { name: /Sign in with Staffbase ID/ }));
    await waitFor(() => expect(openMock).toHaveBeenCalled());

    const { state, codeVerifier } = loadTransaction()!;
    popup.location.search = `?code=ory_ac_secret&state=${state}`;

    await screen.findByText(/access_token:/);

    expect(screen.queryByText(/Authorization callback/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(codeVerifier);
    expect(document.body.textContent).not.toContain("ory_ac_secret");
  });

  it("surfaces the authorization code and both halves of the PKCE pair when explicitly enabled", async () => {
    const popup = { closed: false, close: jest.fn(), opener: window, location: { search: "" }, sessionStorage };
    openMock.mockReturnValue(popup);
    Object.defineProperty(window, "fetch", {
      value: jest.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: "at", token_type: "bearer" }) }),
      writable: true,
    });

    render(
      <OauthClient
        {...{ contentLanguage: "en_US", "redirect-uri": REDIRECT_URI, "show-pkce-debug": "true" }}
      />,
    );
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
    scheme: "https:",
    nativeWebview: false,
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

describe("known problems are reported, not enforced", () => {
  it("still runs the flow and logs the finding", async () => {
    // A diagnostic widget should let you attempt a flow that is expected to fail — being
    // told "blocked" with a disabled button is less useful than seeing where it breaks.
    render(
      <OauthClient
        {...{ contentLanguage: "en_US", "flow-mode": "redirect", "redirect-uri": "https://elsewhere.example/" }}
      />,
    );

    const button = screen.getByRole("button", { name: /Sign in with Staffbase ID/ });
    expect(button).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/expect it to fail/);

    fireEvent.click(button);

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    // The finding is recorded alongside the attempt, so a failure can be read against it.
    expect(screen.getByText(/Known problem, attempting anyway/)).toBeInTheDocument();
  });
});

describe("Capacitor bridge probe", () => {
  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it("reports nothing reachable on the web", () => {
    const report = inspectCapacitor();

    expect(report.bridgePresent).toBe(false);
    expect(capacitorFindings(report)[0]).toMatch(/not reachable/);
  });

  it("reads platform and plugin list when the bridge is present", () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      getPlatform: () => "ios",
      isNativePlatform: () => true,
      Plugins: { App: {}, CapacitorHttp: {}, Browser: {} },
    };

    const report = inspectCapacitor();

    expect(report.bridgePresent).toBe(true);
    expect(report.platform).toBe("ios");
    expect(report.nativePlatform).toBe(true);
    expect(report.appPluginPresent).toBe(true);
    expect(report.httpPluginPresent).toBe(true);
    expect(report.plugins).toEqual(["App", "Browser", "CapacitorHttp"]);
  });

  it("flags the missing deep-link route when App is absent", () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = { Plugins: { Browser: {} } };

    const findings = capacitorFindings(inspectCapacitor());

    expect(findings.join(" ")).toMatch(/App plugin NOT reachable/);
    expect(findings.join(" ")).toMatch(/custom-scheme redirect URI cannot work/);
  });

  it("survives a bridge whose accessors throw", () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      getPlatform: () => {
        throw new Error("bridge not ready");
      },
      Plugins: { App: {} },
    };

    const report = inspectCapacitor();

    expect(report.bridgePresent).toBe(true);
    expect(report.platform).toBeNull();
    expect(report.appPluginPresent).toBe(true);
  });

  it("always notes what it cannot observe", () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = { Plugins: { App: {} } };

    // The probe must not imply a verdict it has no basis for.
    expect(capacitorFindings(inspectCapacitor()).join(" ")).toMatch(/external URL scheme/);
  });
});

describe("URL inspection", () => {
  it("shows both the load-time and live URL so a stripped query is visible", async () => {
    renderWidget();

    const panel = await screen.findByText(/href at load:/);

    // Both matter: the load snapshot fires once per document, so a deep link routed into a
    // running app can add the code to the live URL after it was taken.
    expect(panel).toHaveTextContent(/query at load:/);
    expect(panel).toHaveTextContent(/query now:/);
    expect(panel).toHaveTextContent(/code at load:/);
    expect(panel).toHaveTextContent(/code now:/);
  });

  it("reports when a re-check finds nothing", async () => {
    renderWidget();

    fireEvent.click(screen.getByRole("button", { name: /Re-check URL for a code/ }));

    expect(await screen.findByText(/No unconsumed authorization response/)).toBeInTheDocument();
  });
});

describe("deep-link handoff for a code with no verifier", () => {
  const OPENLINK = "https://ccmuhammad.staffbase.com/openlink/content/plug123/inst456/";

  /** The browser's situation after iOS punts the IdP redirect out of the app. */
  const arriveWithCodeButNoVerifier = () => {
    sessionStorage.setItem(
      "sb-oauth-client:pending-code",
      JSON.stringify({ code: "ory_ac_from_browser", state: "st-1" }),
    );
  };

  it("offers a tappable deep link carrying the code", async () => {
    arriveWithCodeButNoVerifier();

    render(
      <OauthClient
        {...{ contentLanguage: "en_US", "redirect-uri": REDIRECT_URI, "openlink-url": OPENLINK }}
      />,
    );

    const link = await screen.findByRole("link", { name: /Continue in the Staffbase app/ });
    const href = new URL(link.getAttribute("href")!);

    expect(href.origin + href.pathname).toBe(OPENLINK.slice(0, -1) + "/");
    expect(href.searchParams.get("code")).toBe("ory_ac_from_browser");
    expect(href.searchParams.get("state")).toBe("st-1");
  });

  it("explains that the link has to be tapped", async () => {
    arriveWithCodeButNoVerifier();

    render(
      <OauthClient
        {...{ contentLanguage: "en_US", "redirect-uri": REDIRECT_URI, "openlink-url": OPENLINK }}
      />,
    );

    // The distinction that makes this work at all: a tap fires a universal link, a
    // redirect does not.
    expect(await screen.findByText(/must be tapped/)).toBeInTheDocument();
  });

  it("falls back to the plain error when no deep link is configured", async () => {
    arriveWithCodeButNoVerifier();

    renderWidget();

    expect(await screen.findByRole("alert")).toHaveTextContent(/no matching PKCE transaction/);
    expect(screen.queryByRole("link", { name: /Continue in the Staffbase app/ })).not.toBeInTheDocument();
  });
});

describe("URL scheme probe", () => {
  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it("reports a custom scheme an installed app claims", async () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      Plugins: { AppLauncher: { canOpenUrl: async ({ url }: { url: string }) => ({ value: url.startsWith("staffbase:") }) } },
    };

    const results = await probeSchemes(["staffbase://", "capacitor://staffbase.com/"]);

    expect(results[0].canOpen).toBe(true);
    expect(results[0].detail).toMatch(/custom scheme claimed/);
    expect(results[1].canOpen).toBe(false);
    expect(results[1].detail).toMatch(/not conclusive/);
  });

  it("marks an http(s) result as uninformative", async () => {
    // iOS returns true for any web URL because the browser claims them, which would
    // otherwise read as evidence that the app handles it.
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      Plugins: { AppLauncher: { canOpenUrl: async () => ({ value: true }) } },
    };

    const [result] = await probeSchemes(["https://ccmuhammad.staffbase.com/"]);

    expect(result.canOpen).toBe(true);
    expect(result.detail).toMatch(/uninformative/);
  });

  it("reports unknown rather than false when AppLauncher is missing", async () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = { Plugins: {} };

    const results = await probeSchemes(["staffbase://"]);

    // A false would wrongly imply the scheme was checked and rejected.
    expect(results[0].canOpen).toBeNull();
    expect(results[0].detail).toMatch(/not reachable/);
  });

  it("survives a plugin that rejects", async () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      Plugins: {
        AppLauncher: {
          canOpenUrl: async () => {
            throw new Error("not permitted");
          },
        },
      },
    };

    const results = await probeSchemes(["staffbase://"]);

    expect(results[0].canOpen).toBeNull();
    expect(results[0].detail).toMatch(/threw/);
  });

  it("lists a plugin's callable methods", () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      Plugins: { StaffbaseDeepLink: { addListener: () => undefined, getLaunchUrl: () => undefined } },
    };

    expect(pluginMethods("StaffbaseDeepLink")).toEqual(["addListener", "getLaunchUrl"]);
    expect(pluginMethods("Nope")).toEqual([]);
  });
});

describe("window.open probe", () => {
  it("closes the window it opened, so probing has no side effects", () => {
    const win = { opener: window, location: { href: "about:blank" }, close: jest.fn() };
    openMock.mockReturnValue(win);

    const result = probePopup();

    expect(win.close).toHaveBeenCalled();
    expect(openMock.mock.calls[0][0]).toBe("about:blank");
    expect(result.openerIntact).toBe(true);
    expect(result.sameOriginReadable).toBe(true);
  });

  it("reports a handoff to the system browser when no handle comes back", () => {
    openMock.mockReturnValue(null);

    const result = probePopup();

    expect(result.opened).toBe(false);
    expect(result.detail).toMatch(/system browser/);
  });

  it("detects a severed opener", () => {
    openMock.mockReturnValue({ opener: null, location: { href: "about:blank" }, close: jest.fn() });

    expect(probePopup().openerIntact).toBe(false);
    expect(probePopup().detail).toMatch(/severed/);
  });

  it("does not throw when the popup cannot be closed", () => {
    openMock.mockReturnValue({
      opener: window,
      location: { href: "about:blank" },
      close: () => {
        throw new Error("cannot close");
      },
    });

    expect(() => probePopup()).not.toThrow();
  });
});

describe("native app webview (Capacitor)", () => {
  // What the Staffbase iOS app actually reports.
  const native: EnvironmentReport = {
    framed: false,
    origin: "capacitor://staffbase.com",
    opaqueOrigin: false,
    storageAvailable: true,
    subtleCryptoAvailable: true,
    secureContext: true,
    webkit: true,
    scheme: "capacitor:",
    nativeWebview: true,
  };

  /** Native flow explicitly disabled, overriding the shipped default. */
  const webConfig: OauthConfig = {
    ...defaultConfig,
    clientId: "web-client",
    redirectUri: "https://app.example/",
    nativeClientId: "",
  };
  const bothConfig: OauthConfig = {
    ...webConfig,
    nativeClientId: "native-client",
    nativeRedirectUri: "capacitor://staffbase.com/",
  };

  it("blocks when no native client is configured, and names the way to attempt it", () => {
    const blockers = environmentBlockers(native, { nativeFlowConfigured: false });

    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/capacitor:/);
    expect(blockers[0]).toMatch(/native-client-id/);
    expect(blockers[0]).toMatch(/getIntegration/);
  });

  it("stops blocking once a native client is configured", () => {
    expect(environmentBlockers(native, { nativeFlowConfigured: true })).toEqual([]);
  });

  it("swaps in the native client and forces redirect mode", () => {
    const effective = forEnvironment(bothConfig, true);

    expect(effective.clientId).toBe("native-client");
    expect(effective.redirectUri).toBe("capacitor://staffbase.com/");
    // window.open returns null in the webview, so popup mode has nothing to poll.
    expect(effective.flowMode).toBe("redirect");
    expect(usingNativeClient(bothConfig, true)).toBe(true);
  });

  it("leaves the web client untouched on the web", () => {
    expect(forEnvironment(bothConfig, false)).toEqual(bothConfig);
    expect(usingNativeClient(bothConfig, false)).toBe(false);
  });

  it("prefers an explicitly configured HTTPS redirect URI in the native webview", () => {
    // One field serves both contexts, and the callback lands on the page the widget is on
    // rather than the app root — which is where it has to be for the handoff to render.
    const page = "https://ccmuhammad.staffbase.com/content/page/6a6bfb425e1b4f25ae10dcd9";
    const effective = forEnvironment({ ...webConfig, redirectUri: page, apiBaseUrl: "https://app.example" }, true);

    expect(effective.redirectUri).toBe(page);
    expect(effective.flowMode).toBe("redirect");
  });

  it("falls back to the web client with an HTTPS callback when no native client is set", () => {
    // The untested permutation, reachable with no configuration: the app's HTTPS origin
    // is taken from api-base-url, since it cannot be derived from window.location here.
    const effective = forEnvironment({ ...webConfig, apiBaseUrl: "https://app.example" }, true);

    expect(effective.clientId).toBe("web-client");
    expect(effective.redirectUri).toBe("https://app.example/");
    expect(effective.flowMode).toBe("redirect");
    expect(usingNativeClient(webConfig, true)).toBe(false);
  });

  it("accepts the custom-scheme redirect URI as same-origin", () => {
    // `new URL("capacitor://staffbase.com/").origin` is the string "null", so a naive
    // comparison against window.location.origin would report a false mismatch here.
    expect(originOf("capacitor://staffbase.com/")).toBe("capacitor://staffbase.com");
    expect(configurationBlockers(forEnvironment(bothConfig, true).redirectUri, native)).toEqual([]);
  });

  it("still flags an HTTPS redirect URI while running under capacitor://", () => {
    // Now correct advice rather than a dead end: a native client really is what's needed.
    const blockers = configurationBlockers("https://ccmuhammad.staffbase.com/", native);

    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/capacitor:\/\/staffbase\.com/);
  });

  it("still reports a genuine origin mismatch on the web", () => {
    const web = { ...native, origin: "https://ccmuhammad.staffbase.com", scheme: "https:", nativeWebview: false };

    expect(configurationBlockers("https://elsewhere.example/", web)).toHaveLength(1);
  });

  describe("opting into an HTTPS callback from the native webview", () => {
    const HTTPS_CALLBACK = "https://ccmuhammad.staffbase.com/content/page/abc123";

    it("allows the cross-origin callback instead of blocking it", () => {
      // Without the opt-in this is a hard blocker; with it, the experiment can run.
      expect(configurationBlockers(HTTPS_CALLBACK, native)).toHaveLength(1);
      expect(configurationBlockers(HTTPS_CALLBACK, native, { experimentalNativeFlow: true })).toEqual([]);
    });

    it("warns about what the attempt depends on, without blocking", () => {
      const warnings = environmentWarnings(native, "https://id-de1.staffbase.rocks/oauth2/auth", {
        experimentalNativeFlow: true,
        redirectUri: HTTPS_CALLBACK,
      });

      expect(warnings.join(" ")).toMatch(/Universal Link/);
      expect(warnings.join(" ")).toMatch(/stranded/);
    });

    it("says plainly that a custom-scheme callback was tested and fails", () => {
      const warnings = environmentWarnings(native, "https://id-de1.staffbase.rocks/oauth2/auth", {
        experimentalNativeFlow: true,
        redirectUri: "capacitor://staffbase.com/",
      });

      expect(warnings.join(" ")).toMatch(/address is invalid/);
    });

    it("stays silent on the web", () => {
      const web = { ...native, origin: "https://ccmuhammad.staffbase.com", scheme: "https:", nativeWebview: false };

      expect(
        environmentWarnings(web, "https://id-us1.staffbase.com/oauth2/auth", { experimentalNativeFlow: true }),
      ).not.toContainEqual(expect.stringMatching(/Experimental native/));
    });
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
    scheme: "https:",
    nativeWebview: false,
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
