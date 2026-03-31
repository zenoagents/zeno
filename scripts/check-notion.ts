import { loadCredentialsToml } from "../credentials.js";

const credentials = await loadCredentialsToml();

const token = process.env.NOTION_TOKEN?.trim() || credentials.notion?.api_key?.trim();
const databaseId = process.env.NOTION_DATABASE_ID?.trim() || credentials.notion?.database_id?.trim();

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
