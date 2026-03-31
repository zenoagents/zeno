---
name: notion
description: Use this skill for Notion API operations such as listing databases, listing pages, and adding entries to a Notion database when the user asks to inspect or update Notion content.
execution_mode: api
api_provider: notion
provider_website: https://www.notion.so
---

# Notion

Use this skill when the user needs to read or write Notion database data through the API.

## Current Scope

- List available databases in the connected Notion workspace.
- List pages from a Notion database.
- Add a new entry to a Notion database table.
- Perform live Notion API interactions only.

## Required Inputs

- `notion.api_key` in `credentials.toml`, or `NOTION_TOKEN` / `NOTION_API_KEY` in the environment.
- `notion.database_id` in `credentials.toml` for page listing or table inserts, unless live API discovery identifies the target database.

## Setup

- Use `@notionhq/client` for API access.
- Configure Notion credentials in `credentials.toml`.

## Workflow

1. Verify Notion credentials are configured.
2. If the target database is unclear, discover visible databases through the Notion API.
3. If needed, query the target database to confirm the page set and schema.
4. For insert requests, retrieve the database schema, identify the title property, and create the page through the API.
5. Report the created page id and URL when available.

## API Pattern

1. Create a `Client` from `@notionhq/client`.
2. Load credentials from `credentials.toml` first, then fall back to env vars.
3. For database discovery, call `notion.search({ filter: { property: "object", value: "database" } })`.
4. For page listing, call `notion.databases.query({ database_id, page_size: 50 })`.
5. For inserts, retrieve the database schema, find the title property, then call `notion.pages.create(...)`.

## Safety Rules

- Never log or echo the Notion API key.
- Prefer small page sizes first, then paginate if needed.
- Do not assume the configured database id is correct if live database discovery shows a different single visible database.
- For writes, only populate the title field unless the user explicitly asks for more properties.
- Surface API errors clearly.

## Notes

- `page_size` supports up to 100.
- Creating a page inside a database appears as a new row in a Notion table.
- Keep request payloads minimal and explicit.
