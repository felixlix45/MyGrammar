# Domain Docs

**Layout:** Single-context.

- `CONTEXT.md` at the repo root — the domain glossary (ubiquitous language).
- `docs/adr/` — Architectural Decision Records, numbered (`0001-...`).

## Consumer rules

When working in this repo:

1. Read `CONTEXT.md` for the canonical meaning of terms. Terms used in code, issues, and discussion should match the glossary.
2. Check `docs/adr/` for decisions that explain *why* the code is the way it is. Each ADR is numbered and titled.
3. If you resolve a new architectural decision that is hard to reverse, surprising without context, and the result of a real trade-off, propose an ADR.
4. `CONTEXT.md` is a glossary only — no implementation details, no specs, no scratch notes.
