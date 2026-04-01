import assert from "node:assert/strict";
import test from "node:test";
import {
	buildOpenRouterBalanceReport,
	inspectOpenRouterBalance,
} from "./openrouter-balance.js";

test("formats the OpenRouter balance from the credits endpoint", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				data: {
					total_credits: 50,
					total_usage: 42,
				},
			}),
			{
				status: 200,
				headers: {
					"content-type": "application/json",
				},
			},
		);

	try {
		const summary = await inspectOpenRouterBalance({
			apiKey: "sk-or-v1-test",
			useCache: false,
		});

		assert.equal(summary.totalCredits, 50);
		assert.equal(summary.totalUsage, 42);
		assert.equal(summary.remainingCredits, 8);

		const report = await buildOpenRouterBalanceReport({
			apiKey: "sk-or-v1-test",
			useCache: false,
		});

		assert.match(report, /OpenRouter balance/);
		assert.match(report, /Remaining: \$8\.00/);
		assert.match(report, /Total credits: \$50\.00/);
		assert.match(report, /Used: \$42\.00/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("rejects balance checks without an API key", async () => {
	await assert.rejects(inspectOpenRouterBalance(), /OpenRouter API key is missing\./);
});
