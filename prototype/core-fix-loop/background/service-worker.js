// PROTOTYPE background service worker — core Fix loop only.
//
// Locked decisions implemented:
//  - #2: no static content script. Page-side code is injected via chrome.scripting
//        on the user gesture (context-menu click), under activeTab.
//  - #3: the API key never enters the page. The injected function messages us
//        { type: "MG_FIX", text } and we return { fixedText } — never the key.
//  - #4: replacement uses the React-safe native-setter path for <input>/<textarea>,
//        execCommand('insertText') first for contenteditable.
//
// OUT OF SCOPE for this prototype (per ticket #5): encryption (key is plaintext in
// storage.local for now), modes submenu, keyboard shortcut, toasts, onboarding,
// iframe targeting. See README.md.

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

// Register listeners synchronously at the top level (MV3 worker rule).
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
  runFixInTab(tab.id).catch((err) => {
    console.error("[MyGrammar] fix failed", err);
  });
});

// --- the loop: inject the page-side function ------------------------------

async function runFixInTab(tabId) {
  // Inject into all frames so text fields in iframes are reachable too.
  // activeTab (granted by the context-menu gesture) covers the permission.
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: pageSideFixLoop,
  });

  // executeScript returns one entry per frame; find the meaningful one.
  const meaningful = results
    .map((r) => ({ frameId: r.frameId, ...(r.result || {}) }))
    .find((r) => r.ok || (r.reason && r.reason !== "no-editable-target"));

  if (meaningful) {
    console.log("[MyGrammar] fix result:", meaningful);
  } else {
    console.log("[MyGrammar] no editable target / no selection in any frame");
  }
}

// This function is serialized and injected into the page's isolated world.
// It MUST be self-contained (no closure variables — only `args` carry across).
// It shares the page's DOM (so it can read/write the selection and field value)
// and runs as a content script (so chrome.runtime.sendMessage works).
async function pageSideFixLoop() {
  const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel"]);

  // 1. Find the focused editable element (descend through Shadow DOM).
  let el = document.activeElement;
  while (el && el.shadowRoot) el = el.shadowRoot.activeElement;

  // 2. Read the selection + remember which path to use for replacement.
  let kind;
  if (
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type))
  ) {
    if (el.readOnly || el.disabled) return { ok: false, reason: "read-only" };
    if (el.selectionStart === el.selectionEnd)
      return { ok: false, reason: "no-selection" };
    kind = "native";
  } else if (el && el.isContentEditable) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed)
      return { ok: false, reason: "no-selection" };
    kind = "ce";
  } else {
    return { ok: false, reason: "no-editable-target" };
  }

  // Capture the selected text for the API call.
  const selectedText =
    kind === "native"
      ? el.value.slice(el.selectionStart, el.selectionEnd)
      : window.getSelection().toString();

  if (!selectedText.trim())
    return { ok: false, reason: "empty-selection" };

  // 3. Ask the background to fix it. The key never enters the page.
  let corrected;
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "MG_FIX",
      mode: "fix-grammar",
      text: selectedText,
    });
    if (!resp || resp.error)
      return { ok: false, reason: "api-error", error: resp?.error || "no response" };
    corrected = resp.fixedText;
  } catch (err) {
    return { ok: false, reason: "send-failed", error: String(err) };
  }

  // 4. Replace in-place — selection is still live (no async since the send).
  if (kind === "native") {
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const next = el.value.slice(0, s) + corrected + el.value.slice(e);
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.setSelectionRange(s + corrected.length, s + corrected.length);
  } else {
    // execCommand first (preserves undo); Range API fallback.
    if (!document.execCommand("insertText", false, corrected)) {
      const sel = window.getSelection();
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(corrected);
      range.insertNode(node);
      node.parentNode.normalize();
      const r2 = document.createRange();
      r2.setStartAfter(node);
      r2.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r2);
    }
  }

  return {
    ok: true,
    kind,
    originalLen: selectedText.length,
    fixedLen: corrected.length,
  };
}

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
    throw new Error("Unexpected provider response shape (no choices[0].message.content)");
  return fixed;
}
