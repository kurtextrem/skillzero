# skillzero

![skillzero banner](assets/skillzero-banner.png)

<p align="center"><sub><em>Skillmaxxers rejoice. You can now enjoy skills and save tokens.</em></sub></p>

Many modern agent harnesses expose every installed skill's name and description to the model (but not their full content).
With many skills, even that can still **consume tokens, increase cost, [lead to accidental triggers](https://addyo.substack.com/p/audit-your-agent-files) and add irrelevant context to the session permanently**. Experts like [Matt Pocock](https://x.com/mattpocockuk/status/2067205673792721057), [Addy Osmani](https://x.com/addyosmani/status/2086871426653356066) and [swyx](https://x.com/swyx/status/2086505938144616810) have called out the same problem.

skillzero solves it by diving skills into 3 categories:

1. **Unmanaged**: stay as-is, not touched by skillzero - agents see their name and description as usual.

2. **👻 Hidden**: Completely hidden to the agent - so not even name and description make it into the context (but are still manually invokable, like commands).

3. **📚 Collection**: Allows you to bundle skills that fit one topic into one skill, so the agent only lazily reads the skills when you work on a topic related to the skills in the collection. <br />Examples: design, marketing, videos, writing, etc. - or frontend / backend skills if you work on either more often than the other. You pick the name and description.

By hiding skills or placing them in a collection, you allow the agent to focus on skills that it should automatically use, instead of wasting tokens every turn.

## Usage

| npm             | pnpm             | yarn                 | aube                 |
| --------------- | ---------------- | -------------------- | -------------------- |
| `npx skillzero` | `pnpx skillzero` | `yarn dlx skillzero` | `aube dlx skillzero` |

... or you can of course also globally install (`npm -g i skillzero` for example).

## Demo

![skillzero token-saving demo](assets/skillzero-demo.gif)

## Other commands

```sh
skillzero   # no args let's you pick the folder interactively
skillzero . # invoke for a specific path (current dir)
skillzero collections # edit collections

skillzero update # update via Vercel's `skills` CLI, then apply skillzero settings again

skillzero undo   # undo all changes done by skillzero
skillzero redo   # undo the undo
```

`skillzero --dry-run` previews changes without writing.

<sub>`skillzero update` requires Vercel's [`skills`](https://github.com/vercel-labs/skills) CLI to be available on `PATH`. Arguments after `skillzero update` are forwarded to `skills update`, including `--global`, `--project`, and `--yes`.</sub>

## How

| Metadata             | What skillzero changes                         |
| -------------------- | ---------------------------------------------- |
| `SKILL.md`           | Sets `disable-model-invocation: true`.         |
| `agents/openai.yaml` | Sets `policy.allow_implicit_invocation: false` |

Skills are hidden by setting the metadata needed to hide them from the Cursor and Claude Code harness. The `openai.yaml` is needed to hide them [Codex](https://github.com/openai/codex/issues/10585#issuecomment-4183067933). You can of course also point the author of your favorite skill to this repo to make them aware they need to set both, otherwise some agents see skills that should only manually be invoked, and some don't.

skillzero stores its managed state in a `skillzero/` directory inside each skills root and writes generated collection skills beside ordinary skills as `skillzero-<collection-id>/` folders.

## Good Uses

Use skillzero for skills you want available but do not need on most tasks, like:

- one-off platform guidance
- migration guides
- niche framework rules
- experimental skills you are trying out
- spreadsheet and document tools
- skills that work like commands (you only invoke manually 99% of the time ... and some authors haven't heard of `disable-model-invocation: true` / the Codex policy yet)

Collections are great when you have multiple skills for one topic (e.g. for marketing, design, writing, ...).

With collections, your `.skills` folder might then look like this:

```text
.skills/
├── grill-me                              [untouched by skillzero]
├── modern-web-guidance                   [untouched by skillzero]
│
├── animation-vocabulary/
│   └── SKILL.md                          [👻 now hidden to the agent]
├── better-colors/
│   └── SKILL.md                          [👻 now hidden to the agent]
└── skillzero-design/
    └── SKILL.md                          [📚 invokable by the agent; manually invokable via `/design`]
```

Don't pick skills you use frequently, like:

- repo coding rules
- accessibility related skills
- the framework guidance you use every day
- project-specific review or test placement rules

## Good to know

- Claude Code shortens skill descriptions if they exceed [1%](https://code.claude.com/docs/en/skills#:~:text=The%20budget%20scales%20at%201%25%20of%20the%20model%E2%80%99s%20context%20window) of the context window, Codex lists skill path for up to [2%](https://learn.chatgpt.com/docs/build-skills#:~:text=In%20Codex%2C%20the%20initial%20list%20also%20includes%20each%20skill%27s%20file%20path.%20To%20avoid%20crowding%20out%20the%20rest%20of%20the%20prompt%2C%20this%20list%20uses%20at%20most%202%25%20of%20the%20model%27s%20context%20window). Both drop descriptions if you have too many.
- Run [`/checkup`](https://x.com/bcherny/status/2074997570317779038) to clean up unused skills.
- More tips in Matt Pocock's [article](https://www.aihero.dev/how-to-kill-the-bloat-in-claude-codes-system-prompt) on how to remove context bloat (`/context`, remove bundled skills, ...)

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
