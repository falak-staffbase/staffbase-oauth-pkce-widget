# staffbase-org / oauth-client

A Staffbase custom widget that runs its own **OAuth2 Authorization Code + PKCE** flow
against Staffbase ID, in *user* context — no `client_credentials`, and without going
through `widgetApi.getIntegration()`.

## Why the callback is the hard part

The widget is a Web Component mounted inside the Staffbase SPA, and the registered
redirect URI is the app root:

```
https://ccmuhammad.staffbase.com/
```

Staffbase ID (Ory Hydra) matches redirect URIs **exactly**, so a dedicated
`/oauth-callback` page is not an option — and there is nowhere to host a static callback
file on that origin anyway. The authorization code therefore lands on the platform's
start page, where **the only thing that can observe it is a widget mounted on that
page**.

In **popup** mode this is solved without needing the widget on the start page: the opener
polls `popup.location.search`. While the popup is at the IdP that read throws
(cross-origin) — which is precisely the signal that the user is still authenticating. The
moment the IdP redirects the popup back to our origin, the popup becomes same-origin and
fully readable from the opener, so the code can be collected with **no script running
inside the popup at all**. See
[`src/oauth/use-oauth.ts`](src/oauth/use-oauth.ts).

In **redirect** mode there is no opener, so the widget genuinely must be on the page the
redirect URI points at — and the URL must be read as early as possible, because the
Staffbase SPA owns the router on `/` and may rewrite the location before React mounts.
[`src/oauth/callback.ts`](src/oauth/callback.ts) therefore snapshots
`window.location.search` at *module-evaluation* time and immediately parks the result in
`sessionStorage`.

## Flow modes

| | `popup` (default) | `redirect` |
|---|---|---|
| Hosting page | stays alive | navigates away, widget destroyed |
| Widget needed on start page | **no** | **yes** |
| Code delivery | opener reads `popup.location` | `sessionStorage` bridges the navigation |
| PKCE verifier | never leaves memory | round-trips through `sessionStorage` |
| Mobile app webview | popups are often blocked | more reliable |

Popup mode collects the code three ways, in order of robustness:

1. **`popup.location.search` read from the opener** — the primary path; needs nothing in
   the popup.
2. **`popup.sessionStorage`** — if the SPA already rewrote the popup's URL but the widget
   bundle loaded there and parked the code.
3. **`postMessage`** — if the widget is mounted on the redirect page, that instance posts
   the response to its opener (pinned to `window.location.origin`) and closes.

## The redirect URI must be on the widget's own origin

This is the single most common way to break the flow, and it fails silently — the popup
just appears to hang. If the widget is served from `https://a.example` but the redirect URI
points at `https://b.example`, three things break at once:

- the opener cannot read a **cross-origin** popup's `location`, so the code is never seen;
- `sessionStorage` is **per-origin**, so the PKCE verifier is not shared either;
- the token request would be refused by **CORS**.

So the registration must list the origin the widget actually runs on:

```
Redirect URIs:         https://<widget-origin>/
Allowed CORS Origins:  https://<widget-origin>
```

`redirectUri` therefore defaults to `${window.location.origin}/` rather than a hardcoded
host, and `configurationBlockers()` refuses to start the flow on a mismatch, naming both
origins and the exact registration change needed.

Watch for environment mismatches too: a `*.staffbase.rocks` (staging) app authorizing
against a production `id-us1.staffbase.com` IdP is a mismatch of this kind.

## Sandboxing: what breaks and why

A document under an iframe `sandbox` attribute **or** a CSP `sandbox` directive cannot
relax its own sandbox — only whoever serves/embeds it can. Two flags decide whether this
widget can work at all:

| Flag | Without it |
|---|---|
| `allow-same-origin` | The document gets an **opaque origin** (`"null"`). It is then cross-origin to *everything*, so the opener can never read the popup's `location`, and `sessionStorage` throws. **Fatal** — the widget detects this and refuses to start. |
| `allow-popups-to-escape-sandbox` | The popup **inherits the sandbox**. The IdP login page then loads sandboxed too, and without `allow-forms` the user cannot even submit credentials. A sandboxed popup is also what browsers most often render as a plain tab. |

So `sandbox allow-popups allow-scripts allow-same-origin` gets you past the fatal case but
still hands the IdP a sandboxed popup. Add `allow-popups-to-escape-sandbox`:

```
Content-Security-Policy: sandbox allow-popups allow-popups-to-escape-sandbox allow-scripts allow-same-origin
```

Note that `allow-scripts` together with `allow-same-origin` is a documented sandbox escape
— framed content can reach out and remove its own sandbox attribute — so a `sandbox`
directive granting both provides essentially no isolation. If you control the header,
dropping the `sandbox` directive for this app is simpler and no less safe.

The widget's **Diagnostics** panel reports `in iframe`, `origin`, `opaque origin`,
`sessionStorage` and `crypto.subtle` so this can be confirmed rather than guessed at.

### Popup vs. new tab

`window.open` is asked for a window via `popup=true` plus explicit
`width`/`height`/`left`/`top` and the legacy `menubar=no,toolbar=no,location=no` hints.
This is a **request, not a guarantee** — a browser configured to open new windows as tabs,
some extensions, and a sandboxed context can all still produce a tab. Nothing in JS can
override that. The flow completes either way, because the opener polls the popup's
location rather than relying on anything running inside it.

## Security notes

- `code_challenge_method` is `S256` only; `plain` is deliberately not implemented.
- `state` is validated before the token endpoint is touched — PKCE does not provide CSRF
  protection on its own.
- The code is stripped from the address bar via `history.replaceState` so it does not sit
  in history or leak through `Referer`.
- Tokens live in `sessionStorage`: same-origin, survives navigation, dies with the tab.
  A refresh token in browser storage is inherently exposed to anything running on the
  origin — fine for a test widget, worth a second thought for production.
- The token endpoint is cross-origin, so this only works because the client registration
  lists the widget's origin under **Allowed CORS Origins**. A CORS failure shows up as
  `TypeError: Failed to fetch` with no status, which the widget reports explicitly.
- The `offline` scope is what makes the IdP issue a refresh token at all.

## Configuration

All settings are widget attributes (kebab-case) with defaults from the registered client,
so an unconfigured instance works out of the box. See
[`src/oauth/config.ts`](src/oauth/config.ts).

## Installation

```bash
$ npm install
```

## Running the app

| Command | Description |
|---|---|
| `npm start` | Starts the development server |
| `npm run build` | Creates the production build |
| `npm run build:watch` | Creates the production build and watch for changes |
| `npm run test` | Runs the unit tests |
| `npm run test:watch` | Runs the unit tests and watches for changes |
| `npm run type-check` | Checks the codebase on type errors |
| `npm run type-check:watch` | Checks the codebase on type errors and watches for changes |
| `npm run lint` | Checks the codebase on style issues |
| `npm run lint:fix` | Fixes style issues in the codebase |


## Building the form for configuration

This project uses [react-jsonschema-form](https://rjsf-team.github.io/react-jsonschema-form/) for configuring the widget properties. For more information consult their [documentation](https://rjsf-team.github.io/react-jsonschema-form/docs/) 
