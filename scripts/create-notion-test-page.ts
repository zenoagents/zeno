import { Client, isFullDatabase } from "@notionhq/client";
import { loadCredentialsToml } from "../credentials.js";

const credentials = await loadCredentialsToml();
const args = process.argv.slice(2);

const configuredDatabaseId = process.env.NOTION_DATABASE_ID?.trim() || credentials.notion?.database_id?.trim();
const databaseId = configuredDatabaseId || args[0]?.trim();
const titleArg = configuredDatabaseId ? args.join(" ").trim() : args.slice(1).join(" ").trim();
const title = titleArg || `Test page ${new Date().toISOString()}`;
const token = process.env.NOTION_TOKEN?.trim() || credentials.notion?.api_key?.trim();

if (!token) {
	throw new Error("Missing Notion token. Set NOTION_TOKEN or notion.api_key in credentials.toml.");
}

if (!databaseId) {
	throw new Error(
		"Missing Notion database ID. Set NOTION_DATABASE_ID, notion.database_id, or pass it as the first CLI argument.",
	);
}

const notion = new Client({ auth: token });

async function createTestPage() {
	const database = await notion.databases.retrieve({ database_id: databaseId });

	if (!isFullDatabase(database)) {
		throw new Error(`Could not retrieve full database schema for ${databaseId}.`);
	}

	const titlePropertyName = Object.entries(database.properties).find(([, property]) => property.type === "title")?.[0];

	if (!titlePropertyName) {
		throw new Error(`Database ${databaseId} does not expose a title property.`);
	}

	const page = await notion.pages.create({
		parent: { database_id: databaseId },
		properties: {
			[titlePropertyName]: {
				title: [
					{
						type: "text",
						text: {
							content: title,
						},
					},
				],
			},
		},
	});

	console.log("Created Notion test page");
	console.log(`Page ID:\t${page.id}`);
	if ("url" in page && page.url) {
		console.log(`URL:\t${page.url}`);
	}
	console.log(`Title:\t${title}`);
	console.log(`Title property:\t${titlePropertyName}`);
}

createTestPage().catch((error) => {
	console.error("Error creating test page:", error);
	process.exitCode = 1;
});
