# MyGrammar — Domain Glossary

> A Chrome MV3 extension that fixes grammar and adjusts tone of text in any web textbox, using the user's own OpenAI-compatible API key (BYOK). Serverless — no backend.

## Glossary

- **User** — The person who installed MyGrammar and configured their API settings.
- **BYOK (Bring Your Own Key)** — The user supplies their own API key for an OpenAI-compatible endpoint. MyGrammar stores no keys server-side; it is serverless.
- **Provider** — The OpenAI-compatible API endpoint the User configured (e.g. OpenAI, Groq, OpenRouter, local Ollama). Defined by three settings: Endpoint URL, API Key, Model name.
- **Mode** — A preset transformation applied to selected text. The fixed set: Fix grammar, Make professional, Make casual, Shorten. Each mode maps to a system prompt.
- **Fix** — The act of sending selected text to the Provider with the active Mode's prompt, receiving corrected text, and replacing the selection in-place.
- **Selection** — The text the User has highlighted in a text field, which becomes the input to a Fix.
- **Text field** — A writable DOM element: `<input>`, `<textarea>`, or `contenteditable` element.
- **Background service worker** — The isolated MV3 context that solely holds and uses the API Key. Content scripts never see the key.
- **Content script** — The MV3 context injected into web pages. Detects text fields, captures selections, injects corrected text, shows toasts. Never touches the API key.
- **Settings page** — The extension page (also serves as first-run onboarding) where the User configures Provider settings and default Mode.
- **Toast** — A transient inline notification shown on the page near the selection when a Fix fails or needs to communicate status.
