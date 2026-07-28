# MyGrammar — Core Fix loop prototype

**PROTOTYPE — throwaway.** Validates the core Fix loop end-to-end before building
the production extension. Implements the locked decisions from research tickets
#2, #3, #4 (see the [wayfinder map](https://github.com/felixlix45/MyGrammar/issues/1)).

## What this proves

Select text → right-click → **MyGrammar: Fix grammar** → the selection is
replaced in-place with the provider's corrected text. One mode only.

## Architecture (matches the locked decisions)

- **No static content script** (#2). On the context-menu gesture, the background
  worker injects one self-contained function via `chrome.scripting.executeScript`
  under `activeTab`.
- **The API key never enters the page** (#3). The injected function messages the
  worker `{ type: "MG_FIX", text }` and receives `{ fixedText }` — never the key.
- **React-safe replacement** (#4). Native `<input>`/`<textarea>` use the
  native-setter path; contenteditable uses `execCommand('insertText')` first.
- **Runtime host permission** (#2). On Save, the options page requests
  `chrome.permissions.request` for the exact origin of the entered endpoint.

## Load it

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. **Load unpacked** → select this folder (`prototype/core-fix-loop`).
4. Click the extension's **Details → Extension options** (or right-click the
   toolbar icon → Options). Enter:
   - **Endpoint base URL** — e.g. `https://api.openai.com/v1` (worker appends
     `/chat/completions`). For local models: `http://localhost:1234/v1`.
   - **API key**, **Model** (e.g. `gpt-4o-mini`).
   - Click **Save** — Chrome will prompt for host permission on that origin.
   - (Optional) **Test connection** to confirm credentials.
5. Open `test-page/index.html` in the browser (file:// or via a static server).
6. Select text → right-click → **MyGrammar: Fix grammar**.

## Console output

The worker logs the per-frame fix result to **the extension's service-worker
console** (`chrome://extensions` → "Inspect views: service worker"). API errors
are returned to the injected function and surfaced there too. No on-page toast —
that's out of scope.

## Out of scope for this prototype (per ticket #5)

- Modes submenu, keyboard shortcut, toasts, onboarding flow.
- **Encryption** — the API key is stored plaintext in `chrome.storage.local`.
- Icons (Chrome shows a default puzzle piece).
- Iframe text-field targeting — `allFrames: true` is set, but untested here.

## Known limitations to react to

- The selection must stay live during the API round-trip. If focus/selection
  moves between right-click and the response, replacement targets the current
  (possibly wrong) selection. Acceptable for a prototype; production should
  capture+restore the selection range.
- Undo on native controls: the native-setter path does not integrate with the
  browser's input undo the way `execCommand` does for contenteditable. (Map fog.)
- No error toast — failures only appear in the console.

## Files

```
manifest.json                 MV3, scripting-injection architecture
background/service-worker.js  context menu + provider fetch + injection
options/options.html|.js      endpoint/model/key + runtime host-permission request
test-page/index.html          textarea + input + contenteditable to try
```
