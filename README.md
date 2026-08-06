# skillzero

`skillzero` keeps agent skill context small.

Nowadays agents see each installed skill's name and description instead of loading the full `SKILL.md`. That is cheap with a tiny amount of skills, but 100 x "name + 1-2 sentences" is still a lot of potentially wasted tokens.

`skillzero` solves that by allowing you to split skills into two groups:

- top-level skills the agent should see at startup
- managed skills the agent can find through one `skill-index` skill

That way rarely used skills completely avoid polluting your context, but are still retrievable (invokable by you) if needed.

## How

Choose a harness layout when configuring a skills root:

| Target flags | Layout | What skillzero changes |
| --- | --- | --- |
| `--claude`, `--cursor` | In place | Adds `disable-model-invocation: true` to selected skills and writes the index. |
| `--codex`, `--copilot`, `--gemini` (or no target flag) | Move based | Moves selected skills into `skill-index/skills/<name>` and writes the index. |

For both layouts, `skill-index/SKILL.md` is a small router table. Claude Code and Cursor document that `disable-model-invocation: true` keeps a selected skill out of model-driven invocation until the user explicitly invokes it. The field is not part of the Agent Skills specification, so Codex, Copilot, and Gemini use the portable move-based layout here.

Most installations put skills under `.agents/skills`, which several harnesses read. The target flag therefore chooses one layout for that shared directory—not an independent configuration for each harness. In-place metadata affects every compatible harness that reads the root; moved folders affect every harness that scans it.

## Good Uses

Use this for skills you want available but do not need on most tasks:

- spreadsheet and document tools (for example Codex adds those by default!)
- one-off platform guidance
- migration guides
- niche framework rules
- experimental skills you are trying out
- skills that work like commands (you only invoke manually 99% of the time)

Keep a skill top-level when you use it frequently:

- repo coding rules
- accessibility rules for a frontend project
- the framework guidance you use every day
- project-specific review or test placement rules

## Mental Model

### Top-Level Skills

Top-level skills stay under a normal skills directory, commonly `.agents/skills`:

```txt
.agents/skills/accessibility/SKILL.md
.agents/skills/web-quality-audit/SKILL.md
```

The agent sees their names and descriptions at startup.

### In-Place Manual-Only Skills

Claude and Cursor keep selected skill folders where the upstream `skills` CLI expects them:

```txt
.agents/skills/replay-playwright/SKILL.md  # disable-model-invocation: true
.agents/skills/spreadsheets/SKILL.md       # disable-model-invocation: true
.agents/skills/skill-index/SKILL.md
```

`skillzero` keeps a hidden root-level manifest for fields it wrote. After an
upstream update, `sync` restores the field only when the current skill does not
already declare it itself. This preserves an upstream or user-owned policy.

### Move-Based Managed Skills

Codex and Copilot use folders nested under the generated index skill:

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

Or discover the relevant roots within one project. `scan` without a target
lists every supported project root; a mutating command requires a target so it
only changes directories that target actually reads.

```sh
node dist/index.js scan --project .
node dist/index.js manage --project . --codex
node dist/index.js sync --project . --codex
```

| Target | Project skill roots discovered by `--project` |
| --- | --- |
| `--claude` | `.agents/skills`, `.claude/skills` |
| `--cursor` | `.agents/skills`, `.cursor/skills` |
| `--codex` | `.agents/skills`, `.codex/skills` |
| `--copilot` | `.agents/skills`, `.claude/skills`, `.github/skills` |
| `--gemini` | `.agents/skills`, `.gemini/skills` |

Discovery does not search personal directories such as `~/.agents/skills` on
its own. Use `--path` for an intentional single-root operation there. If two
project roots are symbolic links to the same physical directory, skillzero
deduplicates them by real path. It also recognizes a symbolic link to an
individual skill directory as a skill instead of silently ignoring it.
If the *same* `SKILL.md` is linked into two otherwise distinct roots, a
mutating `--project` command stops before making changes; those roots would
otherwise maintain conflicting ownership metadata. Use `--path` for one
intentional root, or link the entire skills root instead.

Configure the skills that should stay behind the generated index:

```sh
node dist/index.js configure --path .agents/skills --claude
# or: --cursor, --codex, --copilot, --gemini
```

For Claude and Cursor, skill folders already remain in place. `manage` is a
no-op, and `update` can run the upstream update directly. Follow either one
with `sync` so selected skills regain their manual-only metadata after an
upstream replacement.

```sh
node dist/index.js update --path .agents/skills --claude
node dist/index.js sync --path .agents/skills --claude
```

For Codex, Copilot, and Gemini, temporarily release the moved folders before using the
upstream `skills` CLI. `manage` prepares the directory for any `skills`
command; `update` also runs `skills update` for you.

```sh
node dist/index.js manage --path .agents/skills --codex
skills uninstall example-skill
node dist/index.js sync --path .agents/skills --codex

# Or run the update shortcut, then sync when it completes.
node dist/index.js update --path .agents/skills --codex
node dist/index.js sync --path .agents/skills --codex
```

During the handoff, skillzero restores managed folders to the root and removes
the generated `skill-index/SKILL.md`, so the upstream CLI sees the ordinary
layout. It records the previous managed set in a generated handoff file.
`sync` uses that set as its default, keeps newly-added skills visible unless
you select them, and asks before forgetting skills removed while released.

Move-based configuration:

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

You use `accessibility` and `web-quality-audit` on most frontend work, so you leave them visible. You use `replay-playwright` for debugging sessions and `spreadsheets` for document tasks, so `configure --codex` moves them into the index.

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

- Show policy changes before applying them.
  Skill placement and manual-only metadata both change agent behavior, so the CLI previews either layout.

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
- Move mode assumes agents ignore nested `SKILL.md` files under `skill-index/skills`.
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
