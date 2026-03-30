import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSettingsToml } from "../settings.js";

const providerEnvVars = {
	openai: ["OPENAI_API_KEY"],
	"azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
	anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
	google: ["GEMINI_API_KEY"],
	"google-vertex": ["GOOGLE_CLOUD_API_KEY", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"],
	groq: ["GROQ_API_KEY"],
	cerebras: ["CEREBRAS_API_KEY"],
	xai: ["XAI_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	telegram: ["TELEGRAM_BOT_TOKEN"],
	"vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
	zai: ["ZAI_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	minimax: ["MINIMAX_API_KEY"],
	"minimax-cn": ["MINIMAX_CN_API_KEY"],
	huggingface: ["HF_TOKEN"],
	opencode: ["OPENCODE_API_KEY"],
	"opencode-go": ["OPENCODE_API_KEY"],
	"kimi-coding": ["KIMI_API_KEY"],
	"github-copilot": ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
	notion: ["NOTION_TOKEN"],
} satisfies Record<string, string[]>;

const authPath = join(homedir(), ".pi", "agent", "auth.json");

let storedProviders = new Set<string>();
let authReadError: NodeJS.ErrnoException | Error | undefined;

try {
	const raw = readFileSync(authPath, "utf8");
	const parsed = JSON.parse(raw) as unknown;
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		storedProviders = new Set(Object.keys(parsed));
	}
} catch (error) {
	authReadError = error as NodeJS.ErrnoException | Error;
}

const settings = await loadSettingsToml();

const rows = Object.entries(providerEnvVars)
	.map(([provider, envVars]) => {
		const envSet = envVars.filter((name) => Boolean(process.env[name]));
		const stored = storedProviders.has(provider);

		const settingsConfigured =
			(provider === "openrouter" && Boolean(settings.openrouter?.api_key)) ||
			(provider === "openai" && Boolean(settings.openai?.api_key)) ||
			(provider === "telegram" && Boolean(settings.tg?.bottoken)) ||
			(provider === "notion" && Boolean(settings.notion?.api_key));

		const anyAuth = stored || envSet.length > 0 || settingsConfigured;

		return {
			provider,
			status: anyAuth ? "configured" : "missing",
			env: envSet.length > 0 ? envSet.join(", ") : "-",
			settings: settingsConfigured ? "yes" : "-",
			stored: stored ? "yes" : "no",
		};
	})
	.sort((a, b) => a.provider.localeCompare(b.provider));

const configured = rows.filter((row) => row.status === "configured");

console.log(`Configured providers: ${configured.length}/${rows.length}`);
console.log();
console.log("provider\tstatus\tenv vars set\tsettings.toml\tstored in auth.json");

for (const row of rows) {
	console.log(`${row.provider}\t${row.status}\t${row.env}\t${row.settings}\t${row.stored}`);
}

if (settings.openrouter?.api_key) {
	console.log();
	console.log("settings.toml:");
	console.log(`- openrouter.api_key: set`);
	console.log(`- openrouter.model: ${settings.openrouter.model ?? "-"}`);
}

if (settings.openai?.api_key) {
	console.log();
	console.log("settings.toml:");
	console.log(`- openai.api_key: set`);
	console.log(`- openai.model: ${settings.openai.model ?? "-"}`);
}

if (settings.tg?.bottoken) {
	console.log();
	console.log("settings.toml:");
	console.log("- tg.bottoken: set");
}

if (settings.notion?.api_key) {
	console.log();
	console.log("settings.toml:");
	console.log("- notion.api_key: set");
	console.log(`- notion.database_id: ${settings.notion.database_id ?? "-"}`);
}

if (authReadError && "code" in authReadError && authReadError.code !== "ENOENT") {
	console.log();
	console.log(`Auth file note: could not read ${authPath}`);
	console.log(`Reason: ${authReadError.message}`);
}
