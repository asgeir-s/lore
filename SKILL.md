---
name: note
description: "Use when you need to search, retrieve, and synthesize answers from the users personal knowledge base (QMD notes) via qmd tools."
---

# QMD — Notes Knowledge Base

Shared guidance for querying a user's personal notes with the `qmd` MCP tools.

## Collections

| Collection | Content                                                           | Authority                                    |
| ---------- | ----------------------------------------------------------------- | -------------------------------------------- |
| `pinned`   | Stable, deliberate positions: identity, voice, strategy, routines | **Authoritative** — always wins over `notes` |
| `notes`    | Journal entries, meeting notes, drafts, ideas, brain dumps        | Temporal context, not authoritative          |

**Rule:** Search `pinned` first for any question about current views, goals, or strategy. Use `notes` for history, context, and specifics.

---

## Standard Workflow

### 1. Two-pass search pattern

```
Pass 1 → collections: ["pinned"]   — get the canonical position
Pass 2 → all collections            — get supporting context / history
```

Only skip pass 1 when the query is clearly event-specific (for example, "what happened at yesterday's team meeting").

### 2. Get the full doc when needed

Search results return snippets. When a hit looks correct, use `qmd:get` to read the full document before answering. This is especially important for pinned docs.

---

## Query Tool: `qmd:query`

### Search types

| Type   | When to use                                        | How to write it                                   |
| ------ | -------------------------------------------------- | ------------------------------------------------- |
| `lex`  | You know exact names, terms, or identifiers        | 2-5 focused keywords, no filler                   |
| `vec`  | Conceptual questions (for example "position on X") | Full natural-language question                    |
| `hyde` | Nuanced, complex topics                            | 50-100 word passage similar to the desired answer |

**First search has 2x weight** — place your strongest signal first.

### Collection filtering

```json
{ "collections": ["pinned"] }         // pinned only
{ "collections": ["notes"] }          // notes only
                                       // omit -> searches both
```

### Combining types for best recall

```json
{
  "searches": [
    { "type": "lex", "query": "pricing strategy" },
    {
      "type": "vec",
      "query": "what is the user's current strategy for pricing"
    }
  ],
  "collections": ["pinned"],
  "limit": 5
}
```

### Intent disambiguation

Use `intent` when a keyword could map to multiple domains:

```json
{
  "searches": [{ "type": "lex", "query": "performance" }],
  "intent": "endurance training"
}
```

---

## Getting Documents: `qmd:get`

Retrieve by **file path** or **docid** (the `#abc123` hash from search results).

```json
{ "file": "pinned/20260223220130-about.md" }
{ "file": "#d46b88" }
{ "file": "notes/20260406103256-design-review.md", "maxLines": 30 }
```

Use `maxLines` to preview long docs before loading fully.

---

## Multi-get: `qmd:multi_get`

Retrieve multiple docs by **comma-separated paths** (glob patterns do not resolve):

```json
{
  "pattern": "pinned/20260223220130-about.md,pinned/20260223220339-voice.md"
}
```

---

## Practical Examples

**"What is the user's current view on X?"**

```json
Pass 1: { "collections": ["pinned"], "searches": [{ "type": "vec", "query": "what is the user's current view on X" }] }
Pass 2: { "searches": [{ "type": "lex", "query": "X" }, { "type": "vec", "query": "X context history" }] }
```

**"Do we have notes on the contract discussion?"**

```json
{
  "collections": ["notes"],
  "searches": [{ "type": "lex", "query": "contract discussion" }],
  "limit": 5
}
```

**"What is the current training plan?"**
-> Load directly with `qmd:get` when you already know the exact pinned doc.

**"What was discussed at the design review meeting?"**

```json
{
  "collections": ["notes"],
  "searches": [{ "type": "lex", "query": "design review meeting" }],
  "limit": 5
}
```

---

## Gotchas

- **Non-ASCII characters in `lex` queries** can occasionally cause internal errors or timeouts. If this happens, use `vec` or a simplified ASCII keyword.
- **`qmd:status` can be unreliable**. If it times out, query directly.
- **Glob patterns in `multi_get`** do not resolve against collection roots. Use exact comma-separated paths.
- **The MCP server may become unresponsive** after heavy use. If queries time out repeatedly, ask the user to restart QMD.
- **Search results are snippets**. For authoritative answers, follow up with `qmd:get` on the best match.
