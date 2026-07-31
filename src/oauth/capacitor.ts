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
 * Probes for the Capacitor JS bridge from *widget* JavaScript.
 *
 * The bridge is installed on `window`, so in principle a dynamically loaded widget can
 * reach it. Whether the pieces needed for a native OAuth redirect are actually present is
 * an empirical question about the host app, not something documented — hence a probe
 * rather than an assumption.
 *
 * Nothing here is invoked; it only inspects. Calling a native plugin from a widget would
 * be reaching into undocumented internals of an app we do not ship.
 */

interface CapacitorGlobal {
  getPlatform?: () => string;
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
  /** Present when native HTTP proxying is compiled in, which sidesteps CORS entirely. */
  CapacitorHttp?: unknown;
}

export interface CapacitorReport {
  /** The bridge object exists on `window`. */
  bridgePresent: boolean;
  platform: string | null;
  nativePlatform: boolean | null;
  /** Plugin names reachable from widget JS, if the bridge exposes them. */
  plugins: string[];
  /**
   * `App` is what would deliver a `capacitor://` deep link via `appUrlOpen` — the only
   * route by which an authorization code could reach us after the IdP redirect.
   */
  appPluginPresent: boolean;
  /** Native HTTP proxying, which would make the token exchange bypass CORS. */
  httpPluginPresent: boolean;
}

const bridge = (): CapacitorGlobal | null => {
  const candidate = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return candidate && typeof candidate === "object" ? candidate : null;
};

const call = <T>(fn: (() => T) | undefined): T | null => {
  if (typeof fn !== "function") return null;
  try {
    return fn();
  } catch {
    return null;
  }
};

export const inspectCapacitor = (): CapacitorReport => {
  const cap = bridge();

  if (!cap) {
    return {
      bridgePresent: false,
      platform: null,
      nativePlatform: null,
      plugins: [],
      appPluginPresent: false,
      httpPluginPresent: false,
    };
  }

  const plugins = cap.Plugins && typeof cap.Plugins === "object" ? Object.keys(cap.Plugins).sort() : [];

  return {
    bridgePresent: true,
    platform: call(cap.getPlatform),
    nativePlatform: call(cap.isNativePlatform),
    plugins,
    appPluginPresent: plugins.includes("App"),
    httpPluginPresent: plugins.includes("CapacitorHttp") || Boolean(cap.CapacitorHttp),
  };
};

/**
 * What the probe implies for the "register `capacitor://…` as a redirect URI" idea.
 *
 * Reported as findings rather than a verdict, because a present plugin only means the
 * *mechanism* exists — the host app's own deep-link handler still competes for the event,
 * and `capacitor://` still has to be registered as an external URL scheme on the device
 * for the redirect to arrive at all. Neither is observable from here.
 */
export const capacitorFindings = (report: CapacitorReport): string[] => {
  if (!report.bridgePresent) {
    return ["Capacitor bridge not reachable from widget JS — no native route to receive a deep link."];
  }

  const findings = [
    `Capacitor bridge reachable (platform: ${report.platform ?? "unknown"}, native: ${report.nativePlatform ?? "unknown"}).`,
    report.appPluginPresent
      ? "App plugin present — `appUrlOpen` exists in principle, but the host app's own deep-link handler also receives the event, and it is not ours to intercept."
      : "App plugin NOT reachable — there is no way to receive a `capacitor://` deep link, so a custom-scheme redirect URI cannot work.",
    report.httpPluginPresent
      ? "CapacitorHttp present — the token exchange would likely be proxied natively and bypass CORS."
      : "CapacitorHttp not detected — the token exchange would go through the webview and face CORS from a custom-scheme origin.",
  ];

  findings.push(
    "Still unobservable from here: whether `capacitor://` is registered as an external URL scheme on the device. If it is not, the IdP redirect dies in the system browser regardless of the above.",
  );

  return findings;
};

export interface PopupProbe {
  opened: boolean;
  openerIntact: boolean;
  sameOriginReadable: boolean;
  detail: string;
}

/**
 * Find out what `window.open` actually does here.
 *
 * The distinction that matters on iOS: a popup that stays *inside* the webview keeps a
 * usable `opener`, so the flow could still complete; one handed off to the system browser
 * returns no handle at all, and nothing can be read back.
 *
 * Opens `about:blank` rather than the IdP — this must be side-effect free — and always
 * closes what it opened. Requires a user gesture, so it is wired to a button.
 */
const tryTrue = (predicate: () => boolean): boolean => {
  try {
    return predicate();
  } catch {
    return false;
  }
};

export const probePopup = (): PopupProbe => {
  let win: Window | null;
  try {
    win = window.open("about:blank", "sb-oauth-probe", "popup=true,width=320,height=200");
  } catch (cause) {
    return { opened: false, openerIntact: false, sameOriginReadable: false, detail: `window.open threw: ${String(cause)}` };
  }

  if (!win) {
    return {
      opened: false,
      openerIntact: false,
      sameOriginReadable: false,
      detail:
        "window.open returned null — blocked, or handed off to the system browser. Popup mode cannot work; the widget falls back to a full-page redirect.",
    };
  }

  const openerIntact = tryTrue(() => win.opener === window);
  // Reading `location.href` on a same-origin about:blank should succeed.
  const sameOriginReadable = tryTrue(() => typeof win.location.href === "string");

  try {
    win.close();
  } catch {
    // Nothing useful to do; the probe result still stands.
  }

  return {
    opened: true,
    openerIntact,
    sameOriginReadable,
    detail: openerIntact
      ? "Popup opened in-webview with a usable opener — the location-polling mechanism can work here."
      : "Popup opened but `opener` is severed — the widget cannot read it back, so it falls back to a full-page redirect.",
  };
};
