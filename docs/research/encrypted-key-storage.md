# Research: Encrypted API key storage in `chrome.storage.sync` (MV3)

**Status:** Findings (unblocks implementation)
**Issue:** [#3 — Research: Encrypted API key storage in chrome.storage.sync (MV3)](https://github.com/felixlix45/MyGrammar/issues/3)
**Scope:** MyGrammar — serverless Chrome MV3 extension, BYOK OpenAI-compatible API.
**Decision being researched:** The API key is stored **encrypted-at-rest** in `chrome.storage.sync`. Only the **background service worker** decrypts and uses it. Content scripts send "fix this text" messages to the background and never see the key.

> ⚠️ Read **§4 (Threat model)** before acting on this. The encryption here raises the bar against casual access; it does **not** make the key unextractable to a determined attacker who has the extension source + the user's machine. This is an honest, not magic, control.

---

## TL;DR recommendation for the MVP

- Store the API key **AES-GCM encrypted** in `chrome.storage.sync`.
- Derive the AES key with **PBKDF2** from a passphrase-equivalent input, using a **per-install random salt** stored alongside the ciphertext (salt is not secret).
- Generate a fresh **96-bit random IV per encryption** (`crypto.getRandomValues`); store it next to the ciphertext.
- All crypto via the **Web Crypto API (`crypto.subtle`)** — works in service workers, no native deps, no CSP surprises.
- Only the **background service worker** imports/derives the key and decrypts. Content scripts call the background via `chrome.runtime.sendMessage`; they receive corrected text back, never the key.
- **Honest ceiling:** defeats casual disk/browsing inspection and other extensions on the page. Does **not** defeat a determined attacker who can read the extension source (the key-derivation input is either hardcoded → recoverable, or user-entered → can be brute-forced if weak). See §4.

---

## 1. Encryption approach that works in a service worker

### 1.1 Use the Web Crypto API (`SubtleCrypto`) — yes, it works in MV3 service workers

The `crypto.subtle` interface (the `SubtleCrypto` interface) is available in **Web Workers**, and an MV3 background service worker is a worker context, so `crypto.subtle`, `crypto.getRandomValues`, and `crypto.randomUUID` are all available there without extra permissions.

- The Web Crypto API is "available in Web Workers" per MDN's note on each method page (e.g. the `encrypt()` page carries the note: *"This feature is available in Web Workers."*) —
  [MDN: SubtleCrypto.encrypt()](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt).
- `SubtleCrypto` exposes `importKey()`, `deriveKey()`, `encrypt()`, `decrypt()`, `digest()`, `wrapKey()`/`unwrapKey()`, and `getRandomValues` via the global `crypto` —
  [MDN: SubtleCrypto](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto).
- The whole API is **Promise-based** and operates on `ArrayBuffer`/`TypedArray`, which is exactly what an MV3 service worker can handle (no DOM needed).
- Caveat (important for MV3): SubtleCrypto methods are only available in a **secure context** (HTTPS / extension origin). Extension service workers run on the `chrome-extension://` origin, which is a secure context, so this is satisfied —
  [MDN: SubtleCrypto.encrypt() — Secure context](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt).
- **No `node:crypto`, no third-party crypto libs.** Web Crypto is the only correct choice here; bundling a JS crypto lib adds size and attack surface for no benefit.

### 1.2 Algorithm choice: AES-GCM (symmetric), key derived via PBKDF2

For "encrypt a short secret with a key I derive on the fly", the standard Web Crypto recipe is:

- **PBKDF2** to derive a key from keying material + salt →
  [MDN: SubtleCrypto.deriveKey()](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey), [MDN: Pbkdf2Params](https://developer.mozilla.org/en-US/docs/Web/API/Pbkdf2Params).
- **AES-GCM** for authenticated symmetric encryption →
  [MDN: SubtleCrypto.encrypt()](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt), [MDN: AesGcmParams](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams).

Why this pair:

- **AES-GCM** gives authenticated encryption (integrity + confidentiality), so tampered ciphertext fails to decrypt rather than silently producing garbage —
  [MDN: AesGcmParams](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams).
- **PBKDF2** is the Web Crypto KDF meant for low-entropy password input. Its whole point is to make brute force of a weak passphrase expensive via the `iterations` parameter, and it explicitly tolerates a non-secret `salt` —
  [MDN: Pbkdf2Params — salt](https://developer.mozilla.org/en-US/docs/Web/API/Pbkdf2Params) ("salt does not need to be kept secret").
- `hash` for PBKDF2 should be `SHA-256` or `SHA-384`/`SHA-512`; MDN advises moving off `SHA-1` —
  [MDN: Pbkdf2Params — hash](https://developer.mozilla.org/en-US/docs/Web/API/Pbkdf2Params).

### 1.3 Concrete API call sequence (background service worker)

```js
// ---- background service worker ----

// 1. Import the PBKDF2 "base key" from the keying material (passphrase or install secret).
//    keyingMaterial is an ArrayBuffer/Uint8Array of the raw bytes (use TextEncoder).
const baseKey = await crypto.subtle.importKey(
  "raw",                       // format
  keyingMaterial,              // raw bytes
  { name: "PBKDF2" },          // algorithm of the imported key
  false,                       // not extractable
  ["deriveKey"]                // usage
);

// 2. Derive an AES-GCM CryptoKey from baseKey + per-install salt + work factor.
//    Pbkdf2Params: { name:"PBKDF2", salt, iterations, hash }  — salt need NOT be secret.
//    Ref: https://developer.mozilla.org/en-US/docs/Web/API/Pbkdf2Params
const aesKey = await crypto.subtle.deriveKey(
  {
    name: "PBKDF2",
    salt: perInstallSalt,       // Uint8Array (>=16 bytes), stored alongside ciphertext
    iterations: 250_000,        // tune for ~hundreds of ms; raise over time
    hash: "SHA-256"
  },
  baseKey,
  { name: "AES-GCM", length: 256 },  // derived key type
  false,                       // not extractable — can't be exported out
  ["encrypt", "decrypt"]
);

// 3. Encrypt the API key. AesGcmParams: { name:"AES-GCM", iv, additionalData? }.
//    iv MUST be unique per encryption (96-bit/12-byte random recommended); not secret.
//    Ref: https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams
const iv = crypto.getRandomValues(new Uint8Array(12));      // 96-bit IV
const plaintext = new TextEncoder().encode(apiKey);         // API key string -> bytes
const ciphertext = await crypto.subtle.encrypt(
  { name: "AES-GCM", iv },
  aesKey,
  plaintext
);

// 4. Store { ciphertext, iv, salt, iterations } together in chrome.storage.sync.
//    All of iv/salt/iterations are NON-secret; only ciphertext is confidential.
await chrome.storage.sync.set({
  providerKey: {
    ct: base64(new Uint8Array(ciphertext)),
    iv: base64(iv),
    salt: base64(perInstallSalt),
    iter: 250_000
  }
});

// ---- to decrypt later (same worker) ----
const stored = (await chrome.storage.sync.get("providerKey")).providerKey;
const dk = await crypto.subtle.deriveKey(
  { name: "PBKDF2", salt: fromBase64(stored.salt), iterations: stored.iter, hash: "SHA-256" },
  baseKey,                                                    // re-import as above
  { name: "AES-GCM", length: 256 },
  false,
  ["decrypt"]
);
const plain = await crypto.subtle.decrypt(
  { name: "AES-GCM", iv: fromBase64(stored.iv) },
  dk,
  fromBase64(stored.ct)
);
const apiKey = new TextDecoder().decode(plain);
```

Notes on the sequence:

- `getRandomValues` for salt and IV lives on the global `crypto` object (same global that exposes `crypto.subtle`) and is available in workers.
- Mark keys `extractable: false` so they can never be exported via `exportKey` — defense in depth, not a real boundary if an attacker can run code in the worker.
- `base64()`/`fromBase64()` are trivial helpers; `chrome.storage` stores JSON, and `ArrayBuffer` is not JSON-serializable, so you must base64 ciphertext/iv/salt.

---

## 2. Where does the encryption key itself live? (honest options)

The hard part of "encrypted at rest" is **not** the cipher — it's where the *encryption key* comes from. There is no per-user OS keychain available to an MV3 extension the way there is for native apps. The realistic options:

### Option A — Hardcoded secret baked into the extension source
- Simplest. One constant string compiled into `background.js` used as PBKDF2 input.
- **Weak.** Extension source (including bundled/minified JS) is readable: `chrome://extensions` → "Inspect views", unpacked CRX, or the on-disk extension directory. Anyone who obtains the source has the KDF input; PBKDF2 only slows them, it doesn't stop them. Since the same constant ships to every install, one reverse-engineer recovers the key for *all* users.

### Option B — Per-install random salt + a passphrase the USER enters at onboarding *(recommended for MVP)*
- On first run, generate a random 16–32 byte salt (`crypto.getRandomValues`), store it in `chrome.storage.sync` (salt is non-secret per [MDN: Pbkdf2Params](https://developer.mozilla.org/en-US/docs/Web/API/Pbkdf2Params)).
- The user supplies a passphrase (or a secondary secret) used as PBKDF2 input. The passphrase is **never persisted**; it lives only in worker memory for the session, or the user re-enters it.
- Each install has a unique salt, so an attacker can't build one rainbow table for all users.
- **Honest ceiling:** protects the API key at rest against anyone who doesn't have the passphrase. If the passphrase is weak, PBKDF2 is the only thing slowing an offline brute force — so require/encourage a strong passphrase and use a high `iterations` count.

### Option C — Per-install random salt + a generated install secret stored in `chrome.storage.local`
- Like B, but the "passphrase" is a machine-generated random secret stored in `chrome.storage.local` (not synced).
- **Tradeoff:** removes user friction (no passphrase to type) because the worker can read the install secret on startup and derive the key. But anything stored in extension storage is readable from the same profile, so this protects against *sync* of the key across machines and against *casual* viewing, not against an attacker with profile access. It is essentially obfuscation with extra steps if the install secret lives in the same profile as the ciphertext.

### `chrome.storage.local` vs `chrome.storage.sync` vs `chrome.storage.session` — where to put what

| What to store | Area | Why |
|---|---|---|
| Ciphertext of API key, iv, salt, iterations | **`chrome.storage.sync`** (the architecture decision) | Syncs across the user's signed-in browsers; small (<200 bytes base64), well under quota (see §3). |
| Per-install passphrase secret (if Option C) | **`chrome.storage.local`** | Keeps the derivation secret off the sync pipe so syncing the ciphertext alone is useless; survives browser restarts. |
| Derived AES key, decrypted API key | **`chrome.storage.session`** / **worker memory only** | `chrome.storage.session` is in-memory-ish, not persisted to disk, and (unlike `local`/`sync`) not exposed to content scripts by default. Cache the decrypted key here or in a worker global for the session instead of re-deriving on every Fix. |

Sources for storage-area behavior: [chrome.storage API reference](https://developer.chrome.com/docs/extensions/reference/api/storage) (areas `local`/`session`/`sync` and their properties).

> **Practical best for the MVP:** Option **B** (per-install random salt + user passphrase, PBKDF2/SHA-256 ≥250k iterations, AES-GCM-256), ciphertext+iv+salt+iter in `chrome.storage.sync`, derived key and plaintext API key held only in `chrome.storage.session` / worker memory. If you must avoid any user friction, Option C is acceptable as long as you document that it is obfuscation, not a hard boundary (§4).

---

## 3. `chrome.storage.sync` quota and limits (feasibility check)

The encrypted blob is tiny (API key ~50–60 bytes; ciphertext ~76 bytes; iv 12 bytes; salt 16 bytes; iter number). The whole `providerKey` item is well under 1 KB. From the [chrome.storage reference](https://developer.chrome.com/docs/extensions/reference/api/storage#property-sync):

| Limit (`sync`) | Value | Impact |
|---|---|---|
| `QUOTA_BYTES` (total) | **102,400** bytes (~100 KB) | One small key blob: negligible. |
| `QUOTA_BYTES_PER_ITEM` | **8,192** bytes (~8 KB) | Ciphertext blob <1 KB: fine. |
| `MAX_ITEMS` | **512** | One item for the key: fine. |
| `MAX_WRITE_OPERATIONS_PER_HOUR` | **1,800** (≈1/2s) | Only written when the user changes the key — fine. |
| `MAX_WRITE_OPERATIONS_PER_MINUTE` | **120** | Same — fine. |

Citation: [chrome.storage — sync properties](https://developer.chrome.com/docs/extensions/reference/api/storage#property-sync). (Note: `MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE` is listed but deprecated — the sustained-write quota no longer exists.)

**Conclusion:** storage.sync is comfortable for an encrypted key. The write-rate limits are irrelevant because the key changes rarely.

---

## 4. The REAL threat model and security ceiling (honest assessment)

### What this design DOES protect against
1. **Casual local disk / profile browsing.** A user (or a low-skilled person with momentary device access) opening the extension's storage via DevTools or the profile folder sees ciphertext, not the API key.
2. **Other extensions / pages reading the key.** A content script runs in the **web page's** context, not the extension's; it cannot call `chrome.storage.*` at all. The decrypted key exists only in the service worker context, which pages and other extensions cannot reach directly.
3. **The key being accidentally logged or rendered.** It never reaches content-script or page JS, so a compromised page can't `console.log` or exfiltrate it the way it could if the key were passed down.
4. **Sync exposure of a strong secret (Option B/C).** With a per-install salt and a non-synced passphrase/secret, the ciphertext synced across the user's machines is useless without the salt partner or passphrase.

### What this design DOES NOT protect against (be honest)
1. **An attacker who can read the extension source AND run code.** If the key-derivation input is hardcoded (Option A), it is recoverable from the bundled source — the "encryption" is obfuscation. Even with a per-install salt (Option B/C), if the derivation secret lives in extension storage in the same profile, an attacker with profile access has both halves.
2. **Malware with native access on the user's machine.** Anything that can read the browser profile or inject into the service-worker context wins. No extension-side encryption defeats a local root-level attacker.
3. **A malicious/compromised content script on the page.** This is subtle and worth stating precisely:
   - A content script **cannot directly** read `chrome.storage` or the worker's memory — those APIs aren't exposed to the page context.
   - **But** a content script *can* send arbitrary `chrome.runtime.sendMessage` messages to the background. So the protection is only as good as the background's **authorization of those messages**. If the background exposes a "give me the decrypted API key" message handler, the content script (and hence a compromised page) can exfiltrate it. The defense is: the background must **never** return the key over messaging — only the *result* of a Fix. (See §5.)
   - This matches Chrome's own guidance that **content scripts are less trustworthy** than the extension's own pages, and that the extension should validate/never blindly trust content-script input — [Chrome: Message passing — Security considerations](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#security-considerations), [— Content scripts are less trustworthy](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#content-scripts-are-less-trustworthy).
4. **Weak passphrases (Option B).** If the user picks `password123`, PBKDF2 just delays offline brute force; it doesn't prevent it. The only real mitigation is enforcing a strong passphrase and a high iteration count.

### One-line ceiling statement
> Encrypting the key at rest in `chrome.storage.sync` raises the bar against **casual inspection and page-context leakage**, and correctly keeps the key out of content scripts. It is **not** a hard boundary against anyone who can read the extension source or the user's browser profile. For a BYOK MVP this is the right, proportionate control — document it as "obfuscation + isolation," not "secure storage."

---

## 5. Message-passing pattern: content script → background, key never leaks

Architecture: the content script captures the user's text selection and asks the background to fix it. The background (only context that can decrypt) does the API call and returns corrected text. The **key is never in any message**.

### 5.1 Content script (sender)

Uses `chrome.runtime.sendMessage` to send a one-time, JSON-serializable message and `await`s the response —
[Chrome: Message passing — One-time requests](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#simple).

```js
// content-script.js  — never imports/derives/holds the API key
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "MG_FIX_SELECTION") return;
  const text = window.getSelection().toString();        // or read the text field
  // Ask the background to fix it; we get back ONLY the corrected text.
  chrome.runtime.sendMessage(
    { type: "MG_FIX", text },
    (response) => {
      if (chrome.runtime.lastError) { showToast(chrome.runtime.lastError.message); return; }
      replaceSelectionWith(response.fixedText);          // inject corrected text
    }
  );
});
```

### 5.2 Background service worker (receiver + sole key holder)

Registers a `chrome.runtime.onMessage` listener. Because the work (decrypt + network) is async, it **returns `true`** to keep the `sendResponse` channel open, per Chrome's documented rule —
[Chrome: Message passing — Responses](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#responses),
[MDN: runtime.onMessage](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage).

```js
// background.js (service worker) — the ONLY place the key is decrypted
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "MG_FIX") return;            // ignore unrelated messages

  (async () => {
    try {
      const apiKey = await getDecryptedApiKey();     // PBKDF2->AES-GCM decrypt (see §1.3),
                                                     // cached in session storage/memory
      const fixed = await callProvider(apiKey, message.text);   // server-side never sees key
      sendResponse({ fixedText: fixed });            // return ONLY corrected text
    } catch (err) {
      sendResponse({ error: String(err?.message || err) });     // never leak the key in errors
    }
  })();

  return true;   // keep sendResponse alive for the async response (per Chrome docs)
});
```

### 5.3 Why the key can't leak through this channel

1. **The key is not in the request.** The content script sends only `{ type, text }`.
2. **The key is not in the response.** The background returns only `{ fixedText }` (or `{ error }`). There is no message that returns the key.
3. **Storage isn't reachable from the page.** `chrome.storage.*` is an extension API; a content script shares the page's DOM context for storage purposes but the *decrypted* key only ever lives in the worker / `chrome.storage.session`, neither of which the page can read. The content script could call `chrome.storage.sync.get` — which is exactly why **only ciphertext** is stored in sync, never plaintext.
4. **Authorize by message shape, not by trust.** The handler ignores anything that isn't `MG_FIX`. There is intentionally **no** handler that returns the key, so a malicious content script has no message to call. This is the operationalization of Chrome's "content scripts are less trustworthy" guidance —
   [Chrome: Security considerations](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#security-considerations).

### 5.4 Pitfall to avoid
- ❌ Don't add a `MG_GET_KEY` / `MG_DECRYPT` handler "for debugging" — that is the exfil path. If you need the key on an extension page (e.g. options page), have that page call the background to *test* the key, not to receive it.
- ❌ Don't put the key in error messages or stack traces you return to the content script.
- ✅ Do keep the decrypted key in `chrome.storage.session` (or a worker-scoped variable) rather than re-deriving and re-decrypting on every Fix — both for perf and to minimize the window it's in memory.

---

## 6. Open questions for implementation

1. **Passphrase UX (Option B).** Do we prompt for a passphrase at onboarding and re-prompt per browser session, or is one-time setup enough? Re-entering per session is more secure but adds friction. Needs a product call.
2. **Iteration count tuning.** 250,000 is a reasonable 2026 starting point for SHA-256 PBKDF2 (tens to low hundreds of ms on a service worker). Should be measured on target hardware and revisited periodically. Consider switching to `SHA-512` or a future Argon2 path if Web Crypto ever exposes it (it currently does not).
3. **Rotate salt on key change?** Recommended: regenerate salt + iv whenever the user re-enters the API key, so old ciphertext can't be correlated.
4. **Should the derived key be `extractable: false`?** Yes — defense in depth, even though it's not a hard boundary (§4).

---

## 7. Sources (all primary)

- Chrome Extensions — `chrome.storage` API reference (sync quota, areas, `set`/`get`, `session`):
  https://developer.chrome.com/docs/extensions/reference/api/storage
- Chrome Extensions — Message passing (one-time requests, async responses, security considerations, "content scripts are less trustworthy"):
  https://developer.chrome.com/docs/extensions/develop/concepts/messaging
- MDN — `SubtleCrypto` interface:
  https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto
- MDN — `SubtleCrypto.deriveKey()` (PBKDF2 → AES-GCM):
  https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey
- MDN — `SubtleCrypto.encrypt()` (AES-GCM, secure-context + Web Worker note):
  https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt
- MDN — `Pbkdf2Params` (name/hash/salt/iterations; salt need not be secret):
  https://developer.mozilla.org/en-US/docs/Web/API/Pbkdf2Params
- MDN — `AesGcmParams` (96-bit IV must be unique per encryption; IV not secret):
  https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams
- MDN — `runtime.onMessage` (async response via `return true`):
  https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage
