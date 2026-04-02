/**
 * Minimal Telegram entrypoint.
 *
 * This project already depends on `@mariozechner/pi-coding-agent`, so this
 * minimal version keeps the HTTP layer on built-in fetch and the heartbeat
 * scheduler in a separate file.
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { appendFile, mkdir } from "node:fs/promises";
import dns from "node:dns";
import { join } from "node:path";
import { Agent, fetch as undiciFetch, interceptors } from "undici";
import { BOT_NAME, BOT_RUNTIME_NAME } from "./branding.js";
import {
	formatOpenRouterCostReport,
	inspectOpenRouterCost,
	parseOpenRouterCostWindow,
	usageLogPath,
	type UsageRecord,
} from "./openrouter-cost.js";
import {
	buildOpenRouterBalanceReport,
	formatOpenRouterAmount,
	inspectOpenRouterBalance,
} from "./openrouter-balance.js";
import {
	buildHeartbeatText,
	buildStartupIdentityText,
	formatUptime,
	startHeartbeatLoop,
} from "./heartbeat.js";
import { createLogger } from "./logging.js";
import { createNotificationScheduler } from "./scheduler.js";
import {
	acquireTelegramProcessLock,
	isTelegramGetUpdatesConflict,
} from "./telegram-process-lock.js";
import {
	buildAllowlistedModelLookup,
	getAllowlistedModelRefCandidates,
	loadDefaultModelSelections,
	normalizeModelRef,
} from "./models.js";
import { applyConfigToEnv, getTelegramBotToken, loadCredentialsToml } from "./credentials.js";
import {
	addHeartbeatPairing,
	formatTelegramTargetFromMessage,
	listHeartbeatPairings,
	parseTelegramTarget,
	removeHeartbeatPairing,
	resolveHeartbeatTargets,
} from "./telegram-pairings.js";

type TelegramUpdate = {
	update_id: number;
	message?: {
		message_id: number;
		message_thread_id?: number;
		text?: string;
		chat: { id: number; type: string };
		from?: { is_bot?: boolean };
	};
};

type OpenRouterCallRecord = {
	timestamp: string;
	model: string;
	usage: UsageRecord;
};

type ParsedTelegramCommand = {
	name: string;
	mention?: string;
	args: string;
};

type TelegramBotCommand = {
	command: string;
	description: string;
};

type ActiveSchedulingContext = {
	chatId: number;
	messageThreadId?: number;
};

type ScheduleTaskParams = {
	interval_minutes?: number;
	delay_minutes?: number;
	run_at_iso?: string;
	start_at_iso?: string;
	daily_window_start?: string;
	daily_window_end?: string;
	text: string;
	target?: "current_chat";
	label?: string;
};

type CancelScheduledTaskParams = {
	id: string;
};

const BOT_COMMANDS: TelegramBotCommand[] = [
	{ command: "start", description: "🏁 Show bot status and menu" },
	{ command: "status", description: "📊 Show uptime and current config" },
	{ command: "balance", description: "💳 Show OpenRouter credits balance" },
	{ command: "usage", description: "💸 Show OpenRouter usage or history" },
	{ command: "cost", description: "🧾 Alias for /usage" },
	{ command: "model", description: "🧠 Show or set the active model" },
	{ command: "context", description: "🗂️ Show tools, skills, and runtime context" },
	{ command: "skills", description: "🛠️ List discovered skills" },
	{ command: "pair", description: "🔔 Pair this chat for notices" },
	{ command: "unpair", description: "🔕 Remove this chat from notices" },
	{ command: "pairings", description: "👥 List saved startup and heartbeat pairings" },
	{ command: "schedules", description: "⏰ List scheduled notifications" },
	{ command: "unschedule", description: "❌ Cancel a schedule by id" },
];

const logger = createLogger("telegram");
const heartbeatLogger = createLogger("heartbeat");
const schedulerLogger = createLogger("scheduler");
const scheduledNotificationsStorePath = join(process.cwd(), "data", "scheduled-notifications.json");
const agentVersion = process.env.npm_package_version?.trim() || "0.1.0";
const processStartedAt = new Date();
logger.info("bot booting", {
	version: agentVersion,
	logFilePath: logger.logFilePath,
});

const credentials = await loadCredentialsToml();
applyConfigToEnv(credentials);
const token = getTelegramBotToken(credentials);
const projectSkillsDir = join(process.cwd(), "skills");
const projectSessionDir = join(process.cwd(), "sessions");
await acquireTelegramProcessLock();

logger.info("credentials loaded", {
	heartbeatEnabled: credentials.tg?.heartbeat_enabled ?? true,
	heartbeatIntervalMinutes: credentials.tg?.heartbeat_interval_minutes ?? 5,
	initialHeartbeatChats: credentials.tg?.heartbeat_chat_ids ?? [],
	openrouterConfigured: Boolean(credentials.openrouter?.api_key),
	openaiConfigured: Boolean(credentials.openai?.api_key),
});
if (!credentials.openrouter?.api_key && !credentials.openai?.api_key) {
	logger.warn(
		"No OpenRouter or OpenAI API key configured. Command messages will work, but normal prompts will fail until a provider key is set.",
	);
}

const apiBase = `https://api.telegram.org/bot${token}`;
let activeSchedulingContext: ActiveSchedulingContext | undefined;

function requireActiveSchedulingContext() {
	if (!activeSchedulingContext) {
		throw new Error("Scheduling tools require an active Telegram chat context.");
	}
	return activeSchedulingContext;
}

function toScheduleToolPayload(chatId: number, messageThreadId?: number) {
	return notificationScheduler.listTasks({ chatId, messageThreadId }).map((job) => ({
		id: job.id,
		label: job.label,
		text: job.action.text,
		schedule_type: job.scheduleType,
		interval_minutes:
			typeof job.intervalMs === "number" ? Math.floor(job.intervalMs / 60_000) : undefined,
		start_at_iso: typeof job.startAt === "number" ? new Date(job.startAt).toISOString() : undefined,
		daily_window_start:
			typeof job.dailyWindowStartMs === "number"
				? `${Math.floor(job.dailyWindowStartMs / 3_600_000)
						.toString()
						.padStart(2, "0")}:${Math.floor((job.dailyWindowStartMs % 3_600_000) / 60_000)
						.toString()
						.padStart(2, "0")}`
				: undefined,
		daily_window_end:
			typeof job.dailyWindowEndMs === "number"
				? `${Math.floor(job.dailyWindowEndMs / 3_600_000)
						.toString()
						.padStart(2, "0")}:${Math.floor((job.dailyWindowEndMs % 3_600_000) / 60_000)
						.toString()
						.padStart(2, "0")}`
				: undefined,
		next_run_iso: new Date(job.nextRun).toISOString(),
		created_at_iso: new Date(job.createdAt).toISOString(),
	}));
}

const notificationScheduler = createNotificationScheduler({
	tickMs: 10_000,
	logger: schedulerLogger,
	storagePath: scheduledNotificationsStorePath,
	executeAction: async (action, job) => {
		await sendTelegramMessage({
			chatId: action.chatId,
			messageThreadId: action.messageThreadId,
			text: action.text,
		});
		schedulerLogger.info("scheduled notification sent", {
			id: job.id,
			chatId: action.chatId,
			messageThreadId: action.messageThreadId,
			label: job.label,
		});
	},
});

const schedulingExtensionFactory: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "schedule_task",
		label: "Schedule Task",
		description:
			"Schedule a notification for the current Telegram chat/thread (recurring or one-time).",
		promptSnippet:
			"schedule_task(text, interval_minutes?|start_at_iso?|daily_window_start?|daily_window_end?|delay_minutes?|run_at_iso?, target?) creates a chat reminder.",
		promptGuidelines: [
			"Use for future reminders and periodic reports in the current chat.",
			"For one-time reminders, prefer delay_minutes for simple requests like 'in 2 minutes'.",
			"For recurring reminders, interval_minutes can be paired with start_at_iso to delay the first run.",
			"For recurring reminders, daily_window_start and daily_window_end can limit delivery to local hours like 09:00 to 21:00.",
			"Confirm timing when schedule parameters are ambiguous.",
			"Use target=current_chat by default.",
		],
		parameters: Type.Object(
			{
				interval_minutes: Type.Optional(Type.Number({ minimum: 1 })),
				start_at_iso: Type.Optional(Type.String({ format: "date-time" })),
				daily_window_start: Type.Optional(
					Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }),
				),
				daily_window_end: Type.Optional(
					Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }),
				),
				delay_minutes: Type.Optional(Type.Number({ minimum: 1 })),
				run_at_iso: Type.Optional(Type.String({ format: "date-time" })),
				text: Type.String({ minLength: 1, maxLength: 2000 }),
				target: Type.Optional(Type.Literal("current_chat")),
				label: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params: ScheduleTaskParams) => {
			if (params.target && params.target !== "current_chat") {
				throw new Error("Only target=current_chat is supported.");
			}

			const context = requireActiveSchedulingContext();
			const text = params.text.trim();
			if (!text) {
				throw new Error("text cannot be empty");
			}

			const result = notificationScheduler.scheduleTask({
				intervalMinutes: params.interval_minutes,
				startAtIso: params.start_at_iso,
				dailyWindowStart: params.daily_window_start,
				dailyWindowEnd: params.daily_window_end,
				delayMinutes: params.delay_minutes,
				runAtIso: params.run_at_iso,
				text,
				chatId: context.chatId,
				messageThreadId: context.messageThreadId,
				label: params.label?.trim() || undefined,
			});

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								id: result.id,
								schedule_type: result.scheduleType,
								interval_minutes: result.intervalMinutes,
								start_at_iso: result.startAtIso,
								daily_window_start: result.dailyWindowStart,
								daily_window_end: result.dailyWindowEnd,
								next_run_iso: result.nextRunIso,
							},
							null,
							2,
						),
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "list_scheduled_tasks",
		label: "List Scheduled Tasks",
		description: "List scheduled notifications for the current Telegram chat/thread.",
		promptSnippet: "list_scheduled_tasks() returns schedules scoped to the current chat.",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async () => {
			const context = requireActiveSchedulingContext();
			const tasks = toScheduleToolPayload(context.chatId, context.messageThreadId);

			return {
				content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
				details: { count: tasks.length },
			};
		},
	});

	pi.registerTool({
		name: "cancel_scheduled_task",
		label: "Cancel Scheduled Task",
		description: "Cancel a scheduled notification by id for the current Telegram chat/thread.",
		promptSnippet: "cancel_scheduled_task(id) removes a schedule in this chat when ids match.",
		parameters: Type.Object(
			{
				id: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params: CancelScheduledTaskParams) => {
			const context = requireActiveSchedulingContext();
			const id = params.id.trim();
			if (!id) {
				throw new Error("id cannot be empty");
			}
			const result = notificationScheduler.cancelTask({
				id,
				chatId: context.chatId,
				messageThreadId: context.messageThreadId,
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});
};

const resourceLoader = new DefaultResourceLoader({
	additionalSkillPaths: [projectSkillsDir],
	extensionFactories: [schedulingExtensionFactory],
});
await resourceLoader.reload();
const { session } = await createAgentSession({
	resourceLoader,
	sessionManager: SessionManager.create(process.cwd(), projectSessionDir),
});
const defaultModelSelections = await loadDefaultModelSelections();
const defaultModelSelectionLookup = buildAllowlistedModelLookup(defaultModelSelections);
const openRouterUsageState = {
	assistantMessages: 0,
	calls: [] as OpenRouterCallRecord[],
	usage: createEmptyUsage(),
};
dns.setDefaultResultOrder("ipv4first");
const { dns: dnsInterceptor } = interceptors;
const telegramIpv4Dispatcher = new Agent().compose([
	dnsInterceptor({ dualStack: false, affinity: 4 }),
]);

async function telegramApi<T>(method: string, payload: Record<string, unknown>) {
	const response = await undiciFetch(`${apiBase}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
		dispatcher: telegramIpv4Dispatcher,
	});

	if (!response.ok) {
		let details = "";
		try {
			details = (await response.text()).trim();
		} catch {
			// ignore
		}
		throw new Error(
			`Telegram API HTTP ${response.status} on ${method}${details ? `: ${details}` : ""}`,
		);
	}

	const data = (await response.json()) as { ok?: boolean; result?: T; description?: string };
	if (!data.ok) {
		throw new Error(data.description ?? `Telegram ${method} returned a non-ok response`);
	}

	return data.result as T;
}

async function promptAgent(prompt: string, context: ActiveSchedulingContext) {
	let output = "";
	const previousSchedulingContext = activeSchedulingContext;
	activeSchedulingContext = context;

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			output += event.assistantMessageEvent.delta;
		}
	});

	try {
		await session.prompt(prompt);
	} finally {
		activeSchedulingContext = previousSchedulingContext;
		unsubscribe();
	}

	return output.trim() || "No reply generated.";
}

async function appendUsageLog(entry: Record<string, unknown>) {
	await mkdir(join(process.cwd(), "usage"), { recursive: true });
	await appendFile(usageLogPath, `${JSON.stringify(entry)}\n`, "utf8");
}

function createEmptyUsage(): UsageRecord {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function parseTelegramCommand(text: string): ParsedTelegramCommand | null {
	const match = text.match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+(.*))?$/s);
	if (!match) {
		return null;
	}

	return {
		name: match[1].toLowerCase(),
		mention: match[2]?.toLowerCase(),
		args: match[3]?.trim() ?? "",
	};
}

function formatCompactNumber(value: number) {
	if (value < 1_000) return value.toString();
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

function formatUsd(value: number) {
	if (value >= 1) {
		return `$${value.toFixed(2)}`;
	}
	if (value >= 0.01) {
		return `$${value.toFixed(4)}`;
	}
	if (value === 0) {
		return "$0.0000";
	}
	return `$${value.toFixed(6)}`;
}

function recordOpenRouterUsage(message: { provider?: string; model?: string; usage?: UsageRecord }) {
	if (message.provider !== "openrouter" || !message.usage) {
		return;
	}

	const usage = message.usage;
	const totalTokens =
		usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const totalCost =
		usage.cost.total || usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;

	const normalizedUsage: UsageRecord = {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens,
		cost: {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: totalCost,
		},
	};

	openRouterUsageState.assistantMessages += 1;
	openRouterUsageState.usage.input += normalizedUsage.input;
	openRouterUsageState.usage.output += normalizedUsage.output;
	openRouterUsageState.usage.cacheRead += normalizedUsage.cacheRead;
	openRouterUsageState.usage.cacheWrite += normalizedUsage.cacheWrite;
	openRouterUsageState.usage.totalTokens += normalizedUsage.totalTokens;
	openRouterUsageState.usage.cost.input += normalizedUsage.cost.input;
	openRouterUsageState.usage.cost.output += normalizedUsage.cost.output;
	openRouterUsageState.usage.cost.cacheRead += normalizedUsage.cost.cacheRead;
	openRouterUsageState.usage.cost.cacheWrite += normalizedUsage.cost.cacheWrite;
	openRouterUsageState.usage.cost.total += normalizedUsage.cost.total;

	openRouterUsageState.calls.push({
		timestamp: new Date().toISOString(),
		model: message.model?.trim() || "unknown",
		usage: normalizedUsage,
	});

	void appendUsageLog({
		timestamp: new Date().toISOString(),
		command: "telegram",
		provider: "openrouter",
		model: message.model?.trim() || "unknown",
		assistantMessages: 1,
		usage: normalizedUsage,
	}).catch((error) => {
		logger.warn("failed to write openrouter usage log", error);
	});
}

function formatCurrentOpenRouterUsage() {
	const usage = openRouterUsageState.usage;
	const totalTokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const recentCalls = openRouterUsageState.calls.slice(-5);

	const lines = [
		"OpenRouter usage (current session)",
		`Calls ${openRouterUsageState.calls.length} | assistant msgs ${openRouterUsageState.assistantMessages} | total ${formatUsd(usage.cost.total)}`,
		`Tokens in ${formatCompactNumber(usage.input)} out ${formatCompactNumber(usage.output)} cache ${formatCompactNumber(usage.cacheRead + usage.cacheWrite)} tot ${formatCompactNumber(totalTokens)}`,
		`Cost in ${formatUsd(usage.cost.input)} out ${formatUsd(usage.cost.output)} cache ${formatUsd(usage.cost.cacheRead + usage.cost.cacheWrite)}`,
	];

	if (recentCalls.length > 0) {
		lines.push("");
		lines.push("Recent calls:");
		for (const call of recentCalls) {
			lines.push(`- ${call.model}: ${formatCompactNumber(call.usage.totalTokens)} tok | ${formatUsd(call.usage.cost.total)}`);
		}
	}

	return lines.join("\n");
}

function formatScheduledTasksForTelegram(chatId: number, messageThreadId?: number) {
	const tasks = toScheduleToolPayload(chatId, messageThreadId);
	if (tasks.length === 0) {
		return "No scheduled notifications for this chat.";
	}

	const lines = [`Scheduled notifications (${tasks.length}):`];
	for (const task of tasks.slice(0, 20)) {
		const scheduleSummary =
			task.schedule_type === "recurring"
				? `every ${task.interval_minutes ?? "?"}m`
				: "one-time";
		const timingLabel = task.schedule_type === "recurring" ? "next" : "at";
		lines.push(
			`- ${task.id} | ${scheduleSummary} | ${timingLabel} ${task.next_run_iso} | ${task.text}`,
		);
	}
	if (tasks.length > 20) {
		lines.push(`- ...and ${tasks.length - 20} more`);
	}

	return truncateTelegramMessage(lines.join("\n"));
}

function formatCredentialValue(value?: string) {
	return value?.trim() ? value.trim() : "not set";
}

async function formatStatusForTelegram(chatId: number, messageThreadId?: number) {
	const pairings = await listHeartbeatPairings();
	const currentModel = session.model ? toModelRef(session.model.provider, session.model.id) : "not selected";
	const scheduleCount = toScheduleToolPayload(chatId, messageThreadId).length;
	let openRouterBalanceLine = "OpenRouter balance: unavailable";
	if (process.env.OPENROUTER_API_KEY) {
		try {
			const balance = await inspectOpenRouterBalance({ apiKey: process.env.OPENROUTER_API_KEY });
			openRouterBalanceLine = `OpenRouter balance: ${formatOpenRouterAmount(balance.remainingCredits)} remaining / ${formatOpenRouterAmount(balance.totalCredits)} total`;
		} catch (error) {
			const message = error instanceof Error ? error.message.trim() : String(error);
			openRouterBalanceLine = `OpenRouter balance: unavailable (${message || "unknown error"})`;
		}
	}
	const lines = [
		`${BOT_NAME} status`,
		`Version: ${agentVersion}`,
		`Started at: ${processStartedAt.toISOString()}`,
		`Uptime: ${formatUptime(process.uptime())}`,
		`Current model: ${currentModel}`,
		"",
		"Credentials",
		`Heartbeat: ${(credentials.tg?.heartbeat_enabled ?? true) ? "enabled" : "disabled"} (every ${credentials.tg?.heartbeat_interval_minutes ?? 5}m)`,
		`Configured heartbeat chats: ${credentials.tg?.heartbeat_chat_ids?.length ?? 0}`,
		`Saved pairings: ${pairings.length}`,
		`Schedules in this chat: ${scheduleCount}`,
		openRouterBalanceLine,
		`OpenRouter API key: ${process.env.OPENROUTER_API_KEY ? "configured" : "missing"}`,
		`OpenRouter default model: ${formatCredentialValue(credentials.openrouter?.model)}`,
		`OpenAI API key: ${process.env.OPENAI_API_KEY ? "configured" : "missing"}`,
		`OpenAI default model: ${formatCredentialValue(credentials.openai?.model)}`,
		`Notion API key: ${process.env.NOTION_TOKEN ? "configured" : "missing"}`,
		`Notion database id: ${formatCredentialValue(process.env.NOTION_DATABASE_ID || credentials.notion?.database_id)}`,
	];

	return truncateTelegramMessage(lines.join("\n"));
}

function formatPromptFailureForTelegram(error: unknown) {
	if (error instanceof Error) {
		if (error.message.includes("No API key found")) {
			return [
				"I received your message, but no model API key is configured yet.",
				"Set OPENROUTER_API_KEY or OPENAI_API_KEY (or configure it in credentials.toml), then restart the bot.",
			].join("\n");
		}

		const message = error.message.trim();
		if (message) {
			return `Request failed: ${message}`;
		}
	}

	return "Request failed due to an unexpected error.";
}

function truncateTelegramMessage(text: string, maxLength = 4096) {
	if (text.length <= maxLength) {
		return text;
	}
	const suffix = "\n...message truncated...";
	const head = Math.max(0, maxLength - suffix.length);
	return `${text.slice(0, head)}${suffix}`;
}

function formatResourceDiagnostic(value: unknown) {
	if (typeof value === "string") {
		return value;
	}
	if (!value || typeof value !== "object") {
		return String(value);
	}
	const diagnostic = value as { type?: unknown; message?: unknown; path?: unknown };
	const message = typeof diagnostic.message === "string" ? diagnostic.message : JSON.stringify(value);
	const type = typeof diagnostic.type === "string" ? diagnostic.type : "warning";
	const path = typeof diagnostic.path === "string" ? diagnostic.path : "";
	return path ? `${type}: ${message} (${path})` : `${type}: ${message}`;
}

function toModelRef(provider: string, modelId: string) {
	return `${provider}/${modelId}`;
}

async function getAllowlistedModels() {
	const available = await session.modelRegistry.getAvailable();
	const byRef = new Map(available.map((model) => [normalizeModelRef(toModelRef(model.provider, model.id)), model]));
	return defaultModelSelections.map((ref) => ({
		ref,
		model: getAllowlistedModelRefCandidates(ref)
			.map((candidateRef) => byRef.get(candidateRef))
			.find((model) => model !== undefined),
	}));
}

async function resolveAvailableAllowlistedModel(configuredRef: string) {
	const available = await session.modelRegistry.getAvailable();
	const byRef = new Map(available.map((model) => [normalizeModelRef(toModelRef(model.provider, model.id)), model]));
	return getAllowlistedModelRefCandidates(configuredRef)
		.map((candidateRef) => byRef.get(candidateRef))
		.find((model) => model !== undefined);
}

function formatAllowlistedModels(maxShown = 20) {
	const shown = defaultModelSelections.slice(0, maxShown);
	const lines = shown.map((ref) => `- ${ref}`);
	if (defaultModelSelections.length > shown.length) {
		lines.push(`- ...and ${defaultModelSelections.length - shown.length} more`);
	}
	return lines.join("\n");
}

function parseModelRef(input: string): { provider: string; modelId: string } | null {
	const trimmed = input.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
		return null;
	}

	return {
		provider: trimmed.slice(0, slashIndex),
		modelId: trimmed.slice(slashIndex + 1),
	};
}

async function formatModelSelectionHelp() {
	const allowlistedModels = await getAllowlistedModels();
	const availableCount = allowlistedModels.filter((entry) => Boolean(entry.model)).length;

	const currentModel = session.model;
	const currentModelRef = currentModel ? toModelRef(currentModel.provider, currentModel.id) : undefined;
	const maxShown = 20;

	const lines = [
		`Current model: ${currentModelRef ?? "not selected"}`,
		"Use /model <provider/model> to switch.",
		"",
		`Allowlisted models (${defaultModelSelections.length}; available now: ${availableCount}):`,
	];

	for (const entry of allowlistedModels.slice(0, maxShown)) {
		const isCurrent =
			currentModelRef !== undefined &&
			normalizeModelRef(entry.ref) === normalizeModelRef(currentModelRef);
		const suffix = isCurrent ? " (current)" : entry.model ? "" : " (unavailable)";
		lines.push(`- ${entry.ref}${suffix}`);
	}

	if (allowlistedModels.length > maxShown) {
		lines.push(`- ...and ${allowlistedModels.length - maxShown} more`);
	}

	return truncateTelegramMessage(lines.join("\n"));
}

function formatDisallowedModelMessage(requestedModelRef: string) {
	const lines = [
		`Model is not allowlisted: ${requestedModelRef}`,
		"Usage: /model <provider/model>",
		"",
		`Allowed models (${defaultModelSelections.length}):`,
		formatAllowlistedModels(20),
	];

	return truncateTelegramMessage(lines.join("\n"));
}

function formatUnavailableAllowlistedModelMessage(requestedModelRef: string) {
	const lines = [
		`Model is allowlisted but not currently available: ${requestedModelRef}`,
		"Check API keys for that provider and try again.",
		"",
		`Allowed models (${defaultModelSelections.length}):`,
		formatAllowlistedModels(20),
	];

	return truncateTelegramMessage(lines.join("\n"));
}

async function ensureAllowlistedStartupModel() {
	const currentModel = session.model;
	const currentRef = currentModel ? toModelRef(currentModel.provider, currentModel.id) : undefined;
	if (currentRef && defaultModelSelectionLookup.has(normalizeModelRef(currentRef))) {
		return;
	}

	const allowlistedModels = await getAllowlistedModels();
	const firstAvailable = allowlistedModels.find((entry) => entry.model)?.model;
	if (!firstAvailable) {
		logger.warn("no allowlisted models are currently available; leaving model unchanged", {
			configPath: "models.json",
		});
		return;
	}

	await session.setModel(firstAvailable);
	logger.info("session model set from allowlist", {
		selectedModel: toModelRef(firstAvailable.provider, firstAvailable.id),
		previousModel: currentRef ?? "not selected",
		configPath: "models.json",
	});
}

async function formatCurrentSkills() {
	try {
		await resourceLoader.reload();
	} catch (error) {
		logger.warn("failed to reload skills before /skills command", error);
	}

	const { skills, diagnostics } = resourceLoader.getSkills();
	if (skills.length === 0) {
		const diagnosticText =
			diagnostics.length > 0
				? `\nDiagnostics:\n${diagnostics.map((item) => `- ${formatResourceDiagnostic(item)}`).join("\n")}`
				: "";
		return `No skills discovered in the current workspace or agent directories.${diagnosticText}`;
	}

	const lines = [`Discovered skills (${skills.length}):`];
	for (const skill of skills) {
		const description = skill.description?.trim();
		lines.push(description ? `- ${skill.name}: ${description}` : `- ${skill.name}`);
	}

	if (diagnostics.length > 0) {
		const shownDiagnostics = diagnostics
			.slice(0, 5)
			.map((item) => `- ${formatResourceDiagnostic(item)}`);
		lines.push("");
		lines.push(`Diagnostics (${diagnostics.length}):`);
		lines.push(...shownDiagnostics);
		if (diagnostics.length > shownDiagnostics.length) {
			lines.push(`- ...and ${diagnostics.length - shownDiagnostics.length} more`);
		}
	}

	return truncateTelegramMessage(lines.join("\n"));
}

function formatCommandContext() {
	return truncateTelegramMessage(`# Available Tools & Skills

## Core Tools

1. **read** - Read file contents
   - Supports text files and images (jpg, png, gif, webp)
   - Can specify offset/limit for large files
   - Output truncated to 2000 lines or 50KB

2. **bash** - Execute bash commands
   - Can run ls, grep, find, and other shell commands
   - Optional timeout parameter
   - Output truncated to 2000 lines or 50KB

3. **edit** - Make surgical edits to files
   - Replace exact text (oldText must match exactly, including whitespace)
   - Precise, targeted changes
   - Requires exact matching of content to replace

4. **write** - Create or overwrite files
   - Creates parent directories automatically
   - Can create new files or completely rewrite existing ones

5. **schedule_task/list_scheduled_tasks/cancel_scheduled_task**
   - Schedule, inspect, and cancel chat notifications for the current Telegram chat
   - Supports recurring (interval_minutes) and one-time (delay_minutes or run_at_iso) reminders
   - Scoped by chat and optional thread id

## Specialized Skills

1. **git** - Day-to-day git workflows
   - Status checks, reviewing diffs
   - Creating focused commits
   - Safe branch operations
   - Documentation: ${join(process.cwd(), "skills/git/SKILL.md")}

2. **dropbox** - Session backup syncs to Dropbox
   - Upload local session data snapshots
   - Optional timestamped backup history
   - Metadata verification after upload
   - Documentation: ${join(process.cwd(), "skills/dropbox/SKILL.md")}

## Current Context

- **Working directory**: ${process.cwd()}
- **Current date**: ${new Date().toISOString().slice(0, 10)}
- **Project**: ${BOT_RUNTIME_NAME}`);
}

async function sendTelegramMessage(params: {
	chatId: number;
	text: string;
	messageThreadId?: number;
	replyToMessageId?: number;
	replyMarkup?: Record<string, unknown>;
}) {
	await telegramApi("sendMessage", {
		chat_id: params.chatId,
		text: params.text,
		message_thread_id: params.messageThreadId,
		reply_to_message_id: params.replyToMessageId,
		reply_markup: params.replyMarkup,
	});
}

async function configureTelegramCommandMenu() {
	const scopes = [{ type: "default" }, { type: "all_private_chats" }, { type: "all_group_chats" }];
	for (const scope of scopes) {
		await telegramApi("setMyCommands", {
			commands: BOT_COMMANDS,
			scope,
		});
	}
}

function buildStartMessage() {
	return [
		`${BOT_NAME} is connected. Send me a message and I will reply with the agent.`,
		"",
		"Menu",
		"📊 Status: /status /balance /usage /cost",
		"📈 Usage history: /usage [today|7d|30d|90d|all]",
		"🧠 Agent: /model /context /skills",
		"🔔 Chat pairing: /pair /unpair /pairings",
		"⏰ Schedules: /schedules /unschedule <id>",
	].join("\n");
}

async function handleTelegramCommand(params: {
	command: ParsedTelegramCommand;
	chatId: number;
	messageThreadId?: number;
	replyToMessageId?: number;
	sourceMessage?: { chat: { id: number }; message_thread_id?: number };
}) {
	const { command, chatId, messageThreadId, replyToMessageId, sourceMessage } = params;

	if (command.name === "start") {
		await sendTelegramMessage({
			chatId,
			messageThreadId,
			replyToMessageId,
			text: buildStartMessage(),
			replyMarkup: { remove_keyboard: true },
		});
		return true;
	}

	if (command.name === "status") {
		await sendTelegramMessage({
			chatId,
			messageThreadId,
			replyToMessageId,
			text: await formatStatusForTelegram(chatId, messageThreadId),
		});
		return true;
	}

	if (command.name === "usage" || command.name === "cost") {
		const windowArg = command.args.trim();
		let usageText: string;

		if (!windowArg) {
			usageText =
				openRouterUsageState.calls.length > 0
					? formatCurrentOpenRouterUsage()
					: "OpenRouter usage (current session)\nNo OpenRouter calls yet in this running session.\nTry /usage 30d or /usage all for saved history.";
		} else {
			try {
				const days = parseOpenRouterCostWindow(windowArg);
				if (days === null) {
					usageText = "OpenRouter usage\nUsage: /usage [today|7d|30d|90d|all]";
				} else {
					const summary = await inspectOpenRouterCost({ days: days ?? undefined });
					usageText = formatOpenRouterCostReport(summary);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message.trim() : String(error);
				usageText = [
					`OpenRouter usage`,
					message || "Invalid usage window.",
					"Try /usage 30d or /usage all.",
				].join("\n");
			}
		}

		await sendTelegramMessage({
			chatId,
			messageThreadId,
			replyToMessageId,
			text: usageText,
		});
		return true;
	}

	if (command.name === "balance" || command.name === "credits") {
		if (!process.env.OPENROUTER_API_KEY) {
			await sendTelegramMessage({
				chatId,
				messageThreadId,
				replyToMessageId,
				text: "OpenRouter balance is unavailable because no OpenRouter API key is configured.",
			});
			return true;
		}

		try {
			await sendTelegramMessage({
				chatId,
				messageThreadId,
				replyToMessageId,
				text: await buildOpenRouterBalanceReport({ apiKey: process.env.OPENROUTER_API_KEY }),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message.trim() : String(error);
			await sendTelegramMessage({
				chatId,
				messageThreadId,
				replyToMessageId,
				text: `Failed to load OpenRouter balance: ${message || "unknown error"}`,
			});
		}
		return true;
	}

	if (command.name === "model") {
		const requestedModelRef = command.args.trim().replace(/^-+\s*/, "");

		if (!requestedModelRef) {
			await sendTelegramMessage({
				chatId,
				messageThreadId,
				replyToMessageId,
				text: await formatModelSelectionHelp(),
			});
			return true;
		}

		const parsedModel = parseModelRef(requestedModelRef);
		if (!parsedModel) {
			await sendTelegramMessage({
				chatId,
				messageThreadId,
				replyToMessageId,
				text: "Invalid model format. Use /model <provider/model> (example: /model openai/gpt-5.4-pro).",
			});
			return true;
		}

		const requestedRef = toModelRef(parsedModel.provider, parsedModel.modelId);
		const configuredRef = defaultModelSelectionLookup.get(normalizeModelRef(requestedRef));
		if (!configuredRef) {
			await sendTelegramMessage({
				chatId,
				messageThreadId,
				replyToMessageId,
				text: formatDisallowedModelMessage(requestedRef),
			});
			return true;
		}

		const model = await resolveAvailableAllowlistedModel(configuredRef);
		if (!model) {
			await sendTelegramMessage({
				chatId,
				messageThreadId,
				replyToMessageId,
				text: formatUnavailableAllowlistedModelMessage(configuredRef),
			});
			return true;
		}

		try {
			await session.setModel(model);
		} catch (error) {
			const reason =
				error instanceof Error && error.message.trim().length > 0
					? error.message.trim()
					: "unknown error";
			await sendTelegramMessage({
				chatId,
				messageThreadId,
				replyToMessageId,
				text: `Failed to switch model to ${toModelRef(model.provider, model.id)}: ${reason}`,
			});
			return true;
		}

		await sendTelegramMessage({
			chatId,
			messageThreadId,
			replyToMessageId,
			text: [`Model switched to ${toModelRef(model.provider, model.id)}`, `Name: ${model.name}`].join(
				"\n",
			),
		});
		return true;
	}

	if (command.name === "context") {
		await sendTelegramMessage({
			chatId,
			messageThreadId,
			replyToMessageId,
			text: formatCommandContext(),
		});
		return true;
	}

	if (command.name === "pair") {
		if (!sourceMessage) {
			await sendTelegramMessage({
				chatId,
				messageThreadId,
				replyToMessageId,
				text: "Pairing is only available from a chat message right now. Send /pair in the chat to save it.",
			});
			return true;
		}
		const target = formatTelegramTargetFromMessage(sourceMessage);
		await addHeartbeatPairing(target);
		await sendTelegramMessage({
			chatId,
			messageThreadId,
			replyToMessageId,
			text: `Paired ${target} for startup and heartbeat delivery.`,
		});
		return true;
	}

	if (command.name === "skills") {
		await sendTelegramMessage({
			chatId,
			messageThreadId,
			replyToMessageId,
			text: await formatCurrentSkills(),
		});
		return true;
	}

	if (command.name === "unpair") {
		if (!sourceMessage) {
			await sendTelegramMessage({
				chatId,
				messageThreadId,
				replyToMessageId,
				text: "Unpairing is only available from a chat message right now. Send /unpair in the chat to remove it.",
			});
			return true;
		}
		const target = formatTelegramTargetFromMessage(sourceMessage);
		const store = await removeHeartbeatPairing(target);
		await sendTelegramMessage({
			chatId,
			messageThreadId,
			replyToMessageId,
			text:
				store.heartbeatTargets.length > 0
					? `Removed ${target}. Remaining pairings:\n${store.heartbeatTargets.join("\n")}`
					: `Removed ${target}. No saved pairings remain.`,
		});
		return true;
	}

	if (command.name === "pairings") {
		const pairings = await listHeartbeatPairings();
		await sendTelegramMessage({
			chatId,
			messageThreadId,
			replyToMessageId,
			text:
				pairings.length > 0
					? `Saved pairings:\n${pairings.join("\n")}`
					: "No saved pairings yet. Send /pair in the chat you want to notify on startup.",
		});
		return true;
	}

	if (command.name === "schedules") {
		await sendTelegramMessage({
			chatId,
			messageThreadId,
			replyToMessageId,
			text: formatScheduledTasksForTelegram(chatId, messageThreadId),
		});
		return true;
	}

	if (command.name === "unschedule") {
		const scheduleId = command.args.trim();
		if (!scheduleId) {
			await sendTelegramMessage({
				chatId,
				messageThreadId,
				replyToMessageId,
				text: "Usage: /unschedule <schedule_id>",
			});
			return true;
		}

		const result = notificationScheduler.cancelTask({
			id: scheduleId,
			chatId,
			messageThreadId,
		});
		await sendTelegramMessage({
			chatId,
			messageThreadId,
			replyToMessageId,
			text: result.removed
				? `Removed schedule ${scheduleId}.`
				: `No schedule found for id ${scheduleId} in this chat.`,
		});
		return true;
	}

	return false;
}

function buildStartupText() {
	return [
		`STARTUP NOTICE: ${BOT_NAME} bot is now online.`,
		`Started at: ${processStartedAt.toISOString()}`,
		buildStartupIdentityText(agentVersion),
		buildHeartbeatText(agentVersion),
		`Heartbeat: ${(credentials.tg?.heartbeat_enabled ?? true) ? "enabled" : "disabled"} (every ${credentials.tg?.heartbeat_interval_minutes ?? 5}m).`,
		`Saved pairings will receive startup messages.`,
	].join("\n");
}

try {
	const result = await telegramApi<unknown>("deleteWebhook", {});
	logger.info(
		"deleteWebhook completed",
		typeof result === "object" ? result : { result: String(result) },
	);
} catch (error) {
	logger.warn("deleteWebhook failed; continuing anyway", error);
}

try {
	await configureTelegramCommandMenu();
	logger.info("telegram commands configured", { commandCount: BOT_COMMANDS.length });
} catch (error) {
	logger.warn("failed to configure Telegram command menu; continuing anyway", error);
}

try {
	await ensureAllowlistedStartupModel();
} catch (error) {
	logger.warn("failed to enforce allowlisted startup model; continuing anyway", error);
}

logger.info(`${BOT_NAME} Telegram bot started`);

const heartbeat = startHeartbeatLoop({
	enabled: credentials.tg?.heartbeat_enabled ?? true,
	intervalMinutes: credentials.tg?.heartbeat_interval_minutes ?? 5,
	initialChatTargets: await resolveHeartbeatTargets(credentials.tg?.heartbeat_chat_ids ?? []),
	agentVersion,
	logger: heartbeatLogger,
	sendTelegramMessage,
});

notificationScheduler.start();


session.subscribe((event) => {
	if (event.type !== "message_end") {
		return;
	}

	const message = event.message;
	if (message.role !== "assistant") {
		return;
	}

	recordOpenRouterUsage(message as { provider?: string; model?: string; usage?: UsageRecord });
});

const startupMessage = buildStartupText();
const startupPairings = await listHeartbeatPairings();
if (startupPairings.length > 0) {
	for (const rawTarget of startupPairings) {
		try {
			const target = parseTelegramTarget(rawTarget);
			await sendTelegramMessage({
				chatId: target.baseChatId,
				messageThreadId: target.messageThreadId,
				text: startupMessage,
				replyMarkup: { remove_keyboard: true },
			});
			logger.info("startup message sent", { chatId: target.baseChatId, target: rawTarget });
		} catch (error) {
			logger.warn(`invalid startup pairing "${rawTarget}"`, error);
		}
	}
} else {
	logger.info("no saved pairings found; skipping startup message");
}

let offset = 0;

while (true) {
	try {
		const updates = await telegramApi<TelegramUpdate[]>("getUpdates", {
			offset,
			timeout: 30,
			allowed_updates: ["message"],
		});

		for (const update of updates) {
			offset = Math.max(offset, update.update_id + 1);

			const message = update.message;

			if (!message?.text?.trim() || message.from?.is_bot) {
				continue;
			}

			try {
				heartbeat.observeChat(message.chat.id, message.message_thread_id);
				logger.info("message received", {
					chatId: message.chat.id,
					messageId: message.message_id,
					});

					const text = message.text.trim();
					const command = parseTelegramCommand(text);
					if (command) {
						const handled = await handleTelegramCommand({
							command,
							chatId: message.chat.id,
							messageThreadId: message.message_thread_id,
							replyToMessageId: message.message_id,
							sourceMessage: message,
						});
						if (handled) {
							continue;
						}
					}

				const reply = await promptAgent(text, {
					chatId: message.chat.id,
					messageThreadId: message.message_thread_id,
				});
				await sendTelegramMessage({
					chatId: message.chat.id,
					messageThreadId: message.message_thread_id,
					replyToMessageId: message.message_id,
					text: reply,
				});
				logger.info("reply sent", {
					chatId: message.chat.id,
					messageId: message.message_id,
				});
			} catch (error) {
				logger.error("failed to handle message", {
					chatId: message.chat.id,
					messageId: message.message_id,
					error: error instanceof Error ? error.message : String(error),
				});
				try {
					await sendTelegramMessage({
						chatId: message.chat.id,
						messageThreadId: message.message_thread_id,
						replyToMessageId: message.message_id,
						text: formatPromptFailureForTelegram(error),
					});
				} catch (replyError) {
					logger.error("failed to send error reply", replyError);
				}
			}
		}
	} catch (error) {
		if (isTelegramGetUpdatesConflict(error)) {
			logger.error(
				"getUpdates conflict detected; another bot process is already polling this token or a webhook is still active",
				error,
			);
			throw error;
		}
		logger.error("poll failed", error);
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
}
