# skillzero

Modern agent harnesses expose every installed skill's name and description to the model (but not their full content). With many skills, that can still **consume tokens, increase cost and add irrelevant context**. [Matt Pocock has called out the same problem](https://x.com/mattpocockuk/status/2067205673792721057).

skillzero allows you to completely hide skills from the agent or to group them in collections the agent can invoke lazily:

**Hidden skills** (`skillzero`): Completely hidden from agents, but are still manually invokable

**📚 Collections** (`skillzero collections`):

- Group indexed skills by use case, such as design or writing
- Expose one focused routing description per group

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

## How

| Metadata | What skillzero changes |
| --- | --- |
| `SKILL.md` | Sets `disable-model-invocation: true`. |
| `agents/openai.yaml` | Sets `policy.allow_implicit_invocation: false` for Codex. |

Indexed and hidden skills are both managed by skillzero. For each managed skill, skillzero sets `disable-model-invocation: true` and the Codex [policy](https://github.com/openai/codex/issues/10585#issuecomment-4183067933) in place.

## Good Uses

Use this for skills you want available but do not need on most tasks:

- one-off platform guidance
- migration guides
- niche framework rules
- experimental skills you are trying out
- skills that work like commands (you only invoke manually 99% of the time ... and some authors haven't heard of `disable-model-invocation: true` / the Codex policy yet)
- spreadsheet and document tools

Keep a skill top-level when you use it frequently:

- repo coding rules
- accessibility rules for a frontend project
- the framework guidance you use every day
- project-specific review or test placement rules
- accessibility related skills

## Development

This project uses the very fast package manager [Aube](https://aube.en.dev/).

```sh
aube install
aubr build
```

Run checks:

```sh
aubr typecheck
aube test
```

## Good to know

Run [`/checkup`](https://x.com/bcherny/status/2074997570317779038) to clean up unused skills.
