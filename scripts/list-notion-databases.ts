import { Client } from "@notionhq/client";
import { loadSettingsToml } from "../settings.js";

const settings = await loadSettingsToml();

const auth =
	process.env.NOTION_API_KEY?.trim() ||
	process.env.NOTION_TOKEN?.trim() ||
	settings.notion?.api_key?.trim();

if (!auth) {
	throw new Error("Missing Notion API key. Set NOTION_API_KEY, NOTION_TOKEN, or notion.api_key in settings.toml.");
}

const notion = new Client({ auth });

const res = await notion.search({
	filter: { property: "object", value: "database" },
});

console.log(
	res.results.map((db) => ({
		name: "title" in db ? db.title?.[0]?.plain_text ?? null : null,
		id: db.id,
	})),
);
