// PROTOTYPE background service worker — core Fix loop with loading + toast UX.
//
// Locked decisions implemented:
//  - #2: no static content script. The page-side code is injected via
//        chrome.scripting on the user gesture (context-menu click), under activeTab.
//  - #3: the API key never enters the page. The injected function messages us
//        { type: "MG_FIX", text } and we return { fixedText } — never the key.
//  - #4: replacement uses the React-safe native-setter path for <input>/<textarea>,
//        execCommand('insertText') first for contenteditable.
//
// REVISED interaction model (candidate — not yet locked into the map):
//  - On completion the corrected text is COPIED to the clipboard and a toast with
//    a Paste button appears near the cursor. The user reviews, then clicks Paste
//    (one gesture) to replace in-place, or pastes elsewhere / ignores it.
//  - Replaces the previous "auto-replace in-place" behavior. Decision waits for
//    the user's reaction before being folded into the map.
//
// OUT OF SCOPE for this prototype (per ticket #5): encryption (key plaintext in
// storage.local for now), modes submenu, keyboard shortcut, onboarding, iframe
// targeting. See README.md.

const MODES = {
  "fix-grammar": {
    label: "Fix grammar",
    system:
      "You are a grammar and spelling corrector. Fix grammar, spelling, and " +
      "punctuation errors in the user's text. Return ONLY the corrected text, " +
      "preserving the original language, tone, and formatting (including " +
      "newlines). Do not add explanations or quotation marks.",
  },
};

// --- context menu ---------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "fix-grammar",
    title: "MyGrammar: Fix grammar",
    contexts: ["editable", "selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "fix-grammar") return;
  if (!tab?.id) return;
  chrome.scripting
    .executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content/fix-in-page.js"],
    })
    .catch((err) => console.error("[MyGrammar] inject failed", err));
});

// --- message handler: the sole key holder ---------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "MG_FIX") return; // ignore anything that isn't a Fix
  fixText(message.text, message.mode ?? "fix-grammar")
    .then((fixedText) => sendResponse({ fixedText }))
    .catch((err) => sendResponse({ error: String(err?.message || err) }));
  return true; // keep sendResponse alive for the async response
});

async function fixText(text, modeKey) {
  const mode = MODES[modeKey];
  if (!mode) throw new Error(`Unknown mode: ${modeKey}`);

  const { endpoint, apiKey, model } = await chrome.storage.local.get([
    "endpoint",
    "apiKey",
    "model",
  ]);
  if (!endpoint) throw new Error("No endpoint set. Open the options page.");
  if (!apiKey) throw new Error("No API key set. Open the options page.");
  if (!model) throw new Error("No model set. Open the options page.");

  const url = endpoint.replace(/\/+$/, "") + "/chat/completions";
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: mode.system },
        { role: "user", content: text },
      ],
      temperature: 0,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Provider HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  const fixed = data?.choices?.[0]?.message?.content;
  if (typeof fixed !== "string")
    throw new Error(
      "Unexpected provider response shape (no choices[0].message.content)"
    );
  return fixed;
}
