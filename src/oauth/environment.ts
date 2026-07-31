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

export interface EnvironmentReport {
  /** Running inside an iframe rather than directly in the host page. */
  framed: boolean;
  origin: string;
  /**
   * True when the document has an opaque origin, which is what `sandbox` without
   * `allow-same-origin` produces. This is fatal for the popup flow: an opaque-origin
   * document is cross-origin to *everything*, including the real app origin, so the
   * opener can never read the popup's `location` and the code can never be collected.
   */
  opaqueOrigin: boolean;
  storageAvailable: boolean;
  /** `crypto.subtle` is only exposed in a secure context, and PKCE needs it for S256. */
  subtleCryptoAvailable: boolean;
  secureContext: boolean;
  /** Best-effort WebKit detection: Safari, plus every in-app browser on iOS. */
  webkit: boolean;
  /** e.g. `https:`, or `capacitor:` inside the Staffbase native app. */
  scheme: string;
  /**
   * True when the document is served over a non-HTTP(S) scheme, which is how a Capacitor
   * or Cordova webview hosts local content. This is fatal for a browser-based redirect
   * flow — see `environmentBlockers`.
   */
  nativeWebview: boolean;
}

/**
 * Approximate the registrable domain ("site") by taking the last two labels.
 *
 * Deliberately not a Public Suffix List lookup — this only drives a warning, and the
 * cases that matter here (`staffbase.com` vs `staffbase.rocks` vs a customer domain)
 * are all resolved correctly by the naive rule. It will misjudge multi-part suffixes
 * like `co.uk`, which would produce a false "same-site" reading — acceptable for a hint.
 */
/**
 * Origin of a URL, normalised across schemes.
 *
 * `URL.origin` serialises to the string `"null"` for non-special schemes — so
 * `new URL("capacitor://staffbase.com/").origin` is `"null"`, while the webview's
 * `window.location.origin` reports `capacitor://staffbase.com`. Comparing those directly
 * would report a false origin mismatch for the native client, so fall back to
 * `protocol//host`.
 */
export const originOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.origin && parsed.origin !== "null" ? parsed.origin : `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
};

export const registrableDomain = (origin: string): string | null => {
  try {
    const { hostname } = new URL(origin);
    return hostname.split(".").slice(-2).join(".") || null;
  } catch {
    return null;
  }
};

/**
 * True when the app and the IdP are on different sites.
 *
 * This is the condition that makes Safari/WebKit risky: cross-site means ITP cookie
 * capping and storage partitioning apply to the IdP, so an existing SSO session may not
 * be recognised. Same-site (e.g. an app on `*.staffbase.com` talking to
 * `id-us1.staffbase.com`) sidesteps all of it.
 */
export const isCrossSite = (appOrigin: string, idpUrl: string): boolean => {
  const app = registrableDomain(appOrigin);
  const idp = registrableDomain(idpUrl);
  return Boolean(app && idp && app !== idp);
};

const isFramed = (): boolean => {
  try {
    return window.self !== window.top;
  } catch {
    // A cross-origin parent makes the comparison throw, which itself means we are framed.
    return true;
  }
};

const hasStorage = (): boolean => {
  try {
    window.sessionStorage.getItem("probe");
    return true;
  } catch {
    return false;
  }
};

export const inspectEnvironment = (): EnvironmentReport => {
  const origin = window.location.origin;

  return {
    framed: isFramed(),
    origin,
    // Browsers serialise an opaque origin as the literal string "null".
    opaqueOrigin: origin === "null" || origin === "",
    storageAvailable: hasStorage(),
    subtleCryptoAvailable: Boolean(globalThis.crypto?.subtle),
    secureContext: window.isSecureContext,
    // Every iOS browser is WebKit under the hood, so match the engine, not the brand.
    webkit: /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent),
    scheme: window.location.protocol,
    nativeWebview: !["http:", "https:"].includes(window.location.protocol),
  };
};

/**
 * The blocking problems, in the order worth fixing them. Empty means the environment can
 * support the flow.
 */
export const environmentBlockers = (
  report: EnvironmentReport,
  options: { nativeFlowConfigured?: boolean } = {},
): string[] => {
  const blockers: string[] = [];

  // Only a blocker when there is no native client to fall back to. With one configured,
  // the flow becomes: navigate the webview to the IdP, let it redirect back to
  // `capacitor://…` where Capacitor's internal handler serves the app shell — same origin,
  // so the PKCE verifier in sessionStorage is still reachable.
  if (report.nativeWebview && !options.nativeFlowConfigured) {
    blockers.push(
      `Native app webview: this document is served over "${report.scheme}" (origin "${report.origin}"), not HTTPS — the Staffbase mobile app hosts widget content in a Capacitor webview under a custom scheme. Both routes were tested on iOS and neither works: window.open returns null, so there is no popup to read back; and a full-page redirect to a "capacitor://" redirect URI is handed to the system browser, which cannot deliver it back to the app ("Safari cannot open the page because the address is invalid" — the scheme is not registered as an external URL scheme). Authentication in the native app has to be brokered by the platform — widgetApi.getIntegration() — or by a custom plugin, which gets a real HTTPS origin. Setting native-client-id re-attempts the custom-scheme flow, but it is expected to fail.`,
    );
  }

  if (report.opaqueOrigin) {
    blockers.push(
      "This document has an opaque origin (\"null\") — it is inside a sandboxed iframe without `allow-same-origin`, which is how Staffbase's HTML / Custom Script widget renders content. An opaque-origin document is cross-origin to everything, including the real app origin, so the opener can never read the popup's location and no authorization code can ever be collected. Deploy this project as a Staffbase custom widget (upload `dist/*.js` as a plugin) instead: custom widgets mount as Web Components directly in the page, with the real origin and no sandbox. Adding sandbox flags from in here is not possible — a document cannot relax its own sandbox.",
    );
  }

  if (!report.storageAvailable && !report.opaqueOrigin) {
    blockers.push(
      "sessionStorage is unavailable, so the PKCE verifier cannot be persisted. Common causes: a sandboxed iframe, or blocked cookies / site data.",
    );
  }

  if (!report.subtleCryptoAvailable) {
    blockers.push(
      "`crypto.subtle` is unavailable, so the S256 code challenge cannot be computed. This requires a secure (HTTPS) context.",
    );
  }

  return blockers;
};

/**
 * Risks that are worth surfacing but must not stop the flow.
 *
 * Kept separate from `environmentBlockers` on purpose: these conditions do not reliably
 * break anything, so gating sign-in on them would be wrong. They exist to explain a
 * failure if one happens — particularly on iOS, where the failure mode is silent.
 */
export const environmentWarnings = (report: EnvironmentReport, authorizeUri: string): string[] => {
  const warnings: string[] = [];
  const crossSite = isCrossSite(report.origin, authorizeUri);

  if (crossSite && report.webkit) {
    warnings.push(
      `WebKit + cross-site IdP: this app (${registrableDomain(report.origin)}) and the IdP (${registrableDomain(authorizeUri)}) are different sites, and Safari/iOS applies ITP cookie capping and storage partitioning across sites. An existing SSO session may not be recognised, and in an in-app WKWebView \`window.open\` may be blocked or \`window.opener\` severed — which would break popup mode. Redirect mode is the fallback, and it needs this widget on the redirect-URI page.`,
    );
  } else if (crossSite) {
    warnings.push(
      `Cross-site IdP: this app (${registrableDomain(report.origin)}) and the IdP (${registrableDomain(authorizeUri)}) are different sites. Fine here, but Safari/iOS applies ITP restrictions to cross-site IdPs — test on WebKit before relying on this. Hosting the app on the same site as the IdP avoids it entirely.`,
    );
  }

  return warnings;
};

/**
 * Catch the misconfiguration that is otherwise invisible: a redirect URI on a *different
 * origin* than the widget.
 *
 * The whole flow assumes the authorization code comes back to our own origin. If it does
 * not, three separate things break at once and none of them produce an obvious error —
 * the popup simply appears to hang. Better to refuse up front and name the fix.
 */
export const configurationBlockers = (redirectUri: string, report: EnvironmentReport): string[] => {
  const redirectOrigin = originOf(redirectUri);

  if (!redirectOrigin) {
    return [`Redirect URI "${redirectUri}" is not a valid absolute URL.`];
  }

  if (report.opaqueOrigin || redirectOrigin === report.origin) {
    return [];
  }

  return [
    `Origin mismatch: this widget is running on ${report.origin}, but the redirect URI points at ${redirectOrigin}. ` +
      "The authorization code would come back to a different origin, which breaks the flow three ways: the opener cannot read a cross-origin popup's location, sessionStorage is not shared across origins, and the token request would be refused by CORS. " +
      `Fix this in the OAuth client registration — add "${report.origin}/" as a redirect URI and "${report.origin}" as an allowed CORS origin — then set this widget's redirect-uri attribute to match.`,
  ];
};
