# skillzero

Nowadays agents see each installed skill's name and description instead of loading the full `SKILL.md`. That is cheap with a tiny amount of skills, but 100 x "name + 1-2 sentences" is still a lot of potentially wasted tokens. Experts like [Matt Pocock](https://x.com/mattpocockuk/status/2067205673792721057) have hit this issue in the past as well.

`skillzero` solves that by allowing you to split skills into managed skill collections:

1. **Top-level skills**: regular skills / untouched by skillzero
2. **Managed skills**: the agent can find those through one `skill-index` skill
3. **Collection skills**: the agent can find skills inside collection by reading the collection index skill + description.

## Usage

```sh
# configure or sync global skills
skillzero ~/.agents/skills
# configure or sync project skills
skillzero .
# auto-detect the project or global roots and configure/sync them
skillzero

# release, update through the upstream `skills` CLI, and sync the project
skillzero update

# edit collection routing groups
skillzero collections

# undo all changes done by skillzero
skillzero undo
# undo the undo
skillzero redo
```

On the first run, you'll be asked which skills to handle. On subsequent runs,
the existing layout is detected and synchronized.

## How

Choose a harness layout when configuring a skills root:

| Target flags | What skillzero changes |
| --- | --- | --- |
| `--claude`, `--cursor` | Adds `disable-model-invocation: true` to selected skills and writes the index. |
| `--codex`, `--copilot`, `--gemini` (or no target flag) | Moves selected skills into `skill-index/skills/<name>/_SKILL.md` and writes the index. |

`disable-model-invocation: true` keeps a selected skill out of model-driven invocation until the user explicitly invokes it. The field is not part of the Agent Skills specification though and not supported by Codex for example, so `skillzero` is a great compatibility layer if you use multiple agents and want a clean context in all of them.

<sub>Note: This means autocomplete will stop working; you can still invoke managed skills, but you won't see them in the UI as suggestion</sub>

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

## Development

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

## Alternatives

Run [`/checkup`](https://x.com/bcherny/status/2074997570317779038) to clean up unused skills.
