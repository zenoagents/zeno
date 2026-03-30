import { loadSettingsToml } from "../settings.js";

const settings = await loadSettingsToml();

const token = process.env.NOTION_TOKEN?.trim() || settings.notion?.api_key?.trim();
const databaseId = process.env.NOTION_DATABASE_ID?.trim() || settings.notion?.database_id?.trim();

console.log("Notion configuration");
console.log(`token\t${token ? "set" : "missing"}`);
console.log(`database_id\t${databaseId ? "set" : "missing"}`);

if (!token || !databaseId) {
	process.exitCode = 1;
	console.log();
	console.log("Missing values:");
	if (!token) console.log("- NOTION_TOKEN or notion.api_key");
	if (!databaseId) console.log("- NOTION_DATABASE_ID or notion.database_id");
}
