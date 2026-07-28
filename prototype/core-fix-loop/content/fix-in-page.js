// PROTOTYPE page-side fix loop: loading indicator + clipboard + click-to-paste toast.
//
// Injected as a FILE (chrome.scripting "files") so it can carry CSS without
// serializing a giant inline function. Runs in the page's isolated world: shares
// the DOM (can read/write the selection, the field, render UI) and has access to
// chrome.runtime.sendMessage, but never receives the API key.
//
// chrome.scripting injects this file fresh on each context-menu click — so we
// run runFix() every time (one Fix per click). The dismiss listener is the only
// thing that should be registered exactly once per page load.
runFix();
if (!window.__mygrammarDismissBound) {
  window.__mygrammarDismissBound = true;
  document.addEventListener(
    "click",
    (e) => {
      if (!currentBox) return;
      // Click landed inside the shadow DOM (e.target retargets to the host on a
      // closed root) — let the Paste handler deal with it, don't dismiss.
      if (currentBox.host.contains(e.target)) return;
      hideBox();
    },
    true
  );
}

async function runFix() {
  const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel"]);

  // --- 1. locate the focused editable element ---------------------------
  let el = document.activeElement;
  while (el && el.shadowRoot) el = el.shadowRoot.activeElement;

  let kind;
  if (
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type))
  ) {
    if (el.readOnly || el.disabled) {
      showBox({ kind: "error", text: "Field is read-only." }, el);
      return;
    }
    if (el.selectionStart === el.selectionEnd) {
      showBox({ kind: "error", text: "Select some text first." }, el);
      return;
    }
    kind = "native";
  } else if (el && el.isContentEditable) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      showBox({ kind: "error", text: "Select some text first." }, el);
      return;
    }
    kind = "ce";
  } else {
    // Nothing editable focused — toast at the click position is pointless; skip.
    return;
  }

  // --- 2. capture selection + position BEFORE the async call ------------
  // (The API call is async; the selection can drift. We snapshot now and
  // restore on paste so the replacement is always the original target.)
  const selectedText =
    kind === "native"
      ? el.value.slice(el.selectionStart, el.selectionEnd)
      : window.getSelection().toString();

  if (!selectedText.trim()) {
    showBox({ kind: "error", text: "Nothing selected." }, el);
    return;
  }

  // For native controls, store offsets; for contenteditable, store the Range.
  const target = kind === "native"
    ? { kind: "native", el, start: el.selectionStart, end: el.selectionEnd }
    : { kind: "ce", el, range: window.getSelection().getRangeAt(0).cloneRange() };

  const anchorRect = caretRect();

  // --- 3. show the loading indicator while the AI works -----------------
  showBox({ kind: "loading", text: "Fixing…" }, null, anchorRect);

  let corrected;
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "MG_FIX",
      mode: "fix-grammar",
      text: selectedText,
    });
    if (!resp || resp.error) {
      hideBox();
      showBox(
        { kind: "error", text: truncate(resp?.error || "No response from background.") },
        null,
        anchorRect
      );
      return;
    }
    corrected = resp.fixedText;
  } catch (err) {
    hideBox();
    showBox(
      { kind: "error", text: truncate(String(err?.message || err)) },
      null,
      anchorRect
    );
    return;
  }

  // --- 4. clipboard copy (best-effort) + click-to-paste toast -----------
  // Browsers require a user gesture to write the clipboard. The right-click
  // gesture has expired by now, so the immediate copy may fail silently — the
  // Paste button (a fresh gesture) is the reliable path. We try the async API
  // first; if it throws, the toast still shows and Paste writes it then.
  let copied = false;
  try {
    await navigator.clipboard.writeText(corrected);
    copied = true;
  } catch {
    // Will be written on the Paste click instead.
  }

  showBox(
    {
      kind: "done",
      text: copied ? "Fixed — click Paste." : "Fixed — click Paste to copy.",
      corrected,
      target,
      alreadyCopied: copied,
    },
    null,
    anchorRect
  );
}

// --- replacement: the React-safe native-setter + execCommand paths (#4) ---

function applyPaste(target, corrected) {
  if (target.kind === "native") {
    const { el, start, end } = target;
    const next = el.value.slice(0, start) + corrected + el.value.slice(end);
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
    el.setSelectionRange(start + corrected.length, start + corrected.length);
  } else {
    const { el, range } = target;
    el.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    if (!document.execCommand("insertText", false, corrected)) {
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
}

// --- the floating UI (loading / done / error) ----------------------------
// Renders into a Shadow DOM so host-page CSS can't interfere.

let currentBox = null; // { host, shadow }

function ensureShadow() {
  if (currentBox) return currentBox;
  const host = document.createElement("div");
  host.style.all = "initial";
  const shadow = host.attachShadow({ mode: "closed" });

  // Inline the CSS as a <style> tag (NOT a <link>). A <link> loads
  // asynchronously, so the FIRST showBox() — the loading indicator, created
  // the instant the user right-clicks — would render before the stylesheet
  // applied: unstyled, transparent, in flow at the bottom of the page. The
  // user would see the done toast (CSS live by then) but never the spinner.
  // A <style> tag applies synchronously, so the loading box is styled on the
  // same frame it's created. This also drops the web_accessible_resources
  // dependency.
  const style = document.createElement("style");
  style.textContent = TOAST_CSS;
  shadow.appendChild(style);

  const wrapper = document.createElement("div");
  wrapper.className = "mygrammar-shadow";
  shadow.appendChild(wrapper);

  document.documentElement.appendChild(host);
  currentBox = { host, shadow, wrapper };
  return currentBox;
}

// Inlined copy of content/toast.css. Kept in sync manually for the prototype;
// production should bundle or generate this.
const TOAST_CSS = `
.mygrammar-shadow,
.mygrammar-shadow * {
  box-sizing: border-box;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

.mygrammar-box {
  position: fixed;
  z-index: 2147483647;
  background: #1f2937;
  color: #fff;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.3;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 320px;
  animation: mygrammar-fade-in 120ms ease-out;
}

@keyframes mygrammar-fade-in {
  from { opacity: 0; transform: translateY(2px); }
  to   { opacity: 1; transform: translateY(0); }
}

.mygrammar-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: mygrammar-spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes mygrammar-spin {
  to { transform: rotate(360deg); }
}

.mygrammar-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mygrammar-paste-btn {
  background: #3b82f6;
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
}

.mygrammar-paste-btn:hover { background: #2563eb; }
.mygrammar-paste-btn:active { background: #1d4ed8; }

.mygrammar-check {
  color: #34d399;
  font-weight: 700;
  flex-shrink: 0;
}

.mygrammar-err .mygrammar-text { color: #fca5a5; }
`;

function showBox(state, _el, anchorRect) {
  const { wrapper } = ensureShadow();
  wrapper.innerHTML = "";

  const box = document.createElement("div");
  box.className = "mygrammar-box";

  if (state.kind === "loading") {
    box.innerHTML =
      '<div class="mygrammar-spinner"></div>' +
      '<div class="mygrammar-text"></div>';
    box.querySelector(".mygrammar-text").textContent = state.text;
  } else if (state.kind === "error") {
    box.classList.add("mygrammar-err");
    box.innerHTML =
      '<span class="mygrammar-check">✕</span>' +
      '<div class="mygrammar-text"></div>';
    box.querySelector(".mygrammar-text").textContent = state.text;
  } else if (state.kind === "done") {
    box.innerHTML =
      '<span class="mygrammar-check">✓</span>' +
      '<div class="mygrammar-text"></div>' +
      '<button class="mygrammar-paste-btn" type="button">Paste</button>';
    box.querySelector(".mygrammar-text").textContent = state.text;

    const btn = box.querySelector(".mygrammar-paste-btn");
    btn.addEventListener("click", async () => {
      // Fresh user gesture — clipboard write is guaranteed here.
      try {
        await navigator.clipboard.writeText(state.corrected);
      } catch {
        /* best-effort; the in-place paste proceeds regardless */
      }
      applyPaste(state.target, state.corrected);
      hideBox();
    });
  }

  wrapper.appendChild(box);

  // Position near the anchor (caret/click); fall back to top-right.
  const rect = anchorRect || (caretRect());
  positionBox(box, rect);
}

function hideBox() {
  if (!currentBox) return;
  currentBox.host.remove();
  currentBox = null;
}

function positionBox(box, rect) {
  if (!rect) {
    box.style.top = "16px";
    box.style.right = "16px";
    return;
  }
  const margin = 8;
  let left = rect.left;
  let top = rect.bottom + margin;
  // Flip above if it would overflow the viewport bottom.
  const boxHeight = 40; // approx, for the flip check
  if (top + boxHeight > window.innerHeight) {
    top = Math.max(margin, rect.top - boxHeight - margin);
  }
  // Clamp horizontally into view.
  left = Math.min(
    Math.max(margin, left),
    window.innerWidth - box.offsetWidth - margin
  );
  box.style.left = left + "px";
  box.style.top = top + "px";
}

// --- helpers --------------------------------------------------------------

// Best available caret position. For contenteditable, getSelection().getRangeAt
// .getBoundingClientRect() works; for native controls, fall back to the element.
function caretRect() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r && (r.top || r.left || r.bottom || r.right)) return r;
  }
  const el = document.activeElement;
  if (el && typeof el.getBoundingClientRect === "function") {
    const r = el.getBoundingClientRect();
    if (r && (r.top || r.bottom)) return r;
  }
  return null;
}

function truncate(s, n = 80) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Click outside the toast dismisses it.
document.addEventListener(
  "click",
  (e) => {
    if (!currentBox) return;
    // The click landed inside the shadow DOM — let the Paste handler deal with it.
    if (currentBox.host.contains(e.target)) return;
    hideBox();
  },
  true
);
