---
name: git
description: Use this skill for basic day-to-day git workflows like status checks, reviewing diffs, creating focused commits, and safe branch operations.
execution_mode: local
---

# Git Skill

Use this skill when the task involves routine repository work.

## Goals

- Understand current repo state quickly.
- Make small, focused commits.
- Avoid destructive history changes unless explicitly requested.

## Basic workflow

1. Inspect current state with `git status --short --branch`.
2. Review changes with `git diff` (and `git diff --staged` when relevant).
3. Check recent history with `git log --oneline -n 10`.
4. Stage only intended files with `git add <paths>`.
5. Create a clear commit message with `git commit -m "<message>"`.

## Safe defaults

- Prefer non-destructive commands.
- Do not run `git reset --hard`, force pushes, or history rewrites unless explicitly requested.
- Keep commits scoped to the requested task.

## Helpful commands

- `git branch --show-current`
- `git branch`
- `git switch <branch>`
- `git show --stat --oneline HEAD`
