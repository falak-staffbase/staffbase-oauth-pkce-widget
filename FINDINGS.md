# Can a Staffbase widget run its own OAuth2 Authorization Code + PKCE flow?

**Question:** can a custom widget drive a user-context Authorization Code + PKCE flow against
an external IdP itself — owning the redirect and the callback — rather than going through
`widgetApi.getIntegration()`?

**Answer:** **Yes on the web app. No in the native mobile app.**

Every route below was tried against a real Staffbase app and Staffbase ID (Ory Hydra). Each
row is marked with how we know: **Measured** on a device, **Documented** platform behaviour,
or **Inferred**.

---

## 1. Web app — works

Verified end to end:

- Authorization Code + PKCE with `S256`
- Access token **and** refresh token issued (`offline` scope)
- `GET /api/users` returned `200`
- **Genuine user context:** `/auth/discover` and `widgetApi.getUserInformation()` returned the
  same user id, so the token is bound to the acting user — not an app-wide credential that
  merely came through a user-interactive redirect

`getIntegration()` is therefore **not required** for user-context OAuth on the web.

### The mechanism that makes the callback work

The obvious worry — "the page navigates away to the IdP and re-mounts, so how does the code
get back into the widget?" — is **not** the hard part. `sessionStorage` is same-origin and
survives navigation.

What works cleanly is a **popup whose location the opener polls**:

```
widget → window.open(authorize URL)
       → while the popup is at the IdP, reading popup.location THROWS (cross-origin)
         ← that throw is the "still authenticating" signal
       → once the IdP redirects back to our origin, the popup is same-origin
       → the opener reads popup.location.search directly
```

Consequences worth knowing:

- **The widget does not need to be mounted on the redirect-URI page.** Nothing has to run
  inside the popup at all.
- The hosting page never navigates, so the PKCE verifier stays in memory.
- Whether the browser gives you a popup window or a tab is cosmetic — polling works either way,
  and `window.open` cannot be forced to produce a window.

### The one configuration that silently breaks everything

**The redirect URI must be on the widget's own origin.** If the widget is served from
`https://a.example` but the redirect URI points at `https://b.example`, three things break at
once with no error — the popup just appears to hang:

1. the opener cannot read a cross-origin popup's `location`;
2. `sessionStorage` is per-origin, so the verifier is not shared;
3. the token request is refused by CORS.

So all four must be the same origin: **widget → redirect URI → allowed CORS origin → target API.**

### Hard blocker: the HTML / Custom Script widget

This **cannot** work there. That widget renders content in a sandboxed iframe, giving the
document an **opaque origin** (`"null"`), which is cross-origin to everything and makes
`sessionStorage` throw. It has to be a real custom widget (`window.defineBlock`), which mounts
as a Web Component directly in the page with the real origin.

---

## 2. Native app — does not work

In the Staffbase mobile app, widget content runs inside a **Capacitor webview on a custom
scheme**, not on the app's HTTPS origin:

```
scheme:  capacitor:
origin:  capacitor://staffbase.com
```

That single fact invalidates every mechanism above. Routes tried:

| # | Route | Result | Confidence |
|---|---|---|---|
| 1 | Popup + location polling | `window.open` returns **null** — no popup, no `opener` | **Measured** |
| 2 | Popup + `postMessage` | no popup exists to post from | **Measured** |
| 3 | Full-page redirect, HTTPS redirect URI (`https://<app>/…`) | redirect is handed to the **system browser**; the code lands in Safari while the verifier stays in the app's webview under `capacitor://staffbase.com` — different origin, unreachable | **Measured** |
| 4 | Redirect URI `capacitor://staffbase.com/`, registered on a second OAuth client | The IdP **accepts** the custom-scheme registration, but the device cannot deliver it: *"Safari cannot open the page because the address is invalid."* `capacitor://staffbase.com` is Capacitor's **internal** asset-serving origin (a `WKURLSchemeHandler`), not an external URL scheme registered in the app's `Info.plist` | **Measured** |
| 5 | Universal Link as the `redirect_uri` | iOS fires universal links on a **user tap only**, never as the target of an HTTP redirect — so an IdP 302 always lands in Safari | **Documented + Measured** |
| 6 | `https://<app>/openlink/content/page/<pageID>` **tapped** by the user | Correctly opens the app ✅ — but the `?code=` query is not preserved through the deep-link handler | **Measured** |
| 7 | Any custom scheme, probed via `AppLauncher.canOpenUrl` | none reachable — tried `capacitor://staffbase.com/`, `staffbase://`, `com.staffbase.app://`, `ccmuhammad://`, `sb://` | **Measured**¹ |

¹ A negative `canOpenUrl` is not strictly conclusive — iOS only answers for schemes listed in the
calling app's `LSApplicationQueriesSchemes`. It is the ceiling of what JavaScript can observe.
(Note also: `canOpenUrl` returns `true` for *any* `https://` URL because the browser claims web
URLs — that is not evidence about the app.)

### What the native environment does offer

Probed from widget JS via the Capacitor bridge:

- `CapacitorHttp` **present** — the token exchange would be proxied natively and bypass CORS.
  This removes a CORS objection, but is moot: the code never arrives.
- `App` plugin **reachable** — `appUrlOpen` exists in principle.
- `StaffbaseDeepLink` **present** — deep-link routing is owned by Staffbase's native code. A
  callback would be consumed and routed as Staffbase content, not handed to a widget.
- `Browser` plugin **absent** — no way to open the IdP in a controlled auth session
  (`ASWebAuthenticationSession`-style) from widget JS.

### Why none of this is fixable by configuration

The missing pieces live in the **iOS build** — registering an external URL scheme, and
deep-link handling that preserves a query string — and in **iOS platform behaviour**, where
universal links do not fire from a redirect. Neither is reachable from OAuth client
configuration or from widget JavaScript.

---

## 3. Reference: a working web configuration

```
Platform              SPA (public client, no secret)
Client ID             <client id>
Authorize URI         https://id-<region>.staffbase.com/oauth2/auth
Token URI             https://id-<region>.staffbase.com/oauth2/token
Redirect URIs         https://<your-app>/            ← must be the widget's own origin
Allowed CORS Origins  https://<your-app>             ← same origin
Scopes                offline Users.Read.All Groups.Read.All
Session Logout URI    https://id-<region>.staffbase.com/oauth2/sessions/logout
```

- `code_challenge_method=S256` (`plain` is supported by the IdP but should not be used)
- Validate `state` yourself — PKCE gives no CSRF protection
- Include `offline` only if a refresh token is genuinely wanted
- Strip the code from the URL with `history.replaceState` so it does not linger in history
- Endpoints are **per region, not per customer** — a single Staffbase ID issuer serves the whole
  cluster. Confirm them from `https://<id-host>/.well-known/openid-configuration`
- The access token is **opaque** (`ory_at_…`), not a JWT — resolve the user by calling
  `/auth/discover` on the app origin with the bearer token
