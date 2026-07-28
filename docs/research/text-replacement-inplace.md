# Research: Replace selected text in-place across input types (MV3)

> **Scope:** How the MyGrammar content script replaces the user's selected text in-place after the Provider returns corrected text. Covers `<input>`, `<textarea>`, and `contenteditable`, plus the React-controlled-input quirk and edge cases.
>
> **Issue:** [felixlix45/MyGrammar#4](https://github.com/felixlix45/MyGrammar/issues/4)
> **Status:** Research — implementation decisions deferred to a future ADR.
> **Last reviewed:** 2026-07-28

---

## TL;DR decision matrix

| Element type | Detect | Read selection | Replace | Restore caret |
|---|---|---|---|---|
| `<input>` / `<textarea>` | `instanceof HTMLInputElement` / `HTMLTextAreaElement` | `selectionStart`, `selectionEnd` | `setRangeText(replacement)` (preferred) or `value` slice + `setSelectionRange` | `selectMode` arg of `setRangeText`, or `setSelectionRange(pos, pos)` |
| `contenteditable` (any element) | `el.isContentEditable === true` | `window.getSelection()` → `getRangeAt(0)` | `Range.deleteContents()` + `Range.insertNode(document.createTextNode(text))`; or `document.execCommand('insertText', false, text)` to preserve undo | Re-`select`/collapse a `Range` and `Selection.removeAllRanges()` + `addRange()` |
| React-controlled `<input>`/`<textarea>` | Same as native (React doesn't change the DOM type) | Same as native | Use the **native value setter** trick + dispatch `input` event (see §4) | Same as native |

---

## 1. Detecting the selection and its element

### 1a. Two completely different APIs

The web platform has **two independent selection models**, and the correct one depends on the element type:

- **Native form controls** (`<input>`, `<textarea>`) expose their selection as integer offsets via `selectionStart` / `selectionEnd`. They do **not** participate in the `Selection` API — `window.getSelection()` returns an empty/collapsed selection when the focus is inside a native control. ([MDN: Selection — Notes](https://developer.mozilla.org/en-US/docs/Web/API/Selection#notes))
- **`contenteditable` elements** (and `designMode` documents) are edited via the DOM and the `Selection` / `Range` API. `window.getSelection()` returns the live selection; `getRangeAt(0)` gives a `Range` you can mutate. ([MDN: Window: getSelection()](https://developer.mozilla.org/en-US/docs/Web/API/Window/getSelection), [MDN: Selection](https://developer.mozilla.org/en-US/docs/Web/API/Selection))

### 1b. Which element is the user in?

`document.activeElement` returns the element currently receiving keyboard input — "usually analogous to the focused element." ([MDN: Document.activeElement](https://developer.mozilla.org/en-US/docs/Web/API/Document/activeElement))

> ⚠️ **Caveat for contenteditable:** `activeElement` returns the **editing host** (the element with `contenteditable`), but for native inputs it returns the input itself. For deeply nested editable trees, you may need to walk into Shadow DOM or iframes (see §5).

### 1c. Branching on type

```js
const el = document.activeElement;

if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
  // native control path
} else if (el && el.isContentEditable) {
  // contenteditable path
}
```

- `isContentEditable` is the reliable, computed check for editable regions — it's `true` for the element and all its descendants when `contenteditable` is in effect. ([MDN: HTMLElement.isContentEditable](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/isContentEditable))
- `instanceof` is preferable to `el.tagName === 'INPUT'` because it also rejects subclasses/odd cases and reads clearly. Note `HTMLInputElement` covers all `<input>` types; you must additionally filter out non-text types (see §5).

### 1d. Reading the selected text

```js
// Native control
const start = el.selectionStart;
const end   = el.selectionEnd;
const selected = el.value.slice(start, end);
const hasSelection = start !== end;
```

`selectionStart` and `selectionEnd` are 0-based character offsets; when equal, the caret is collapsed and there is no selection. ([MDN: HTMLInputElement](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement), [MDN: HTMLTextAreaElement](https://developer.mozilla.org/en-US/docs/Web/API/HTMLTextAreaElement))

```js
// contenteditable
const sel = window.getSelection();
if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
  const range = sel.getRangeAt(0);
  const selected = sel.toString();
}
```

`Selection.type` is a convenient discriminator: `"None"`, `"Caret"`, or `"Range"`. Only `"Range"` means real selected text. ([MDN: Selection.type](https://developer.mozilla.org/en-US/docs/Web/API/Selection/type))

---

## 2. Replacing the selected portion

### 2a. `<input>` / `<textarea>` — use `setRangeText()`

`HTMLInputElement.setRangeText()` and `HTMLTextAreaElement.setRangeText()` "replaces a range of text … with a new string." When called with one argument, `start`/`end` default to the current `selectionStart`/`selectionEnd`, so it operates exactly on the user's selection. ([MDN: HTMLInputElement.setRangeText](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/setRangeText), [MDN: HTMLTextAreaElement.setRangeText](https://developer.mozilla.org/en-US/docs/Web/API/HTMLTextAreaElement/setRangeText))

Signature (per [WHATWG HTML §dom-textarea/input-setrangetext-dev](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#dom-textarea/input-setrangetext-dev)):

```js
setRangeText(replacement)
setRangeText(replacement, start)
setRangeText(replacement, start, end)
setRangeText(replacement, start, end, selectionMode)
```

`selectionMode` controls where the caret lands afterwards: `"select"` (highlight new text), `"start"`, `"end"`, or `"preserve"` (default). This is also how you restore the caret (see §3).

Recommended usage for MyGrammar — replace the current selection and place the caret right after the inserted text:

```js
el.focus();
el.setRangeText(corrected, el.selectionStart, el.selectionEnd, 'end');
```

**Compatibility:** Full support since Chrome 24 / Firefox 27 / Safari 7. Baseline-widely-available since Jan 2020. ([MDN compat table](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/setRangeText#browser_compatibility))

### 2b. Manual slice alternative (when you also need to dispatch a synthetic event — see §4)

```js
const start = el.selectionStart;
const end   = el.selectionEnd;
const newValue = el.value.slice(0, start) + corrected + el.value.slice(end);
// set newValue via the React-safe setter (§4), then:
el.setSelectionRange(start + corrected.length, start + corrected.length);
```

`setSelectionRange()` is the explicit caret-positioning API for native controls. ([MDN: HTMLInputElement.setSelectionRange](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/setSelectionRange))

### 2c. `contenteditable` — `Range.deleteContents()` + `Range.insertNode()`

The standard, non-deprecated path:

1. Get the `Range` for the current selection.
2. `Range.deleteContents()` removes the selected nodes; "afterwards, the range is collapsed to the end of the last selected node." ([MDN: Range.deleteContents](https://developer.mozilla.org/en-US/docs/Web/API/Range/deleteContents), [DOM §dom-range-deletecontents](https://dom.spec.whatwg.org/#dom-range-deletecontents))
3. `Range.insertNode(newNode)` inserts a node "at the start boundary point of the `Range`." For text, pass a `Text` node. ([MDN: Range.insertNode](https://developer.mozilla.org/en-US/docs/Web/API/Range/insertNode), [DOM §dom-range-insertnode](https://dom.spec.whatwg.org/#dom-range-insertnode))

```js
const sel = window.getSelection();
if (!sel || sel.rangeCount === 0) return;
const range = sel.getRangeAt(0);
range.deleteContents();
const textNode = document.createTextNode(corrected);
range.insertNode(textNode);

// Merge adjacent text nodes so the caret can sit cleanly
textNode.parentNode.normalize();

// Place caret after the inserted text
const newRange = document.createRange();
newRange.setStartAfter(textNode);
newRange.collapse(true);
sel.removeAllRanges();
sel.addRange(newRange);
```

**Pitfall — `insertNode` can split text nodes**, leaving the inserted text in its own node. Calling `Node.normalize()` afterwards merges adjacent `Text` nodes so subsequent edits and caret motion behave. ([MDN: Node.normalize](https://developer.mozilla.org/en-US/docs/Web/API/Node/normalize))

### 2d. `contenteditable` — `document.execCommand('insertText')` (deprecated but undo-safe)

```js
document.execCommand('insertText', false, corrected);
```

**Status:** `execCommand` is formally **deprecated** and **non-standard**, but MDN notes: "Although the `execCommand()` method is deprecated, there are still some valid use cases that do not yet have viable alternatives. For example, unlike direct DOM manipulation, modifications performed by `execCommand()` preserve the undo buffer (edit history)." ([MDN: Document.execCommand](https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand))

**Why it matters for a grammar tool:** `deleteContents()`+`insertNode()` does **not** create an undo history entry in most browsers — pressing Ctrl+Z after a Fix would skip the fix and undo the user's previous keystroke. `execCommand('insertText')` does integrate with the editor's undo stack, so the user can undo just the fix.

**What is the modern alternative?** The intended replacement is dispatching a `beforeinput` event of `inputType === 'insertText'` (the [Input Events](https://w3c.github.io/input-events/) spec), but browser support for driving edits *through* synthetic `beforeinput` is incomplete and inconsistent. As of 2026 there is **no clean, widely-supported, undo-preserving standard replacement**. Pragmatic recommendation:

- **Try `execCommand('insertText')` first** (preserves undo, works in all current browsers).
- **Fall back to `deleteContents()` + `insertNode()`** if `execCommand` returns `false` or is unavailable.
- Revisit when the [beforeinput/insertText path](https://w3c.github.io/input-events/) gains traction; do not assume this is permanent.

### 2e. Dispatching the right event so the page notices

After mutating a native control, the page (or its framework) will not see the change unless you dispatch an `input` event yourself. Critically, **the `input` event is not fired when JavaScript changes an element's `value` programmatically** — you must dispatch it manually. ([MDN: Element: input event](https://developer.mozilla.org/en-US/docs/Web/API/Element/input_event))

```js
el.dispatchEvent(new Event('input', { bubbles: true }));
```

For React specifically, more is required — see §4.

---

## 3. Restoring the caret / selection

### 3a. Native controls

Two equivalent options:

- **Via `setRangeText`'s 4th argument** (`selectionMode`): pass `"end"` to put the caret right after the inserted text, `"select"` to highlight the new text, `"start"` to put the caret before it. ([MDN: HTMLInputElement.setRangeText — Parameters](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/setRangeText#parameters))
- **Via `setSelectionRange(pos, pos)`** after a manual slice: collapses the caret to a single offset. ([MDN: HTMLInputElement.setSelectionRange](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/setSelectionRange))

For MyGrammar the natural choice is `"end"` — the caret lands after the corrected text so the user keeps typing where they expected.

### 3b. `contenteditable`

Build a fresh `Range`, collapse it, and apply it via the `Selection` API:

```js
const newRange = document.createRange();
newRange.setStartAfter(insertedNode);   // or setStart(textNode, offset)
newRange.collapse(true);
sel.removeAllRanges();
sel.addRange(newRange);
```

`Selection.removeAllRanges()` then `addRange()` is the standard way to move the caret in editable regions. ([MDN: Selection](https://developer.mozilla.org/en-US/docs/Web/API/Selection))

---

## 4. The React-controlled-input quirk

### 4a. The problem

A **controlled input** in React has its `value` prop driven by component state:

```jsx
<input value={state} onChange={e => setState(e.target.value)} />
```

Per the React docs: "When you pass [`value`], you must also pass an `onChange` handler that updates the passed value." ([React docs: `<input>` — Controlling an input](https://react.dev/reference/react-dom/components/input#controlling-an-input-with-a-state-variable))

The consequence for an extension that sets `.value` directly:

- You write `el.value = corrected;` — the DOM updates momentarily.
- But React keeps an internal tracker of the input's "last known value." On the next render it compares the node's current `.value` against that tracker, sees they're "equal" (the tracker still holds the old value), and **silently reverts** the node to the old value. Your change does not stick.

This is by design — it's how React guarantees the input reflects state. Setting `.value` directly looks like a no-op from React's perspective.

### 4b. The workaround — call the native setter, then dispatch `input`

React attaches its own value setter at the `HTMLInputElement.prototype` / `HTMLTextAreaElement.prototype` level. To bypass React's tracker, grab the **native** (prototype) setter via `Object.getOwnPropertyDescriptor` and invoke it directly on the node:

```js
function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  nativeSetter.call(el, value);
}

function applyReactSafe(el, corrected) {
  const start = el.selectionStart;
  const end   = el.selectionEnd;
  const next  = el.value.slice(0, start) + corrected + el.value.slice(end);

  setNativeValue(el, next);
  el.dispatchEvent(new Event('input', { bubbles: true }));

  // Restore caret after the inserted text
  const caret = start + corrected.length;
  el.setSelectionRange(caret, caret);
}
```

Then dispatch an `input` event so React's synthetic event system picks it up and runs the component's `onChange`. This is the **canonical, widely-cited workaround** for programmatically updating React-controlled inputs (originally documented for React ≥ 15.6, when React moved to the prototype-level tracker; see [the React team's guidance on triggering input updates](https://stackoverflow.com/questions/23892547/what-is-the-best-way-to-trigger-change-or-input-event-in-react-js) and Cory Rylan's writeup: [Trigger Input Updates with React Controlled Inputs](https://coryrylan.com/blog/trigger-input-updates-with-react-controlled-inputs)).

**Why `input` and not `change`?** React listens for the native `input` event to fire `onChange` for text controls. (`change` in React maps to the native `input` for these elements — dispatching a native `input` is the reliable choice.) The event **must** be `bubbles: true`, because React listens at the document/root level. ([MDN: Element: input event](https://developer.mozilla.org/en-US/docs/Web/API/Element/input_event))

### 4c. Should we always use the native-setter path?

Yes — it's safe for non-React pages too. `setRangeText()` mutates `.value` via React's *intercepted* setter, so on React-controlled inputs the change is silently reverted on re-render. The native-setter path is **required whenever the page might be React**. Since MyGrammar runs on arbitrary pages, default to the React-safe slice + native-setter + `input`-event approach for native controls, and reserve plain `setRangeText()` for cases where you've confirmed React is absent (e.g. an explicit opt-in). A defensive implementation:

```js
function replaceInNativeControl(el, corrected) {
  const start = el.selectionStart;
  const end   = el.selectionEnd;
  const next  = el.value.slice(0, start) + corrected + el.value.slice(end);
  setNativeValue(el, next);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.setSelectionRange(start + corrected.length, start + corrected.length);
}
```

> 📝 **This is a strong candidate for an ADR** (per `docs/agents/domain.md`). The decision — "always use the native-setter path for native controls" — is hard to reverse (it's baked into the content script), surprising without context (why not just `setRangeText`?), and the result of a real trade-off (simplicity vs. React compatibility). Recommend filing `docs/adr/000X-use-native-setter-for-controlled-inputs.md`.

### 4d. `contenteditable` + React (e.g. Draft.js, Lexical, Slate)

Rich-text editors built on `contenteditable` maintain their **own** model (not `.value`) and generally re-render the DOM from that model after every event. For these:

- `execCommand('insertText')` usually works because these editors listen for `beforeinput`/`input` and update their model from the DOM mutation.
- Raw `deleteContents()` + `insertNode()` may be **immediately overwritten** when the editor re-syncs its model to the DOM.
- For full robustness, MyGrammar should treat major rich-text editors as a follow-up concern; v1 can ship `execCommand('insertText')` and accept that some editors will misbehave.

---

## 5. Edge cases

### 5a. Read-only / disabled fields

Check before writing:

```js
if (el.readOnly || el.disabled) {
  // show toast: "Can't edit a read-only/disabled field"; abort
}
```

Both `readOnly` and `disabled` are defined on `HTMLInputElement` / `HTMLTextAreaElement`. For `contenteditable`, check `el.isContentEditable` (it will be `false` if the host set `contenteditable="false"`).

### 5b. No selection — what to do?

The MyGrammar glossary defines a **Fix** as operating on the **Selection** ("the text the User has highlighted"). When there is no selection (`selectionStart === selectionEnd`, or `Selection.type === "Caret"`/`"None"`), options:

1. **Strict (recommended for v1):** require a selection; if none, show a toast ("Select some text first"). This matches the glossary and avoids surprising edits.
2. **Lenient fallback (possible future):** operate on the **whole field value**. For native controls, replace `el.value` entirely; for `contenteditable`, use the host's `textContent`. Only do this behind an explicit setting, since it changes far more text than the user may expect.

([MDN: Selection.type](https://developer.mozilla.org/en-US/docs/Web/API/Selection/type) for the `"Caret"` vs `"Range"` distinction.)

### 5c. Cross-iframe selections

`document.activeElement` "returns the deepest `Element` which currently has focus," but **if the focused element is inside an `iframe`, `activeElement` on the parent document returns the `<iframe>` element itself, not the element inside it.** ([MDN: Document.activeElement — Value](https://developer.mozilla.org/en-US/docs/Web/API/Document/activeElement#value))

Likewise, `window.getSelection()` is **per-`document`** — a selection inside an iframe is invisible to the parent window's `getSelection()`. ([MDN: Window: getSelection()](https://developer.mozilla.org/en-US/docs/Web/API/Window/getSelection))

For MyGrammar's MV3 content script:

- If the manifest declares `"all_frames": true`, the content script is injected into every frame and each instance handles its own selection — **preferred**.
- If not, you must recurse into `document.querySelectorAll('iframe')`, access `iframe.contentDocument` (same-origin only — cross-origin iframes throw `SecurityError` on `.contentDocument` access), and check `contentDocument.activeElement` / `contentWindow.getSelection()` there.
- Cross-origin iframes are unreachable from the parent; only an `all_frames: true` injection can fix text inside them.

### 5d. `<input type="file">` and `<input type="password">`

- **`type="file"`** — has no text `value` to edit (the `value` is a read-only filename). Must **skip entirely.**
- **`type="password"`** — technically editable, but grammar-fixing a masked password is almost never what the user wants, exposes the password to the Provider, and is a privacy footgun. Must **skip by default.**
- Also consider skipping `type="hidden"`, `type="checkbox"`, `type="radio"`, `type="range"`, `type="color"`, `type="submit"`/`button`/`image`/`reset` — none contain user-editable prose.

Recommended allowlist for native `<input>`:

```js
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel']);
function isEditableTextInput(el) {
  return el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type);
}
```

`<textarea>` is always prose; no type filter needed.

### 5e. Shadow DOM

If `activeElement` is a ShadowRoot host, the real focus is inside its shadow tree; you must descend via `shadowRoot.activeElement` (recursively, for nested shadow roots). ([MDN: Document.activeElement](https://developer.mozilla.org/en-US/docs/Web/API/Document/activeElement) — "If the focused element is within a shadow tree … this will be the root element of that tree.")

```js
function deepActiveElement(doc) {
  let el = doc.activeElement;
  while (el && el.shadowRoot) {
    el = el.shadowRoot.activeElement;
  }
  return el;
}
```

### 5f. Number inputs and IME composition

- `<input type="number">`: `.value` is a string but `selectionStart`/`selectionEnd` throw or behave oddly in some browsers; treat as non-prose (skip).
- **IME (CJK, etc.) composition in progress:** mutating `.value` while the user is mid-composition corrupts the composition. Check `CompositionEvent` / `document.activeElement` state; if a composition is active, defer the Fix until it ends. (Lower priority for v1.)

---

## 6. Recommended implementation skeleton (v1)

```js
// content-script: replaceSelection(corrected)
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel']);

function deepActiveElement(doc = document) {
  let el = doc.activeElement;
  while (el && el.shadowRoot) el = el.shadowRoot.activeElement;
  return el;
}

function isWritableNative(el) {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
  }
  return false;
}

function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
}

export function replaceSelection(corrected) {
  const el = deepActiveElement();

  // 1. Native control (React-safe path)
  if (isWritableNative(el)) {
    const { selectionStart: s, selectionEnd: e } = el;
    if (s === e) return { ok: false, reason: 'no-selection' };
    const next = el.value.slice(0, s) + corrected + el.value.slice(e);
    setNativeValue(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const caret = s + corrected.length;
    el.setSelectionRange(caret, caret);
    return { ok: true };
  }

  // 2. contenteditable
  if (el && el.isContentEditable) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      return { ok: false, reason: 'no-selection' };
    }
    // Prefer execCommand for undo-stack integration; fall back to Range API.
    if (document.execCommand('insertText', false, corrected)) {
      return { ok: true };
    }
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
    return { ok: true };
  }

  return { ok: false, reason: 'no-editable-target' };
}
```

---

## 7. Open questions for follow-up

1. **Undo support on native controls** — `setRangeText` and the native-setter path don't integrate with the browser's native undo for inputs the way `execCommand('insertText')` does for `contenteditable`. Is acceptable undo behavior for native inputs a v1 requirement? (Likely follow-up issue.)
2. **Major rich-text editors** (Lexical, Slate, Draft.js, ProseMirror, Quill, TinyMCE, CKEditor) — each has its own model. Confirm `execCommand('insertText')` is good enough for the common ones, or build per-editor adapters.
3. **`beforeinput`-based insertion** as a forward path for `contenteditable` once browser support for driving edits via synthetic `beforeinput` of `inputType 'insertText'` matures. Track [W3C Input Events](https://w3c.github.io/input-events/).
4. **ADR:** file `docs/adr/000X-use-native-setter-for-controlled-inputs.md` capturing the §4 decision.

---

## References (primary sources)

- [WHATWG HTML — `dom-textarea/input-setrangetext-dev`](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#dom-textarea/input-setrangetext-dev)
- [MDN — `HTMLInputElement.setRangeText()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/setRangeText)
- [MDN — `HTMLTextAreaElement.setRangeText()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLTextAreaElement/setRangeText)
- [MDN — `HTMLInputElement.setSelectionRange()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/setSelectionRange)
- [MDN — `HTMLInputElement`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement) / [`HTMLTextAreaElement`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLTextAreaElement)
- [MDN — `Document.activeElement`](https://developer.mozilla.org/en-US/docs/Web/API/Document/activeElement)
- [MDN — `HTMLElement.isContentEditable`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/isContentEditable)
- [MDN — `Window.getSelection()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/getSelection)
- [MDN — `Selection`](https://developer.mozilla.org/en-US/docs/Web/API/Selection) / [`Selection.type`](https://developer.mozilla.org/en-US/docs/Web/API/Selection/type)
- [WHATWG DOM — `dom-range-deletecontents`](https://dom.spec.whatwg.org/#dom-range-deletecontents) / [`dom-range-insertnode`](https://dom.spec.whatwg.org/#dom-range-insertnode)
- [MDN — `Range.deleteContents()`](https://developer.mozilla.org/en-US/docs/Web/API/Range/deleteContents) / [`Range.insertNode()`](https://developer.mozilla.org/en-US/docs/Web/API/Range/insertNode)
- [MDN — `Node.normalize()`](https://developer.mozilla.org/en-US/docs/Web/API/Node/normalize)
- [MDN — `Document.execCommand()` (deprecated)](https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand)
- [MDN — `Element: input event`](https://developer.mozilla.org/en-US/docs/Web/API/Element/input_event)
- [W3C Input Events](https://w3c.github.io/input-events/)
- [React docs — `<input>` (controlled components)](https://react.dev/reference/react-dom/components/input)
- [Stack Overflow — triggering `input`/`change` in React (canonical Q&A, React ≥ 15.6 native-setter workaround)](https://stackoverflow.com/questions/23892547/what-is-the-best-way-to-trigger-change-or-input-event-in-react-js)
- [Cory Rylan — Trigger Input Updates with React Controlled Inputs](https://coryrylan.com/blog/trigger-input-updates-with-react-controlled-inputs)
