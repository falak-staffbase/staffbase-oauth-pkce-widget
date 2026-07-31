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
};
