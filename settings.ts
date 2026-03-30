import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const settingsTomlPath = join(process.cwd(), "settings.toml");

export type BotSettings = {
	tg?: {
		bottoken?: string;
		heartbeat_enabled?: boolean;
		heartbeat_interval_minutes?: number;
		heartbeat_chat_ids?: number[];
	};
	openrouter?: {
		api_key?: string;
		model?: string;
	};
	openai?: {
		api_key?: string;
		model?: string;
	};
	notion?: {
		api_key?: string;
		database_id?: string;
	};
};

function stripInlineComment(line: string) {
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < line.length; i += 1) {
		const char = line[i];
		const previous = i > 0 ? line[i - 1] : "";

		if (char === "'" && !inDouble && previous !== "\\") {
			inSingle = !inSingle;
			continue;
		}

		if (char === '"' && !inSingle && previous !== "\\") {
			inDouble = !inDouble;
			continue;
		}

		if (!inSingle && !inDouble && char === "#") {
			return line.slice(0, i).trim();
		}
	}

	return line.trim();
}

function parseScalar(raw: string) {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;

	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}

	if (/^(true|false)$/i.test(trimmed)) {
		return trimmed.toLowerCase() === "true";
	}

	const numericValue = Number(trimmed);
	if (Number.isFinite(numericValue)) {
		return numericValue;
	}

	return trimmed;
}

function parseNumberList(raw: string): number[] {
	const trimmed = raw.trim();
	const normalized = trimmed.startsWith("[") && trimmed.endsWith("]")
		? trimmed.slice(1, -1)
		: trimmed;

	const values = normalized
		.split(",")
		.map((value) => String(parseScalar(value) ?? "").trim())
		.filter(Boolean);

	const parsed = values
		.map((value) => Number.parseInt(value, 10))
		.filter((value) => Number.isFinite(value));

	return [...new Set(parsed)];
}

export async function loadSettingsToml(): Promise<BotSettings> {
	try {
		const raw = await readFile(settingsTomlPath, "utf8");
		const settings: BotSettings = {};
		let section: "tg" | "openrouter" | "openai" | "notion" | null = null;

		for (const line of raw.split(/\r?\n/)) {
			const trimmed = stripInlineComment(line);
			if (!trimmed) continue;

			const sectionMatch = trimmed.match(/^\[([A-Za-z0-9_.-]+)\]$/);
			if (sectionMatch) {
				section =
					sectionMatch[1] === "tg"
						? "tg"
						: sectionMatch[1] === "openrouter"
							? "openrouter"
							: sectionMatch[1] === "openai"
								? "openai"
								: sectionMatch[1] === "notion"
									? "notion"
								: null;
				continue;
			}

			if (!section) continue;

			const equalsIndex = trimmed.indexOf("=");
			if (equalsIndex === -1) continue;

			const key = trimmed.slice(0, equalsIndex).trim();
			const value = trimmed.slice(equalsIndex + 1).trim();

			if (section === "tg") {
				settings.tg ??= {};
				if (key === "bottoken") {
					const parsed = parseScalar(value);
					if (typeof parsed === "string") {
						settings.tg.bottoken = parsed.trim();
					}
					continue;
				}

				if (key === "heartbeat_enabled") {
					const parsed = parseScalar(value);
					if (typeof parsed === "boolean") {
						settings.tg.heartbeat_enabled = parsed;
					}
					continue;
				}

				if (key === "heartbeat_interval_minutes") {
					const parsed = parseScalar(value);
					if (typeof parsed === "number" && Number.isFinite(parsed)) {
						settings.tg.heartbeat_interval_minutes = parsed;
					}
					continue;
				}

				if (key === "heartbeat_chat_ids") {
					const parsed = parseNumberList(value);
					if (parsed.length > 0) {
						settings.tg.heartbeat_chat_ids = parsed;
					}
				}
				continue;
			}

			if (section === "openrouter") {
				settings.openrouter ??= {};
				if (key === "api_key") {
					const parsed = parseScalar(value);
					if (typeof parsed === "string") {
						settings.openrouter.api_key = parsed.trim();
					}
					continue;
				}
				if (key === "model") {
					const parsed = parseScalar(value);
					if (typeof parsed === "string") {
						settings.openrouter.model = parsed.trim();
					}
					continue;
				}
			}

			if (section === "openai") {
				settings.openai ??= {};
				if (key === "api_key") {
					const parsed = parseScalar(value);
					if (typeof parsed === "string") {
						settings.openai.api_key = parsed.trim();
					}
					continue;
				}
				if (key === "model") {
					const parsed = parseScalar(value);
					if (typeof parsed === "string") {
						settings.openai.model = parsed.trim();
					}
				}
			}

			if (section === "notion") {
				settings.notion ??= {};
				if (key === "api_key") {
					const parsed = parseScalar(value);
					if (typeof parsed === "string") {
						settings.notion.api_key = parsed.trim();
					}
					continue;
				}
				if (key === "database_id") {
					const parsed = parseScalar(value);
					if (typeof parsed === "string") {
						settings.notion.database_id = parsed.trim();
					}
				}
			}
		}

		return settings;
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code === "ENOENT") {
			return {};
		}
		throw error;
	}
}

export function getTelegramBotToken(settings: BotSettings): string {
	const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
	if (envToken) {
		if (!/^\d+:[A-Za-z0-9_-]+$/.test(envToken)) {
			throw new Error(
				"Invalid TELEGRAM_BOT_TOKEN. It must look like <digits>:<token>.",
			);
		}
		return envToken;
	}

	const token = settings.tg?.bottoken?.trim();
	if (token) {
		if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
			throw new Error(
				`Invalid Telegram bot token in settings.toml. tg.bottoken must look like <digits>:<token>, not an OpenRouter key.`,
			);
		}
		return token;
	}

	throw new Error(`Missing Telegram bot token. Set tg.bottoken in ${settingsTomlPath} or TELEGRAM_BOT_TOKEN.`);
}

export function applyConfigToEnv(settings: BotSettings) {
	if (!process.env.OPENROUTER_API_KEY && settings.openrouter?.api_key) {
		process.env.OPENROUTER_API_KEY = settings.openrouter.api_key;
	}
	if (!process.env.OPENAI_API_KEY && settings.openai?.api_key) {
		process.env.OPENAI_API_KEY = settings.openai.api_key;
	}
	if (!process.env.NOTION_TOKEN && settings.notion?.api_key) {
		process.env.NOTION_TOKEN = settings.notion.api_key;
	}
	if (!process.env.NOTION_DATABASE_ID && settings.notion?.database_id) {
		process.env.NOTION_DATABASE_ID = settings.notion.database_id;
	}
}
