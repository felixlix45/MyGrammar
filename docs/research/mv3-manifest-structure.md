# MV3 Manifest Structure & Permissions for MyGrammar

**Research for:** GitHub issue #2 — "Research: MV3 manifest structure and permissions for MyGrammar"
**Date:** 2026-07-28
**Scope:** Exact `manifest.json` fields, permission justification strategy, and the set most likely to pass Chrome Web Store (CWS) review.

All claims cite a primary source (Chrome Extensions docs at `developer.chrome.com` or Chrome Web Store docs). Non-primary notes are flagged as such.

---

## 1. Recommended `manifest.json`

This is the structure recommended by this research. Field-by-field justification and citations follow in §2–§9.

```jsonc
{
  "manifest_version": 3,
  "name": "MyGrammar",
  "version": "1.0.0",
  "description": "Fix grammar, tone, and length in any text field. Bring your own OpenAI-compatible API key.",

  "icons": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },

  "action": {
    "default_title": "MyGrammar",
    "default_icon": {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  },

  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },

  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content/content.js"],
      "css": ["content/content.css"],
      "run_at": "document_idle",
      "all_frames": true
    }
  ],

  "options_page": "options/options.html",

  "commands": {
    "fix-grammar-default": {
      "suggested_key": {
        "default": "Ctrl+Shift+Y",
        "mac": "Command+Shift+Y"
      },
      "description": "Fix grammar in the selected text"
    }
  },

  "permissions": [
    "contextMenus",
    "storage",
    "activeTab",
    "scripting"
  ],

  "host_permissions": [
    "https://*/*"
  ],

  "optional_host_permissions": [
    "http://*/*"
  ],

  "minimum_chrome_version": "102"
}
```

> ⚠️ The single hardest decision here is **how to get cross-origin `fetch()` to an arbitrary user-supplied endpoint** and **what content-script `matches` to use**. Both are analyzed in §3 and §4. The recommendation above is a *starting position*; the trade-offs below may push you to a `optional_host_permissions`-first design instead.

---

## 2. Required & manifest fields — field-by-field

Primary source: [Manifest file format](https://developer.chrome.com/docs/extensions/reference/manifest) (`developer.chrome.com/docs/extensions/reference/manifest`).

### Required by the platform
- **`manifest_version`** — integer, only supported value is `3`. *(Manifest file format → "Keys required by the Extensions platform")*
- **`name`** — string, max 75 chars. Identifies the extension in the Web Store, install dialog, and `chrome://extensions`.
- **`version`** — string, 1–4 dot-separated integers (e.g. `"1.0.0"`). See [Version format](https://developer.chrome.com/docs/extensions/reference/manifest/version).

### Required by Chrome Web Store
- **`description`** — string, max 132 chars. *(Manifest file format → "Keys required by Chrome Web Store")*
- **`icons`** — one or more icons. `48` and `128` are the practical minimums. PNG strongly recommended. *(ibid.)*

### Used by MyGrammar
- **`action`** — defines the toolbar icon. For MyGrammar it is icon-only (no popup) — clicking it, or the context menu, triggers a fix. *(Manifest file format → "Optional keys"; [chrome.action](https://developer.chrome.com/docs/extensions/reference/api/action))*
- **`background`** — registers the MV3 service worker. Holds the API key and performs `fetch()` to the user's endpoint. *(ibid.; [About extension service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers))*
- **`content_scripts`** — statically injected script/CSS into matched pages. Detects fields, captures selection, injects result, shows toast. *(ibid.; [Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts))*
- **`options_page`** — full-tab options/onboarding page. See §7. *(ibid.; [Give users options](https://developer.chrome.com/docs/extensions/develop/ui/options-page))*
- **`commands`** — keyboard shortcut. See §6. *(ibid.; [chrome.commands](https://developer.chrome.com/docs/extensions/reference/api/commands))*
- **`permissions` / `host_permissions` / `optional_host_permissions`** — see §3.

---

## 3. Permissions — which API, which manifest key

Primary source: [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) and the [permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list).

### API permissions MyGrammar needs (in `permissions`)

| Permission | Why MyGrammar needs it | Notes |
|---|---|---|
| `contextMenus` | Adds the right-click submenu (Fix grammar / Professional / Casual / Shorten). | Required by [`chrome.contextMenus`](https://developer.chrome.com/docs/extensions/reference/api/contextMenus). **No user-facing warning.** |
| `storage` | Persists the (encrypted) API key, model, mode, endpoint in `chrome.storage.sync`. Syncs across the user's devices. | Required by [chrome.storage](https://developer.chrome.com/docs/extensions/reference/api/storage). **No user-facing warning.** Recommended by the options-page guide explicitly: *"add the `\"storage\"` permission"*. |
| `activeTab` | Grants temporary access to the current tab when the user invokes the extension (action click, shortcut, context menu) — needed to read/modify the focused text field without a permanent broad grant. | Described in [Declare permissions → Manifest example](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions#manifest). **No warning** (grants access only on explicit user gesture). |
| `scripting` | Lets the background worker programmatically inject functions into the tab (e.g. to read/replace the selection) on demand, as an alternative/complement to static `content_scripts`. | Required by [chrome.scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting). Combined with `activeTab` it avoids needing broad permanent host access. **No warning.** |

**Permissions explicitly *not* requested:** `tabs`, `webRequest`, `cookies`, `history`, `clipboardWrite`/`clipboardRead`. None are required for the feature set and each adds a scary warning + review scrutiny. *(Avoiding `tabs` especially matters — see review-process note in §5.)*

### Host permissions — the central trade-off

Primary source: [Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) and [Declare permissions → Host permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions#host-permissions).

Key facts (all from the Cross-origin doc):

1. **Content scripts are subject to the page's same-origin policy** — *"Content scripts initiate requests on behalf of the web origin that the content script has been injected into and therefore content scripts are also subject to the same origin policy."* So the API call **cannot** happen in the content script for an arbitrary cross-origin endpoint.
2. **The service worker CAN make cross-origin `fetch()`** — *"A script executing in an extension service worker or foreground tab can talk to remote servers outside of its origin, as long as the extension requests host permissions."*
3. **`fetch()` from the service worker DOES require host permissions** — confirmed by the same page and the [Declare permissions → Host permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions#host-permissions) list, which includes: *"Make `fetch()` requests from the extension service worker and extension pages."*

➡️ **Conclusion: the background service worker pattern is correct, but it still needs host permissions covering the user's endpoint.**

#### Option A — Broad `host_permissions` (simplest, slowest review)
```jsonc
"host_permissions": ["https://*/*", "http://*/*"]
```
- ✅ Works for any user-supplied endpoint with zero runtime friction.
- ❌ Both `https://*/*` and `http://*/*` (and `<all_urls>`) are called out by the [review-process doc](https://developer.chrome.com/docs/webstore/review-process#review-time-factors) as **"broad host permissions"** that *"give extensions extensive access to the user's web activity"* and cause longer review. Expect to justify it heavily and risk rejection.
- ❌ Triggers the install-time warning *"Read and change all your data on all websites"*. Bad UX, bad for conversions.

#### Option B — `optional_host_permissions` requested at runtime (RECOMMENDED)
```jsonc
"host_permissions": [],
"optional_host_permissions": ["https://*/*", "http://*/*"]
```
Then, on first run / when the user enters their endpoint, call:
```js
chrome.permissions.request({ origins: [originOfUserEndpoint] });
```
- ✅ Install shows **no** host warning → higher install rate.
- ✅ Only the *exact* origin the user chose is granted (least privilege). Reviewers can see the scope is user-driven.
- ✅ Primary-source endorsed pattern: the [Declare permissions manifest example](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions#manifest) shows exactly `"optional_host_permissions": ["https://*/*","http://*/*"]` as the intended shape for "any host, granted at runtime".
- ⚠️ Caveat: CWS reviewers may still flag the *declared* optional patterns during review (they see them in the manifest). Provide a clear **permission justification** (§8) explaining BYOK. Functionally this is the cleanest path.
- ⚠️ You must handle the case where permission is later revoked (`chrome.permissions.contains`) and re-prompt.

#### Option C — `https://*/*` only in `host_permissions`
- A middle ground. `https://*/*` alone is still listed as a "broad host permission" by the [review process](https://developer.chrome.com/docs/webstore/review-process#review-time-factors) but is narrower than `*://*/*`. Rejects plain-HTTP local endpoints (e.g. `http://localhost:1234/v1`), which some local-model users (LM Studio, Ollama OpenAI-compat shim) will hit. Not recommended for a BYOK tool.

**Recommendation:** Start with **Option B** (optional, runtime-requested, scoped to the entered origin). Fall back to **Option C** only if runtime permission prompts hurt the onboarding flow too much. Avoid Option A for a public listing.

> Note on match-pattern semantics for host permissions: per [Cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests#requesting-permission), *"any path information following the host is ignored"* and *"access is granted both by host and by scheme"* — so to cover both http and https for a host you must list both schemes.

---

## 4. Content-script `matches`

Primary source: [Match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns) and [review process](https://developer.chrome.com/docs/webstore/review-process#review-time-factors).

MyGrammar must work on *any* site (Gmail, Docs, LinkedIn, arbitrary textareas), so a narrow match list is impractical. The realistic options:

- **`<all_urls>`** — matches any URL with a permitted scheme. The [match-patterns doc](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns#special) explicitly warns: *"Because it affects all hosts, Chrome web store reviews for extensions that use it may take longer."*
- **`*://*/*`** — functionally near-identical (http+https everywhere); also flagged in [review-process](https://developer.chrome.com/docs/webstore/review-process#review-time-factors) under "broad host permissions".

Either way, a content script that runs everywhere is a **review-time red flag** and must be justified (§8). There is no way around this for a universal grammar tool — competitors (Grammarly, LanguageTool) face the same requirement.

Mitigations to make review pass:
1. **Keep the content script minimal and obviously non-malicious.** It should only touch `<textarea>`, `contenteditable`, and `<input>` elements when the user explicitly invokes a fix. Reviewers read the code.
2. **Do not read page content proactively.** Only act on explicit user gesture (selection + context menu / shortcut / icon). This aligns with the `activeTab` mental model and is what reviewers look for.
3. **Publish source as-authored, not obfuscated.** [Review process](https://developer.chrome.com/docs/webstore/review-process#review-time-factors): *"Obfuscation is disallowed… Minification is allowed, but it can also make reviewing extension code more difficult. Where possible, consider submitting your code as authored."*
4. **Provide a detailed privacy practice + permission justification** (§8).
5. **Consider `activeTab` + `scripting` instead of a static content script** as the most review-friendly architecture: no `matches` at all, the script is injected only on user action. Trade-off: you lose the always-present UI affordances (e.g. a floating "fix" button near fields). If you want those affordances, a static `content_scripts` entry with `<all_urls>` is unavoidable.

**Recommendation:** If floating in-page affordances are required, use `"matches": ["<all_urls>"]` and budget for a longer review. If you can rely solely on context-menu + shortcut + icon, drop `content_scripts` entirely and inject via `chrome.scripting.executeScript` under `activeTab` — this is the **most review-friendly** design and avoids the broad-match flag entirely. *(See [chrome.scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting) and the [Declare permissions manifest example](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions#manifest) using `["scripting","activeTab"]` with no host perms.)*

`run_at: "document_idle"` and `all_frames: true` are standard for field-detection so that editable regions inside iframes (rich-text editors, compose frames) are reachable. *(See [Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts).)*

---

## 5. Background service worker

Primary sources: [Manifest file format → background](https://developer.chrome.com/docs/extensions/reference/manifest), [About extension service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers), [Cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).

```jsonc
"background": {
  "service_worker": "background/service-worker.js",
  "type": "module"
}
```

- **MV3 replaces background pages with service workers.** Only `service_worker` (path) is required; `type: "module"` enables ES module `import`/`export` in the worker. *(Manifest file format → `background`)*
- The worker is **event-driven and ephemeral** — it is spawned to handle events and can be killed between events. Design rules:
  - Register all listeners (`contextMenus.onClicked`, `commands.onCommand`, `runtime.onMessage`, `runtime.onInstalled`) **synchronously at the top level** of the worker, not inside async callbacks. *(Service workers doc)*
  - Do **not** keep state in module-scope variables — it will be lost when the worker is terminated. Use `chrome.storage`.
  - Use `fetch()` (not `XMLHttpRequest`) for the API call. From the [Cross-origin doc](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests#fetch_vs_xmlhttprequest): *"`fetch()` was created specifically for service workers… New work should favor `fetch()` wherever possible."*
- **Security:** the worker must not let the content script dictate an arbitrary fetch URL (confused-deputy risk). The [Cross-origin doc](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests#xhr-vs-content-scripts) explicitly warns against a handler that fetches `request.url` from a content script. Instead, pass only the **text payload** from the content script; the worker reads the **endpoint from `chrome.storage`** and constructs the URL itself. This is the correct, reviewer-friendly pattern for MyGrammar.

---

## 6. Commands (keyboard shortcut)

Primary source: [chrome.commands](https://developer.chrome.com/docs/extensions/reference/api/commands).

```jsonc
"commands": {
  "fix-grammar-default": {
    "suggested_key": {
      "default": "Ctrl+Shift+Y",
      "mac": "Command+Shift+Y"
    },
    "description": "Fix grammar in the selected text"
  }
}
```

Rules (all from the commands doc):

- **The `commands` key in the manifest is what enables the API.** *"The following keys must be declared in the manifest to use this API: `\"commands\"`."*
- **Key-combination requirements:**
  - *"Extension command shortcuts must include either `Ctrl` or `Alt`."*
  - *"On macOS, `Ctrl` is automatically converted into `Command`."* → specify `mac` explicitly.
  - `Shift` is an optional modifier on all platforms.
  - *"An extension can have many commands, but may specify at most four suggested keyboard shortcuts."* (We have one, plus optionally `_execute_action`.)
- **`description` is required** for standard commands (ignored only for `_execute_action`).
- Handle it in the worker: `chrome.commands.onCommand.addListener((command) => {...})`.
- **About `Ctrl+Shift+G`** (the originally planned shortcut): the commands doc does **not** forbid it, but Chrome itself binds **Ctrl+Shift+G** to *"Find previous"* / reload-related actions depending on context, and OS/Chrome shortcuts *"always take priority over Extension command shortcuts and cannot be overridden."* (commands doc → "Key combination requirements"). Several community reports (non-primary) note `Ctrl+Shift+G` collides frequently. **Safer to use a letter not claimed by Chrome**, e.g. `Ctrl+Shift+Y` (the doc's own example) or `Ctrl+Shift+0..9`. The user can always remap via `chrome://extensions/shortcuts`.
- If you want the toolbar icon click to also be keyboard-triggerable, reserve `_execute_action` (no `onCommand` event fires for it; instead `chrome.action.onClicked` fires). Example in the doc uses `Ctrl+Shift+U`/`Command+U`.

**Recommendation:** Use `Ctrl+Shift+Y` (default) / `Command+Shift+Y` (mac) for the grammar-fix command. Document that users can remap. Avoid `Ctrl+Shift+G`.

---

## 7. Options / onboarding page

Primary source: [Give users options](https://developer.chrome.com/docs/extensions/develop/ui/options-page).

Two declaration styles:

**Full page (new tab):**
```jsonc
"options_page": "options/options.html"
```

**Embedded (inside `chrome://extensions`):**
```jsonc
"options_ui": {
  "page": "options/options.html",
  "open_in_tab": false
}
```

- The options page is the right home for **first-run onboarding** (enter API key, endpoint, model, default mode) **and** ongoing settings — they can be the same HTML file.
- The `storage` permission is required to read/write settings; the doc's example explicitly adds `"permissions": ["storage"]`.
- `chrome.runtime.openOptionsPage()` opens whichever style is declared; use it to direct first-run users to onboarding.
- Embedded options have caveats: no Tabs API, `sender.tab` is unset in messages, sizing is auto. *(ibid. → "Consider the differences")*

**Recommendation:** Use **`options_page` (full page)** for MyGrammar. Onboarding needs a form big enough to comfortably explain BYOK, and full-page avoids the embedded-options quirks. Open it automatically on install from `chrome.runtime.onInstalled` when `reason === "install"`.

---

## 8. Chrome Web Store review — justification & rejection risk

Primary source: [Chrome Web Store review process](https://developer.chrome.com/docs/webstore/review-process) and [Program policies](https://developer.chrome.com/docs/webstore/program-policies).

### What makes review slower / riskier
From [review-process → "Notable factors that increase review time"](https://developer.chrome.com/docs/webstore/review-process#review-time-factors):
- **Broad host permissions** — explicitly names `*://*/*`, `https://*/*`, and `<all_urls>`: *"give extensions extensive access to the user's web activity, especially when combined with other permissions. Extensions with this kind of access can collect a user's browsing history… harvest credentials…"*
- **Sensitive execution permissions** — names `tabs` and `downloads` directly; *"Review must verify that each requested permission is actually necessary and is used appropriately."*
- **Obfuscation (disallowed) / minification** (allowed but slows review).

### What reviewers expect in the permission justification (Privacy Practices form)
The CWS submission requires a **Permission Justification** and **Data Use** declarations for each permission. For MyGrammar, write:

| Permission | Suggested justification text |
|---|---|
| `storage` | *"Stores the user's own API key (encrypted), model name, endpoint URL, and selected mode locally and via Chrome Sync so settings follow the user. No analytics are stored."* |
| `contextMenus` | *"Adds right-click submenu entries (Fix grammar, Professional, Casual, Shorten) so the user can trigger a fix on selected text."* |
| `activeTab` | *"Allows the extension to read and replace the text selection in the current tab, only when the user explicitly invokes a fix via icon, shortcut, or context menu. No background reading of page content occurs."* |
| `scripting` | *"Programmatically injects a small function to read/replace the current selection on user action. Used with `activeTab` so no permanent site access is requested."* |
| `host_permissions` / `optional_host_permissions` (`https://*/*`, `http://*/*`) | *"The extension is BYOK (Bring Your Own Key). The user enters their own OpenAI-compatible API endpoint in settings; this permission is required for the extension's background service worker to call that user-chosen endpoint. The extension never calls any server of its own. Access is requested at runtime and scoped to the exact origin the user entered."* |
| `content_scripts` matches `<all_urls>` (if used) | *"The grammar-fix UI must work in editable fields on any website (email, documents, social). The content script only observes text fields and reacts to explicit user actions; it never reads or transmits page content, browsing history, or personal data."* |

### Likely-to-be-rejected patterns
1. **Broad static `host_permissions` (`*://*/*`) + a `content_scripts` match of `<all_urls>` + reading page content proactively.** This combination is exactly what the review doc calls out. Even if approved, review will be long.
2. **Requesting `tabs`, `webRequest`, `cookies`, `history`** — none are needed; each adds a scary warning and review friction. Do not request them.
3. **Minified/obfuscated code with no readable source.** Obfuscation is disallowed outright; even minification slows review. Submit readable code.
4. **Vague or missing permission justification.** A one-liner like "needed for the extension to work" routinely triggers rejection for broad-permission extensions.
5. **No privacy disclosure.** Because the extension transmits selected text to a third-party endpoint (the user's API), the privacy form must disclose *"Authentication information"* and *"Personal communications"* data usage, and confirm it is **not** sold/transferred beyond the disclosed purpose. (Per [Program policies → User Data Privacy](https://developer.chrome.com/docs/webstore/program-policies).)

### Strategy to maximize approval odds
- Prefer `activeTab` + `scripting` over a static `<all_urls>` content script if the UX allows it. *(Most review-friendly.)*
- Prefer `optional_host_permissions` requested at runtime over broad static `host_permissions`. *(Install shows no host warning; least privilege.)*
- Keep the content/worker code minimal and readable; submit unminified for the first review.
- Ship a clear Privacy Policy page and fill the Data Use form honestly (you *do* transmit user-selected text to a user-chosen endpoint).
- The combination `contextMenus` + `storage` + `activeTab` + `scripting` triggers **no permission warnings at install** per the [permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list) — this is the sweet spot.

---

## 9. Storage & encryption note

`chrome.storage.sync` (and `.local`) is **not encrypted at rest by the platform** — it stores arbitrary JSON. The Chromium guidance for sensitive data (e.g. API keys, tokens) is to encrypt before writing to disk. Community/best-practice references (non-primary):
- Encrypt the API key with a key derived from a user passphrase, or use WebCrypto with a non-exportable key, before `chrome.storage.sync.set`.
- This is an implementation concern, not a manifest concern; it does not require any additional manifest permission. `storage` already covers it.

> ⚠️ Primary-source gap: I did not find a `developer.chrome.com` page that *mandates* encryption of secrets in `chrome.storage`. Treat "store encrypted" as a strong best practice, not a documented requirement.

---

## 10. Decision summary

| Decision | Recommendation | Rationale |
|---|---|---|
| `permissions` | `["contextMenus","storage","activeTab","scripting"]` | All four are warning-free at install; covers every feature. [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) |
| API endpoint access | `optional_host_permissions: ["https://*/*","http://*/*"]`, request at runtime, scoped to entered origin | BYOK needs any host; runtime + scoped grant is least-privilege and avoids the install-time broad-host warning. [Declare permissions manifest example](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions#manifest) |
| Content script | If floating affordances needed: `"matches":["<all_urls>"]`. If not: drop `content_scripts`, inject via `scripting`+`activeTab`. | `<all_urls>` triggers longer review ([review-process](https://developer.chrome.com/docs/webstore/review-process#review-time-factors), [match-patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns#special)). The scripting path avoids it. |
| Background | `type: "module"`; register listeners at top level; use `fetch()`; never fetch a content-script-supplied URL | [Service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers), [Cross-origin requests security](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests#xhr-vs-content-scripts) |
| Shortcut | `Ctrl+Shift+Y` / `Command+Shift+Y` (avoid `Ctrl+Shift+G`) | Must include `Ctrl`/`Alt`; OS/Chrome shortcuts override extensions ([commands](https://developer.chrome.com/docs/extensions/reference/api/commands)). |
| Options | `options_page: "options/options.html"` (full page); auto-open on install | Onboarding form needs space; avoids embedded-options quirks ([options page](https://developer.chrome.com/docs/extensions/develop/ui/options-page)). |
| `minimum_chrome_version` | `"102"` | Earliest Chrome with stable MV3 service-worker + `chrome.scripting`. Pin to your tested floor. |

---

## Primary sources cited

1. [Manifest file format](https://developer.chrome.com/docs/extensions/reference/manifest)
2. [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
3. [Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
4. [Match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)
5. [Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
6. [About extension service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers)
7. [chrome.commands](https://developer.chrome.com/docs/extensions/reference/api/commands)
8. [chrome.contextMenus](https://developer.chrome.com/docs/extensions/reference/api/contextMenus)
9. [chrome.scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
10. [chrome.storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
11. [chrome.action](https://developer.chrome.com/docs/extensions/reference/api/action)
12. [Give users options (options page)](https://developer.chrome.com/docs/extensions/develop/ui/options-page)
13. [Chrome Web Store review process](https://developer.chrome.com/docs/webstore/review-process)
14. [Developer Program Policies](https://developer.chrome.com/docs/webstore/program-policies)
15. [Permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list)
