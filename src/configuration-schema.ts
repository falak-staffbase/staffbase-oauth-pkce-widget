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

import { UiSchema } from "@rjsf/utils";
import { JSONSchema7 } from "json-schema";

import { defaultConfig } from "./oauth/config";

/**
 * schema used for generation of the configuration dialog
 * see https://rjsf-team.github.io/react-jsonschema-form/docs/ for documentation
 *
 * Property names are kebab-case because they map 1:1 onto DOM attributes of the
 * web component.
 */
export const configurationSchema: JSONSchema7 = {
  properties: {
    "flow-mode": {
      type: "string",
      title: "Flow mode",
      enum: ["popup", "redirect"],
      default: defaultConfig.flowMode,
    },
    "client-id": {
      type: "string",
      title: "Client ID",
      default: defaultConfig.clientId,
    },
    "authorize-uri": {
      type: "string",
      title: "Authorize URI",
      default: defaultConfig.authorizeUri,
    },
    "token-uri": {
      type: "string",
      title: "Token URI",
      default: defaultConfig.tokenUri,
    },
    "redirect-uri": {
      type: "string",
      title: "Redirect URI",
      default: defaultConfig.redirectUri,
    },
    scopes: {
      type: "string",
      title: "Scopes (space separated)",
      default: defaultConfig.scopes,
    },
    "logout-uri": {
      type: "string",
      title: "Session logout URI",
      default: defaultConfig.logoutUri,
    },
    "test-api-path": {
      type: "string",
      title: "Test API path",
      default: defaultConfig.testApiPath,
    },
    "identity-path": {
      type: "string",
      title: "Identity endpoint path",
      default: defaultConfig.identityPath,
    },
    "native-client-id": {
      type: "string",
      title: "Native app Client ID (optional)",
      default: defaultConfig.nativeClientId,
    },
    "native-redirect-uri": {
      type: "string",
      title: "Native app Redirect URI",
      default: defaultConfig.nativeRedirectUri,
    },
    "api-base-url": {
      type: "string",
      title: "API base URL (native app only)",
      default: defaultConfig.apiBaseUrl,
    },
    "openlink-url": {
      type: "string",
      title: "Staffbase deep link to this widget (optional)",
      default: defaultConfig.openlinkUrl,
    },
  },
};

/**
 * schema to add more customization to the form's look and feel
 * @see https://rjsf-team.github.io/react-jsonschema-form/docs/api-reference/uiSchema
 */
export const uiSchema: UiSchema = {
  "flow-mode": {
    "ui:help":
      "popup: the hosting page stays alive and the callback is posted back to it. redirect: the whole page navigates and sessionStorage carries the flow across.",
  },
  "client-id": {
    "ui:help": "Public SPA client — no secret, PKCE proves the exchange instead.",
  },
  "redirect-uri": {
    "ui:help":
      "Must match a registered redirect URI exactly, including the trailing slash. Place this widget on the page it points at, or the callback has nothing to handle it.",
  },
  scopes: {
    "ui:help": "Include `offline` if you want a refresh token.",
  },
  "test-api-path": {
    "ui:help": "Same-origin path called with the bearer token by the 'Call API' button.",
  },
  "identity-path": {
    "ui:help":
      "Endpoint that reports who the token belongs to. 'Verify identity' compares its user id against widgetApi.getUserInformation() to prove the token is bound to the acting user.",
  },
  "native-client-id": {
    "ui:help":
      "A second OAuth client whose redirect URI is the webview's custom scheme. Used only inside the Staffbase mobile app, where window.open returns null and the HTTPS redirect URI would land on a different origin than the PKCE verifier. Leave empty to disable the native attempt.",
  },
  "native-redirect-uri": {
    "ui:help":
      "Must match the native client's registered redirect URI exactly, and must be the webview's own origin — check 'origin' in Diagnostics on the device.",
  },
  "openlink-url": {
    "ui:help":
      "https://<app>/openlink/content/<pluginID>/<pluginInstanceID>/ — the page this widget sits on. When the code lands in the system browser instead of the app (which is what iOS does with a redirected universal link), the widget offers this as a link to tap so the code reaches the app, where the PKCE verifier is.",
  },
  "api-base-url": {
    "ui:help":
      "Absolute origin for API calls inside the native app, e.g. https://your-app.staffbase.com — a relative path there would resolve against capacitor:// and be served from local assets instead of reaching the API. Ignored on the web, which always uses the current origin.",
  },
};
