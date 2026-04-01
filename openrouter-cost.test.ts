import assert from "node:assert/strict";
import test from "node:test";
import { parseOpenRouterCostWindow } from "./openrouter-cost.js";

test("parses OpenRouter usage windows", () => {
	assert.equal(parseOpenRouterCostWindow(), null);
	assert.equal(parseOpenRouterCostWindow("30d"), 30);
	assert.equal(parseOpenRouterCostWindow("90"), 90);
	assert.equal(parseOpenRouterCostWindow("all"), undefined);
	assert.equal(parseOpenRouterCostWindow("today"), 1);
});

test("rejects invalid usage windows", () => {
	assert.throws(() => parseOpenRouterCostWindow("yesterday"), /Usage: \[today\|7d\|30d\|all\]/);
});
