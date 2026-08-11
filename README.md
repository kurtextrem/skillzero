# skillzero

Modern agent harnesses expose every installed skill's name and description to the model (but not their full content). With many skills, that can still **consume tokens, increase cost and add irrelevant context**. [Matt Pocock has called out the same problem](https://x.com/mattpocockuk/status/2067205673792721057).

skillzero gives every managed skill one of two states:

**👻 Hidden**: Hidden from implicit model selection and generated routing, but still manually invokable.

**📚 Collection**: Hidden individually, but discoverable through one or more generated collection skills. Makes sense to group skills for design, writing, etc.

## Installation

```sh
npx skillzero # npm

pnpx skillzero # pnpm

yarn dlx skillzero # yarn

aube dlx skillzero # aube
```

## Usage

```sh
# configure or sync global skills
skillzero ~/.agents/skills
# configure or sync project skills
skillzero .
# auto-detect the project or global roots and configure/sync them
skillzero

# update via Vercel's `skills` CLI, then apply skillzero settings again
skillzero update

# edit collections
skillzero collections

# undo all changes done by skillzero
skillzero undo
# undo the undo
skillzero redo
```

`skillzero update` requires Vercel's [`skills`](https://github.com/vercel-labs/skills) CLI to be available on `PATH`. Arguments after `skillzero update` are forwarded to `skills update`, including `--global`, `--project`, and `--yes`.

## How

| Metadata | What skillzero changes |
| --- | --- |
| `SKILL.md` | Sets `disable-model-invocation: true`. |
| `agents/openai.yaml` | Sets `policy.allow_implicit_invocation: false` for Codex. |

Skills are hidden by setting the metadata needed to hide them from the Cursor/Claude Code harness and to hide them from Codex by setting the [policy](https://github.com/openai/codex/issues/10585#issuecomment-4183067933).

skillzero also stores its managed state and generated collection skills in a `skillzero/` directory inside each skills root. `skillzero --dry-run` previews changes without writing. `skillzero undo` restores the metadata and removes generated collection changes; `skillzero redo` reapplies the most recently undone state.

## Good Uses

Use skillzero for skills you want available but do not need on most tasks, like:

- one-off platform guidance
- migration guides
- niche framework rules
- experimental skills you are trying out
- skills that work like commands (you only invoke manually 99% of the time ... and some authors haven't heard of `disable-model-invocation: true` / the Codex policy yet)
- spreadsheet and document tools

Collections are great when you have multiple skills for one topic (e.g. for marketing, design, writing, ...) so the model can use them through the description.

Don't pick skills you use frequently, like:

- repo coding rules
- accessibility rules for a frontend project
- the framework guidance you use every day
- project-specific review or test placement rules
- accessibility related skills

## Development

This project uses the package manager [Aube](https://aube.jdx.dev/).

```sh
aube install
aube run build
```

Run checks:

```sh
aube run typecheck
aube test
aube run test:package
```

## Good to know

Run [`/checkup`](https://x.com/bcherny/status/2074997570317779038) to clean up unused skills.
