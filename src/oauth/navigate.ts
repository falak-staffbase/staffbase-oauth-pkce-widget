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
 * Full-page navigation, behind a seam.
 *
 * `window.location.assign` is non-configurable in jsdom, so it cannot be stubbed
 * directly. Routing every navigation through this module makes the redirect paths
 * testable — which matters, because they are the iOS fallback and the hardest thing to
 * exercise by hand.
 */
export const navigate = (url: string): void => {
  window.location.assign(url);
};
