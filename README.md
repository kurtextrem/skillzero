# skillzero

`skillzero` keeps agent skill context small.

Agents see each installed skill's name and description before they decide which `SKILL.md` files to read. That works with a small skill set. It gets noisy when you install dozens of skills for rare tasks.

Use `skillzero` to split skills into two groups:

- top-level skills the agent should see at startup
- managed skills the agent can find through one `skill-index` skill

The CLI moves selected skills into `skill-index/skills/<name>`. It then writes a generated `skill-index/SKILL.md` with a compact table of those managed skills.

## Why

Skill descriptions cost tokens too. Even if your harness lazy loads skills, the `description` will make it into your agents context (needed so it can automatically invoke them).

Skill systems avoid loading every full `SKILL.md`, but they keep every name and description in the model context. A large skill library turns that metadata into background noise.

A better split: visible versus retrievable.

Keep your daily skills visible. Move rare skills behind an index. The agent keeps a path to them without carrying their metadata through every task.

## Good Uses

Use this for skills you want available but do not need on most tasks:

- Replay debugging skills
- spreadsheet and document tools
- one-off platform guidance
- migration guides
- niche framework rules
- experimental skills you are trying out

Keep a skill top-level when it should shape most work:

- repo coding rules
- accessibility rules for a frontend project
- the framework guidance you use every day
- project-specific review or test placement rules

## Mental Model

### Top-Level Skills

Top-level skills stay under a normal skills directory:

```txt
.codex/skills/accessibility/SKILL.md
.codex/skills/web-quality-audit/SKILL.md
```

The agent sees their names and descriptions at startup.

### Managed Skills

Managed skills move under the generated index skill:

```txt
.codex/skills/skill-index/skills/replay-playwright/SKILL.md
.codex/skills/skill-index/skills/spreadsheets/SKILL.md
```

The agent sees `skill-index`, then uses the generated table to decide which nested skill to read.

### Retrieved Skills

V1 uses a table. V2 should add CLI retrieval:

```sh
skillzero search "make a form accessible"
skillzero retrieve accessibility
```

V2 can make the index smaller. The agent searches first, then retrieves the full hidden skill when the task needs it.

## Install And Build

This project uses [Aube](https://aube.en.dev/).

```sh
aube install
aubr build
```

Run checks:

```sh
aubr typecheck
aube test
```

## Usage

Scan a skills directory:

```sh
node dist/index.js scan --path .codex/skills
```

Configure the skills that should stay behind the generated index:

```sh
node dist/index.js configure --path .codex/skills
```

Before using the upstream `skills` CLI, temporarily release the managed
folders. `manage` prepares the directory for any `skills` command; `update`
also runs `skills update` for you.

```sh
node dist/index.js manage --path .codex/skills
skills uninstall example-skill
node dist/index.js sync --path .codex/skills

# Or run the update shortcut, then sync when it completes.
node dist/index.js update --path .codex/skills
node dist/index.js sync --path .codex/skills
```

During the handoff, skillzero restores managed folders to the root and removes
the generated `skill-index/SKILL.md`, so the upstream CLI sees the ordinary
layout. It records the previous managed set in a generated handoff file.
`sync` uses that set as its default, keeps newly-added skills visible unless
you select them, and asks before forgetting skills removed while released.

Configuration:

1. Reads child folders with `SKILL.md`.
2. Reads managed skills from `skill-index/skills`.
3. Prompts you to choose managed skills.
4. Shows the folder moves.
5. Asks for confirmation.
6. Rewrites `skill-index/SKILL.md`.

## Example

Before:

```txt
.codex/skills/
  accessibility/
    SKILL.md
  replay-playwright/
    SKILL.md
  spreadsheets/
    SKILL.md
  web-quality-audit/
    SKILL.md
```

You use `accessibility` and `web-quality-audit` on most frontend work, so you leave them visible. You use `replay-playwright` for debugging sessions and `spreadsheets` for document tasks, so you move them into the index.

After:

```txt
.codex/skills/
  accessibility/
    SKILL.md
  web-quality-audit/
    SKILL.md
  skill-index/
    SKILL.md
    skills/
      replay-playwright/
        SKILL.md
      spreadsheets/
        SKILL.md
```

The agent now sees three top-level skills: `accessibility`, `web-quality-audit`, and `skill-index`.

## Principles

- Let the user choose.
  The CLI should show the skill set and let you decide what stays visible.

- Show file moves before applying them.
  Skill placement changes agent behavior. The CLI should preview each move and restore.

- Keep the index short.
  The index should route the agent to a skill. It should not become a second giant skill list.

- Start with deterministic behavior.
  V1 should scan files, move folders, and generate Markdown. Search can come after the file model feels right.

- Prefer retrieval over permanent context.
  Rare skills should stay available without spending tokens on every prompt.

- Write clear skill metadata.
  Skill names and descriptions decide routing quality. Vague descriptions hurt both agents and search.

## Known Limits

- V1 has no `search` or `retrieve` command.
- V1 reads `SKILL.md`, not `SKILLS.md`.
- V1 assumes agents ignore nested `SKILL.md` files under `skill-index/skills`.
- A huge managed set can make the generated table too long.

## V2 Direction

The next useful step is a retrieval CLI:

1. `skillzero list`
2. `skillzero retrieve <skill-id>`
3. `skillzero search <query>`

Start search with lexical ranking over skill names, descriptions, tags, headings, and body text. BM25 or a small weighted keyword scorer should handle many skill libraries because skill queries often include exact names, package names, tool names, and trigger words.

Add embeddings after real prompts show lexical search misses too much. Transformer search helps with fuzzy intent, but it adds model files, cold start, ranking complexity, and more release work.

A mature version can combine both:

- top-level skills for common behavior
- `skill-index` as the router
- lexical search for exact names and tool terms
- semantic search for vague prompts
- `retrieve` for the full hidden `SKILL.md`

See [TODO.md](./TODO.md) for the v2 notes.
