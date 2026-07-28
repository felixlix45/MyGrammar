# MyGrammar — Core Fix loop prototype

**PROTOTYPE — throwaway.** Validates the core Fix loop end-to-end before building
the production extension. Implements the locked decisions from research tickets
#2, #3, #4 (see the [wayfinder map](https://github.com/felixlix45/MyGrammar/issues/1)).

## What this proves

Select text → right-click → **MyGrammar: Fix grammar**:

1. A small loading indicator appears near the cursor while the AI works.
2. On completion, the corrected text is **copied to the clipboard**.
3. A toast appears near the cursor: **✓ Fixed — click Paste.**
4. Click **Paste** to replace the selection in-place — or paste elsewhere / ignore it.

One mode only (Fix grammar).

## Why copy + click-to-paste (revised interaction model)

The first prototype replaced the selection directly. User feedback (Felix):
auto-replacing is unsafe — no chance to review before committing, and the text is
trapped in the field. This revision **always copies to clipboard** and requires a
click to paste. Safety of clipboard (review / paste elsewhere / ignore) plus low
friction (one click, no mandatory Ctrl+V). This is a **candidate change to the
locked interaction model** — it's not folded into the map yet; the decision waits
on reaction to this prototype.

**Technical note — clipboard + gestures:** browsers require a user gesture to
write the clipboard, but the right-click gesture has expired by the time the API
responds. So the immediate copy on completion is best-effort; the **Paste click
(a fresh gesture) is the reliable path** and re-writes the clipboard before
pasting. The toast reflects the current state ("Fixed — click Paste" vs.
"Fixed — click Paste to copy").

## Architecture (matches the locked decisions)

- **No static content script** (#2). On the context-menu gesture, the worker
  injects `content/fix-in-page.js` via `chrome.scripting` under `activeTab`.
- **The API key never enters the page** (#3). The injected script messages the
  worker `{ type: "MG_FIX", text }` and receives `{ fixedText }` — never the key.
- **React-safe replacement** (#4). The Paste click uses the native-setter path
  for `<input>`/`<textarea>`; `execCommand('insertText')` first for contenteditable.
- **Runtime host permission** (#2). On Save, the options page requests
  `chrome.permissions.request` for the exact origin of the entered endpoint.
- **Selection snapshot.** The original selection is captured before the async
  API call and restored on Paste, so the replacement always targets what the
  user originally selected — even if focus drifted during the round-trip.

## Load it

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. **Load unpacked** → select this folder (`prototype/core-fix-loop`).
   (If upgrading from v0.0.1, click the reload arrow on the extension card.)
4. Open the extension's **Details → Extension options** (or right-click the
   toolbar icon → Options). Enter:
   - **Endpoint base URL** — e.g. `https://api.openai.com/v1` (worker appends
     `/chat/completions`). For local models: `http://localhost:1234/v1`.
   - **API key**, **Model** (e.g. `gpt-4o-mini`).
   - Click **Save** — Chrome will prompt for host permission on that origin.
   - (Optional) **Test connection** to confirm credentials.
5. Open `test-page/index.html` in the browser (file:// or via a static server).
6. Select text → right-click → **MyGrammar: Fix grammar**.

## Console output

The worker logs to the extension's service-worker console
(`chrome://extensions` → "Inspect views: service worker"). Page-side errors show
in the toast itself; provider errors show there too.

## New permission vs v0.0.1

- **`clipboardWrite`** added — needed to write the corrected text to the
  clipboard. No scary install warning, but it'll need a line in the eventual
  Web Store permission justification.

## Out of scope for this prototype (per ticket #5)

- Modes submenu, keyboard shortcut, onboarding flow.
- **Encryption** — the API key is stored plaintext in `chrome.storage.local`.
- Icons (Chrome shows a default puzzle piece).
- Iframe text-field targeting — `allFrames: true` is requested on inject, but
  the toast/clipboard logic is not frame-aware yet.

## Files

```
manifest.json                 MV3, scripting-injection, +clipboardWrite
background/service-worker.js  context menu + provider fetch + injection
content/fix-in-page.js        injected page-side: loading + clipboard + toast + paste
content/toast.css             toast styling (loaded via web_accessible_resources)
options/options.html|.js      endpoint/model/key + runtime host-permission request
test-page/index.html          textarea + input + contenteditable to try
```
