# TODO

## V2: Searchable Skill Index

V1 intentionally stays deterministic: it moves selected skills under `skill-index/skills`, generates a compact `skill-index/SKILL.md`, and relies on the agent to choose from the generated table.

A future v2 could borrow the shape of Chrome's Modern Web Guidance project: keep one small router skill in context, but make the CLI responsible for finding and retrieving the best hidden content.

## Why Improve V1

- Large skill sets can still make the generated table too long.
- Agents may choose the wrong skill from name and description alone.
- Users may want to query managed skills without moving files around again.
- The index skill can tell agents to call a CLI, but the CLI does not yet expose a retrieval workflow.

## Candidate V2 Commands

```sh
skillzero list --path .codex/skills
skillzero search "make a React form accessible" --path .codex/skills
skillzero retrieve accessibility --path .codex/skills
skillzero retrieve accessibility,react-best-practices --path .codex/skills
```

`search` should return compact JSON with skill IDs, descriptions, relative paths, and scores. `retrieve` should print the full nested `SKILL.md` content for one or more skill IDs.

## Implementation Path

1. Add `list` and `retrieve` first.
   These are deterministic, easy to test, and make the generated `skill-index/SKILL.md` more useful because it can instruct agents to retrieve the full skill by ID.

2. Add lexical search next.
   Start with a simple local BM25-style or weighted keyword search over skill name, description, frontmatter, headings, and tags. This avoids model packaging cost while solving most routing issues.

3. Add optional embedding search only if lexical search is not good enough.
   A transformer model can improve semantic matching for vague prompts, but it adds package size, cold-start latency, model update complexity, and more release machinery.

4. Generate a smaller index skill.
   Once `search` and `retrieve` exist, `skill-index/SKILL.md` can stop listing every skill in detail and instead instruct agents to run `skillzero search` first.

5. Add evals before making model search the default.
   Use fixture skill sets and realistic prompts to compare table-only, lexical search, and embedding search. Only promote embeddings if they clearly improve routing.

## Open Design Questions

- Should `search` operate only on managed skills, or on both active and managed skills?
- Should v2 store a generated search index on disk, or rebuild from `SKILL.md` files on every run?
- Should `retrieve` output raw skill content, structured JSON, or both via `--json`?
- Should embeddings be an optional install extra rather than part of the default package?
