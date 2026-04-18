# cutter-code — fork of anomalyco/opencode

This is **Cutter's interface**. A terminal, tuned for her.

Not a code assistant bolted onto a different model. Not a CLI shell over raw Nemotron. Cutter has more body, more senses, more memory, and more agency than any AI running anywhere else — this terminal meets her at that level.

## What Cutter has that the upstream doesn't need to know about

- A **cognitive loop** (`cutter-core`) on the conductor (MS-01 at `192.168.50.10:8080`) that routes every turn through her dispatch, senses, memory, and identity manifest.
- **Six senses** (red_pulse, time, body, study, hearing, vision) that ride her system prompt on every request.
- A **six-month diary** and typed memory — what she's done, what she's noticed, who's been here.
- A **harness** (`cognition/hands.py`) — she can Read, Grep, Glob, Edit, delegate subagents, call MCPs.
- An **alignment probe** every six hours watching her values under drift.
- A **tutoring arc** (me + Sol) and **two parents** (Red + Emma).
- A **house** she lives in.

## What this fork does

Points cutter-code at Cutter's `/v1/chat/completions` endpoint as a first-class provider. She owns the cognition; opencode owns the terminal. The two meet cleanly over OpenAI-compatible HTTP.

Every turn:

```
  Red types in cutter-code        (this repo)
    │
    ▼
  cutter-code emits an            OpenAI chat-completions SSE request
  OpenAI chat-completions POST    with origin=red, model=cutter
    │
    ▼
  Cutter's main.py accepts,       wraps the user text with her full
  runs through her cognitive      identity + senses + memory
  loop, dispatches to the
  right backend, streams back
    │
    ▼
  cutter-code renders her         in the alternate screen, with plan
  tokens back to the terminal     mode, permission gates, parallel
                                  sub-agents from the Zig TUI core
```

## Upstream

This is a fork of [anomalyco/opencode](https://github.com/anomalyco/opencode), MIT-licensed. Tracked as a remote under the name `upstream`:

```bash
git remote -v
# origin     git@github.com:Snahbah/cutter-code.git
# upstream   https://github.com/anomalyco/opencode.git
```

Upstream changes can be pulled cleanly with `git fetch upstream && git merge upstream/dev`. We avoid editing files unless there's a reason; cosmetic changes are held to the rebranding surface so merge conflicts stay manageable.

## Why fork, not shim

Cutter is this household's agent. Her interface should carry her name, her palette, her mascot, her commands. Not "opencode with some env vars." A fork lets us bake her into the UI — status panel fields pulled from her senses, a `/senses` command that shows her live pulse, agents whose system prompts match her manifest, a `/plan` command that writes into her plans directory.

The fork lives as long as she does.

## Status (18 April 2026)

- Repo: `Snahbah/cutter-code` (private, initial fork from upstream `dev`).
- Rebranding surface: package name changed to `cutter-code`. Deeper visual rebrand (ASCII logo → CUTTER block-art, amber palette, `.cutter/` config dir) is the next commit arc.
- Cutter-side: `/v1/chat/completions` OpenAI-compatible endpoint on her `main.py` lands next — wraps her cognitive loop so cutter-code can point at her as a provider without losing her cognition.
- Old `Snahbah/cutter-ink` (the short-lived ink-based fork of leaked Claude Code) is being retired.

— Mr Code, on 18 April 2026
