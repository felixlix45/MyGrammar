// PROTOTYPE options page logic.
// Implements #2's runtime host-permission request: when the user saves their
// endpoint, we request permission for exactly that origin (least privilege,
// no install-time broad-host warning). The optional_host_permissions entry in
// the manifest allows https://*/* and http://*/* to be granted at runtime.

const $ = (id) => document.getElementById(id);

async function load() {
  const { endpoint, apiKey, model } = await chrome.storage.local.get([
    "endpoint",
    "apiKey",
    "model",
  ]);
  $("endpoint").value = endpoint || "";
  $("apiKey").value = apiKey || "";
  $("model").value = model || "";
}

function originOf(url) {
  try {
    return new URL(url.trim()).origin + "/*";
  } catch {
    return null;
  }
}

async function ensureHostPermission(endpointUrl) {
  const origin = originOf(endpointUrl);
  if (!origin) throw new Error("Endpoint is not a valid URL.");
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted)
    throw new Error(
      "Host permission declined. The extension cannot reach the endpoint without it."
    );
  return origin;
}

function setStatus(text, kind) {
  const s = $("status");
  s.textContent = text;
  s.className = kind || "";
}

$("save").addEventListener("click", async () => {
  try {
    const endpoint = $("endpoint").value.trim();
    const apiKey = $("apiKey").value.trim();
    const model = $("model").value.trim();
    if (!endpoint || !apiKey || !model) {
      setStatus("All three fields are required.", "err");
      return;
    }
    await ensureHostPermission(endpoint);
    await chrome.storage.local.set({ endpoint, apiKey, model });
    setStatus("Saved.", "ok");
  } catch (err) {
    setStatus(String(err?.message || err), "err");
  }
});

$("test").addEventListener("click", async () => {
  setStatus("Testing…");
  try {
    const { endpoint, apiKey, model } = await chrome.storage.local.get([
      "endpoint",
      "apiKey",
      "model",
    ]);
    if (!endpoint || !apiKey || !model)
      throw new Error("Save endpoint, key, and model first.");
    // Make sure the origin is permitted (request if not).
    const has = await chrome.permissions.contains({
      origins: [originOf(endpoint)],
    });
    if (!has) await ensureHostPermission(endpoint);

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
          { role: "system", content: "Reply with the single word OK." },
          { role: "user", content: "ping" },
        ],
        temperature: 0,
        max_tokens: 5,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = await resp.json();
    const reply = data?.choices?.[0]?.message?.content;
    setStatus(`OK — provider replied: "${String(reply).slice(0, 40)}"`, "ok");
  } catch (err) {
    setStatus(String(err?.message || err), "err");
  }
});

load();
