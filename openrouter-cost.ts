import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const usageLogPath = join(process.cwd(), "usage", "agent-usage.jsonl");
const DEFAULT_TOP_BREAKDOWN = 5;

export type UsageRecord = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
};

type UsageLogEntry = {
	timestamp?: string;
	command?: string;
	provider?: string;
	model?: string;
	assistantMessages?: number;
	usage?: Partial<UsageRecord>;
};

type CostBreakdown = {
	key: string;
	runs: number;
	assistantMessages: number;
	totalTokens: number;
	totalCost: number;
};

export type OpenRouterCostSummary = {
	windowLabel: string;
	days?: number;
	entryCount: number;
	assistantMessages: number;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalCost: number;
	inputCost: number;
	outputCost: number;
	cacheReadCost: number;
	cacheWriteCost: number;
	firstTimestamp?: string;
	lastTimestamp?: string;
	models: CostBreakdown[];
	commands: CostBreakdown[];
};

function emptyUsage(): UsageRecord {
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

function sortBreakdowns(map: Map<string, CostBreakdown>) {
	return [...map.values()]
		.sort((a, b) => {
			if (b.totalCost !== a.totalCost) {
				return b.totalCost - a.totalCost;
			}
			if (b.totalTokens !== a.totalTokens) {
				return b.totalTokens - a.totalTokens;
			}
			return a.key.localeCompare(b.key);
		});
}

function updateBreakdown(
	map: Map<string, CostBreakdown>,
	key: string | undefined,
	params: { assistantMessages: number; totalTokens: number; totalCost: number },
) {
	const normalizedKey = key?.trim() || "unknown";
	const current =
		map.get(normalizedKey) ??
		{
			key: normalizedKey,
			runs: 0,
			assistantMessages: 0,
			totalTokens: 0,
			totalCost: 0,
		};

	current.runs += 1;
	current.assistantMessages += params.assistantMessages;
	current.totalTokens += params.totalTokens;
	current.totalCost += params.totalCost;
	map.set(normalizedKey, current);
}

function formatTimestamp(raw: string | undefined) {
	if (!raw) return undefined;
	const date = new Date(raw);
	if (Number.isNaN(date.getTime())) {
		return raw;
	}
	return date.toISOString().replace(".000Z", "Z");
}

export async function inspectOpenRouterCost(params?: {
	days?: number;
	now?: Date;
}): Promise<OpenRouterCostSummary> {
	const usage = emptyUsage();
	const modelBreakdown = new Map<string, CostBreakdown>();
	const commandBreakdown = new Map<string, CostBreakdown>();
	const now = params?.now ?? new Date();
	const minTimestamp =
		typeof params?.days === "number" && params.days > 0
			? now.getTime() - params.days * 24 * 60 * 60 * 1000
			: undefined;

	let raw = "";
	try {
		raw = await readFile(usageLogPath, "utf8");
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code !== "ENOENT") {
			throw error;
		}
	}

	let entryCount = 0;
	let assistantMessages = 0;
	let firstTimestamp: string | undefined;
	let lastTimestamp: string | undefined;

	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let entry: UsageLogEntry;
		try {
			entry = JSON.parse(trimmed) as UsageLogEntry;
		} catch {
			continue;
		}

		if (entry.provider !== "openrouter") {
			continue;
		}

		const timestamp = entry.timestamp ? new Date(entry.timestamp) : undefined;
		if (minTimestamp !== undefined) {
			if (!timestamp || Number.isNaN(timestamp.getTime()) || timestamp.getTime() < minTimestamp) {
				continue;
			}
		}

		entryCount += 1;
		assistantMessages += entry.assistantMessages ?? 0;
		firstTimestamp ??= entry.timestamp;
		lastTimestamp = entry.timestamp ?? lastTimestamp;

		const record = entry.usage ?? {};
		const entryInput = record.input ?? 0;
		const entryOutput = record.output ?? 0;
		const entryCacheRead = record.cacheRead ?? 0;
		const entryCacheWrite = record.cacheWrite ?? 0;
		const entryTotalTokens =
			record.totalTokens ?? entryInput + entryOutput + entryCacheRead + entryCacheWrite;
		const entryInputCost = record.cost?.input ?? 0;
		const entryOutputCost = record.cost?.output ?? 0;
		const entryCacheReadCost = record.cost?.cacheRead ?? 0;
		const entryCacheWriteCost = record.cost?.cacheWrite ?? 0;
		const entryTotalCost =
			record.cost?.total ??
			entryInputCost + entryOutputCost + entryCacheReadCost + entryCacheWriteCost;

		usage.input += entryInput;
		usage.output += entryOutput;
		usage.cacheRead += entryCacheRead;
		usage.cacheWrite += entryCacheWrite;
		usage.totalTokens += entryTotalTokens;
		usage.cost.input += entryInputCost;
		usage.cost.output += entryOutputCost;
		usage.cost.cacheRead += entryCacheReadCost;
		usage.cost.cacheWrite += entryCacheWriteCost;
		usage.cost.total += entryTotalCost;

		updateBreakdown(modelBreakdown, entry.model, {
			assistantMessages: entry.assistantMessages ?? 0,
			totalTokens: entryTotalTokens,
			totalCost: entryTotalCost,
		});
		updateBreakdown(commandBreakdown, entry.command, {
			assistantMessages: entry.assistantMessages ?? 0,
			totalTokens: entryTotalTokens,
			totalCost: entryTotalCost,
		});
	}

	return {
		windowLabel:
			typeof params?.days === "number" && params.days > 0 ? `last ${params.days}d` : "all time",
		days: params?.days,
		entryCount,
		assistantMessages,
		totalTokens: usage.totalTokens,
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		totalCost: usage.cost.total,
		inputCost: usage.cost.input,
		outputCost: usage.cost.output,
		cacheReadCost: usage.cost.cacheRead,
		cacheWriteCost: usage.cost.cacheWrite,
		firstTimestamp: formatTimestamp(firstTimestamp),
		lastTimestamp: formatTimestamp(lastTimestamp),
		models: sortBreakdowns(modelBreakdown),
		commands: sortBreakdowns(commandBreakdown),
	};
}

export function formatOpenRouterCostReport(
	summary: OpenRouterCostSummary,
	params?: { topBreakdown?: number },
) {
	const topBreakdown = params?.topBreakdown ?? DEFAULT_TOP_BREAKDOWN;
	const lines = [`OpenRouter cost (${summary.windowLabel})`];

	if (summary.entryCount === 0) {
		lines.push(`No OpenRouter usage records found in ${usageLogPath}.`);
		return lines.join("\n");
	}

	lines.push(
		`Runs ${summary.entryCount} | assistant msgs ${summary.assistantMessages} | total ${formatUsd(summary.totalCost)}`,
	);
	lines.push(
		`Tokens in ${formatCompactNumber(summary.inputTokens)} out ${formatCompactNumber(summary.outputTokens)} cache ${formatCompactNumber(summary.cacheReadTokens + summary.cacheWriteTokens)} tot ${formatCompactNumber(summary.totalTokens)}`,
	);
	lines.push(
		`Cost in ${formatUsd(summary.inputCost)} out ${formatUsd(summary.outputCost)} cache ${formatUsd(summary.cacheReadCost + summary.cacheWriteCost)}`,
	);

	if (summary.firstTimestamp && summary.lastTimestamp) {
		lines.push(`Span ${summary.firstTimestamp} -> ${summary.lastTimestamp}`);
	}

	const topModels = summary.models.slice(0, topBreakdown);
	if (topModels.length > 0) {
		lines.push("");
		lines.push("Top models:");
		for (const item of topModels) {
			lines.push(
				`- ${item.key}: ${formatUsd(item.totalCost)} | ${item.runs} runs | ${formatCompactNumber(item.totalTokens)} tok`,
			);
		}
	}

	const topCommands = summary.commands.slice(0, topBreakdown);
	if (topCommands.length > 0) {
		lines.push("");
		lines.push("Top commands:");
		for (const item of topCommands) {
			lines.push(
				`- ${item.key}: ${formatUsd(item.totalCost)} | ${item.runs} runs | ${formatCompactNumber(item.totalTokens)} tok`,
			);
		}
	}

	return lines.join("\n");
}
