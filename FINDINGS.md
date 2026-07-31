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
| 3 | Full-page redirect, HTTPS redirect URI | redirect is handed to the **system browser**; code lands in Safari while the verifier stays in the app's webview — different origin, unreachable | **Measured** |
| 4 | `capacitor://` redirect URI (second OAuth client) | IdP *accepts* the custom scheme, but the device cannot deliver it: *"Safari cannot open the page because the address is invalid"* — `capacitor://` is Capacitor's internal asset scheme, not a registered external URL scheme | **Measured** |
| 5 | Universal Link as the `redirect_uri` | iOS fires universal links on a **user tap only**, never as the target of an HTTP redirect — so an IdP 302 always lands in Safari | **Documented + Measured** |
| 6 | `/openlink/content/page/<id>` **tapped** by the user | Correctly opens the app ✅ — but the `?code=` query is not preserved through the deep-link handler | **Measured** |
| 7 | Any custom scheme via `AppLauncher.canOpenUrl` | none reachable (`capacitor://`, `staffbase://`, `com.staffbase.app://`, `sb://`, …) | **Measured**¹ |

¹ A negative `canOpenUrl` is not strictly conclusive — iOS only answers for schemes in the
calling app's `LSApplicationQueriesSchemes` allowlist. It is the ceiling of what JavaScript can
observe. (Note also: `canOpenUrl` returns `true` for *any* `https://` URL because the browser
claims web URLs — that is not evidence about the app.)

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

The missing pieces live in the **iOS build** (external URL-scheme registration, deep-link
handling) and in **iOS platform behaviour** (universal links not firing on redirects). Neither
is reachable from OAuth client configuration or widget JavaScript.

---

## 3. Why a Custom Plugin is different

A **widget** shares the app's document, so it inherits `capacitor://staffbase.com`.
A **plugin** loads in its own iframe pointing at *your* HTTPS URL. That difference cascades:

- real HTTPS origin → `sessionStorage` and `crypto.subtle` work
- the redirect URI is on **your own** origin → same-origin callback, verifier reachable
- the redirect happens **inside the iframe**, HTTPS → HTTPS → no OS handoff, so no system
  browser, no universal links, no custom schemes. The entire problem class disappears.

**One thing to verify before committing to it:** the IdP must permit being framed. If it sends
`X-Frame-Options: DENY` or a restrictive `frame-ancestors`, its login page will not render in
the plugin's iframe and a popup becomes necessary again. *(Inferred — not yet tested.)*

---

## 4. Two misconceptions worth correcting

**"No client secret means the IdP can't trust the request."**
A client secret only ever authenticated the *client*, never the *user*. The IdP authenticates
the user itself, on its own domain, with credentials the widget never sees. What replaces the
secret is: a pre-registered, exact-matched **redirect URI** (so the code can only be delivered
to our origin), **PKCE** (so only the party that started the flow can redeem it), **`state`**
(CSRF), and single-use short-lived codes. A public client with no secret is the RFC-recommended
pattern for browser apps precisely *because* a browser cannot keep a secret.

**"PKCE means users hold a private key and could impersonate anyone."**
PKCE involves no key and no signing. `code_verifier` is a random per-request string;
`code_challenge` is its SHA-256. Knowing your own verifier lets you complete your own flow —
that is the intent. Impersonation is not possible, because the code is bound to whoever
authenticated at the IdP.

**The real client-side risk is different and worth taking seriously:** tokens in browser storage
are **XSS-exfiltratable**, and any script on the origin can read them. That matters more given a
refresh token and tenant-wide `*.All` scopes. That — not PKCE — is the argument for a backend
holding tokens.

---

## 5. Open item

**Scope enforcement is unverified.** The scopes used (`Users.Read.All`, `Groups.Read.All`) are
tenant-wide. The account used for testing is a branch admin, so `GET /api/users` returning all
users is consistent with *either* "the API enforces the acting user's role" *or* "the scope
alone grants directory read".

**A non-admin account running the same flow and calling `/api/users` settles it.** Until then,
do not rely on these scopes being constrained by the user's permissions.

---

## 6. Reference: a working web configuration

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
