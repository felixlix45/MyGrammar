// PROTOTYPE page-side fix loop — DIAGNOSTIC BUILD (v0.0.3-dbg).
//
// Felix reports the loading indicator / toast don't appear at all. Two prior
// fixes (inline CSS, file injection) didn't resolve it — so this build stops
// guessing and emits an UNMISSABLE on-page trace so we can see exactly where
// execution stops. Every step appends a green line to a fixed panel; if the
// panel appears but stops mid-way, we know the failing step. If the panel
// DOESN'T appear, the script isn't injecting at all (different problem).
//
// Also wraps everything in a top-level try/catch that shows a RED toast with
// the error message — no more silent failures.
//
// Remove the diagnostic block (diag*, TOPLEVEL_ERR_TOAST_CSS) once the cause
// is found.

// --- top-level catch: any throw in this script surfaces as a red toast ---
try {
  runFix();
} catch (err) {
  showFatalToast(String(err?.stack || err?.message || err));
}

if (!window.__mygrammarDismissBound) {
  window.__mygrammarDismissBound = true;
  document.addEventListener(
    "click",
    (e) => {
      if (!currentBox) return;
      if (currentBox.host.contains(e.target)) return;
      hideBox();
    },
    true
  );
}

async function runFix() {
  diag("start");
  const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel"]);

  // --- 1. locate the focused editable element ---------------------------
  let el = document.activeElement;
  while (el && el.shadowRoot) el = el.shadowRoot.activeElement;
  diag("activeElement: " + (el ? `<${el.tagName.toLowerCase()}${el.isContentEditable ? " [contenteditable]" : ""}>` : "null"));

  let kind;
  if (
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type))
  ) {
    if (el.readOnly || el.disabled) {
      diag("field read-only/disabled → stop");
      showBox({ kind: "error", text: "Field is read-only." }, el);
      return;
    }
    if (el.selectionStart === el.selectionEnd) {
      diag("no selection in native field → stop");
      showBox({ kind: "error", text: "Select some text first." }, el);
      return;
    }
    kind = "native";
  } else if (el && el.isContentEditable) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      diag("no selection in contenteditable → stop");
      showBox({ kind: "error", text: "Select some text first." }, el);
      return;
    }
    kind = "ce";
  } else {
    diag("no editable focused → stop (silent)");
    return;
  }
  diag("kind=" + kind);

  // --- 2. capture selection + position BEFORE the async call ------------
  const selectedText =
    kind === "native"
      ? el.value.slice(el.selectionStart, el.selectionEnd)
      : window.getSelection().toString();
  diag("selectedText len=" + selectedText.length);

  if (!selectedText.trim()) {
    showBox({ kind: "error", text: "Nothing selected." }, el);
    return;
  }

  const target = kind === "native"
    ? { kind: "native", el, start: el.selectionStart, end: el.selectionEnd }
    : { kind: "ce", el, range: window.getSelection().getRangeAt(0).cloneRange() };

  const anchorRect = caretRect();
  diag("anchorRect=" + (anchorRect ? JSON.stringify({l:anchorRect.left|0,t:anchorRect.top|0,b:anchorRect.bottom|0}) : "null"));

  // --- 3. show the loading indicator while the AI works -----------------
  diag("showBox loading");
  showBox({ kind: "loading", text: "Fixing…" }, null, anchorRect);

  let corrected;
  try {
    diag("sending MG_FIX…");
    const resp = await chrome.runtime.sendMessage({
      type: "MG_FIX",
      mode: "fix-grammar",
      text: selectedText,
    });
    diag("got response: " + (resp ? (resp.error ? "error=" + resp.error : "ok len=" + (resp.fixedText?.length || 0)) : "null"));
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
    diag("sendMessage threw: " + String(err?.message || err));
    hideBox();
    showBox(
      { kind: "error", text: truncate(String(err?.message || err)) },
      null,
      anchorRect
    );
    return;
  }

  // --- 4. clipboard copy (best-effort) + click-to-paste toast -----------
  let copied = false;
  try {
    await navigator.clipboard.writeText(corrected);
    copied = true;
    diag("clipboard wrote (immediate)");
  } catch (err) {
    diag("clipboard immediate write failed (will retry on Paste): " + String(err?.message || err));
  }

  diag("showBox done");
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
  diag("done");
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
  host.setAttribute("data-mygrammar", "ui-root");
  host.style.cssText = "all: initial; margin: 0; padding: 0;";
  const shadow = host.attachShadow({ mode: "open" }); // open so DevTools can inspect

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

function showBox(state, _el, anchorRect) {
  const { wrapper } = ensureShadow();
  wrapper.innerHTML = "";

  const box = document.createElement("div");
  box.className = "mygrammar-box";

  if (state.kind === "loading") {
    const spin = document.createElement("div");
    spin.className = "mygrammar-spinner";
    box.appendChild(spin);
    const t = document.createElement("div");
    t.className = "mygrammar-text";
    t.textContent = state.text;
    box.appendChild(t);
  } else if (state.kind === "error") {
    box.classList.add("mygrammar-err");
    const x = document.createElement("span");
    x.className = "mygrammar-check";
    x.textContent = "✕";
    box.appendChild(x);
    const t = document.createElement("div");
    t.className = "mygrammar-text";
    t.textContent = state.text;
    box.appendChild(t);
  } else if (state.kind === "done") {
    const c = document.createElement("span");
    c.className = "mygrammar-check";
    c.textContent = "✓";
    box.appendChild(c);
    const t = document.createElement("div");
    t.className = "mygrammar-text";
    t.textContent = state.text;
    box.appendChild(t);
    const btn = document.createElement("button");
    btn.className = "mygrammar-paste-btn";
    btn.type = "button";
    btn.textContent = "Paste";
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(state.corrected);
      } catch {
        /* best-effort */
      }
      applyPaste(state.target, state.corrected);
      hideBox();
    });
    box.appendChild(btn);
  }

  wrapper.appendChild(box);
  positionBox(box, anchorRect || caretRect());
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
  const boxHeight = 40;
  if (top + boxHeight > window.innerHeight) {
    top = Math.max(margin, rect.top - boxHeight - margin);
  }
  left = Math.min(
    Math.max(margin, left),
    window.innerWidth - box.offsetWidth - margin
  );
  box.style.left = left + "px";
  box.style.top = top + "px";
}

// --- helpers --------------------------------------------------------------

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

// --- FATAL ERROR TOAST (top-level catch) ----------------------------------

function showFatalToast(msg) {
  try {
    const div = document.createElement("div");
    div.textContent = "⚠ MyGrammar fatal: " + truncate(msg, 200);
    div.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
      "background:#b3261e;color:#fff;font:13px system-ui,sans-serif;" +
      "padding:10px 14px;box-shadow:0 2px 8px rgba(0,0,0,0.3);";
    document.documentElement.appendChild(div);
    setTimeout(() => div.remove(), 30000);
  } catch {
    /* nothing more we can do */
  }
}

// === DIAGNOSTIC TRACE PANEL ==============================================
// A fixed green panel top-right. Every diag() call appends a line. If you see
// this panel, the script IS injecting. The last line shown = the last step
// reached before the problem. If you DON'T see it, injection itself failed.

let diagPanel = null;
function ensureDiagPanel() {
  if (diagPanel && document.body.contains(diagPanel)) return diagPanel;
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:2147483647;" +
    "background:#064e3b;color:#a7f3d0;font:12px ui-monospace,Consolas,monospace;" +
    "padding:10px 12px;border-radius:6px;max-width:380px;max-height:60vh;" +
    "overflow:auto;box-shadow:0 4px 14px rgba(0,0,0,0.35);line-height:1.5;" +
    "border:1px solid #10b981;white-space:pre-wrap;";
  const title = document.createElement("div");
  title.textContent = "MyGrammar diagnostic trace v0.0.3-dbg";
  title.style.cssText = "font-weight:bold;margin-bottom:6px;border-bottom:1px solid #10b981;padding-bottom:4px;";
  wrap.appendChild(title);
  const body = document.createElement("div");
  body.id = "mygrammar-diag-body";
  wrap.appendChild(body);
  document.documentElement.appendChild(wrap);
  diagPanel = body;
  return body;
}
function diag(msg) {
  const body = ensureDiagPanel();
  const line = document.createElement("div");
  line.textContent = "• " + msg;
  line.style.borderTop = body.childNodes.length ? "1px dashed rgba(167,243,208,0.25)" : "none";
  line.style.paddingTop = body.childNodes.length ? "3px" : "0";
  body.appendChild(line);
  // also console.log so it's findable in page DevTools
  try { console.log("[MyGrammar]", msg); } catch {}
}
// Emit an immediate "injected" line so we can tell injection-vs-execution apart.
diag("injected @ " + new Date().toISOString().slice(11, 23) + " url=" + location.href);

// --- inlined toast CSS ----------------------------------------------------

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
