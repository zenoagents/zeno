---
name: scheduling
description: Schedule and manage Telegram notifications using schedule_task, list_scheduled_tasks, and cancel_scheduled_task. Use when users ask for one-time or recurring reminders and periodic reports in the current chat/thread.
execution_mode: local
---

# Scheduling

## Workflow

1. Confirm reminder intent (one-time vs recurring).
2. Resolve timing (`delay_minutes` / `run_at_iso` for one-time, `interval_minutes` with optional `start_at_iso` and optional daily window for recurring).
3. Confirm reminder text.
4. Call `schedule_task`.
5. Confirm id and next run time.

## Decision Rules

- Use this skill for future reminders (one-time or recurring) and periodic reports.
- Ask one concise clarification when timing is missing or ambiguous.
- Keep reminder text direct and concise.
- Default `target` to `current_chat`.
- Do not invent schedule ids.
- If user wants cancellation without an id, call `list_scheduled_tasks` first.
- For requests like "remind me in 2 minutes", prefer `delay_minutes`.
- For absolute timestamps supplied by the user, use `run_at_iso` (ISO-8601).
- For recurring requests that must begin later, combine `interval_minutes` with `start_at_iso` (ISO-8601).
- For recurring requests that should only fire during certain hours, combine `interval_minutes` with `daily_window_start` and `daily_window_end` in local `HH:MM`.

## Limitations

- Supports:
  - recurring reminders (`interval_minutes >= 1`, optionally with future `start_at_iso` and/or local-hour window limits)
  - one-time reminders (`delay_minutes >= 1` or future `run_at_iso`)
- Do not claim support for calendar cron semantics.

## Tool Use

### Create

Call:
- `schedule_task(text, target="current_chat", interval_minutes|start_at_iso?|daily_window_start?|daily_window_end?|delay_minutes|run_at_iso)`

Rules:
- Provide exactly one primary timing mode:
  - recurring: `interval_minutes` with optional `start_at_iso` and optional `daily_window_start`/`daily_window_end`
  - one-time relative: `delay_minutes`
  - one-time absolute: `run_at_iso`
- Daily windows use local `HH:MM` 24-hour time and apply only to recurring schedules.

Then confirm:
- reminder text,
- schedule type and timing,
- returned schedule `id`,
- returned `next_run_iso`.

### List

Call:
- `list_scheduled_tasks()`

Use the list when users ask:
- what is scheduled,
- which ids exist,
- what to cancel.

### Cancel

Call:
- `cancel_scheduled_task(id)`

If `id` is not provided:
1. Call `list_scheduled_tasks()`.
2. Ask which id to remove.

## Response Patterns

- Success create: `Scheduled every <N> minutes. ID: <id>. Next run: <timestamp>.`
- Success create (windowed recurring): `Scheduled every <N> minutes during <HH:MM>-<HH:MM>. ID: <id>. Next run: <timestamp>.`
- Success create (one-time): `Scheduled one-time reminder. ID: <id>. Runs at: <timestamp>.`
- Success cancel: `Cancelled schedule <id>.`
- Not found: `I could not find that id in this chat. I can list active schedules if you want.`
