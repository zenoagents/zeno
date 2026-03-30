import { formatOpenRouterCostReport, inspectOpenRouterCost } from "../openrouter-cost.js";

const rawArg = process.argv[2]?.trim().toLowerCase();

function parseDays(input: string | undefined): number | undefined {
	if (!input || input === "7" || input === "7d") {
		return 7;
	}
	if (input === "today" || input === "24h" || input === "1d") {
		return 1;
	}
	if (input === "all") {
		return undefined;
	}

	const match = input.match(/^(\d+)(?:\s*d(?:ays?)?)?$/i);
	if (!match) {
		console.error("Usage: npm run cost:openrouter -- [today|7d|30d|all]");
		process.exit(1);
	}

	const days = Number.parseInt(match[1], 10);
	if (!Number.isFinite(days) || days <= 0) {
		console.error("Days must be a positive integer.");
		process.exit(1);
	}

	return days;
}

const summary = await inspectOpenRouterCost({ days: parseDays(rawArg) });
console.log(formatOpenRouterCostReport(summary));
