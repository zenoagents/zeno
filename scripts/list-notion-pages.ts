import { Client } from "@notionhq/client";
import { loadSettingsToml } from "../settings.js";

const settings = await loadSettingsToml();

const token = process.env.NOTION_TOKEN?.trim() || settings.notion?.api_key?.trim();
const databaseId = process.env.NOTION_DATABASE_ID?.trim() || settings.notion?.database_id?.trim() || process.argv[2]?.trim();

if (!token) {
	throw new Error("Missing Notion token. Set NOTION_TOKEN or notion.api_key in settings.toml.");
}

if (!databaseId) {
	throw new Error("Missing Notion database ID. Set NOTION_DATABASE_ID, notion.database_id, or pass it as the first CLI argument.");
}

const notion = new Client({ auth: token });

async function listPages() {
	let startCursor: string | undefined;
	let pageCount = 0;

	do {
		const response = await notion.databases.query({
			database_id: databaseId,
			page_size: 50,
			...(startCursor ? { start_cursor: startCursor } : {}),
		});

		for (const page of response.results) {
			if (!("properties" in page)) {
				continue;
			}

			pageCount += 1;
			console.log("Page ID:", page.id);
			console.log("Properties:", page.properties);
			console.log("---------------------");
		}

		startCursor = response.next_cursor ?? undefined;
	} while (startCursor);

	console.log(`Listed ${pageCount} pages.`);
}

listPages().catch((error) => {
	console.error("Error listing pages:", error);
	process.exitCode = 1;
});
