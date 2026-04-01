import {
	formatOpenRouterCostReport,
	inspectOpenRouterCost,
	parseOpenRouterCostWindow,
} from "../openrouter-cost.js";

const rawArg = process.argv[2]?.trim().toLowerCase();
let days: number | undefined;
try {
	days = rawArg ? parseOpenRouterCostWindow(rawArg) ?? 7 : 7;
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	console.error("Usage: npm run cost:openrouter -- [today|7d|30d|all]");
	process.exit(1);
}

const summary = await inspectOpenRouterCost({ days });
console.log(formatOpenRouterCostReport(summary));
