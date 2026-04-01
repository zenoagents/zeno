const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const DEFAULT_CACHE_TTL_MS = 60_000;

export type OpenRouterBalanceSummary = {
	totalCredits: number;
	totalUsage: number;
	remainingCredits: number;
	retrievedAt: string;
};

type OpenRouterCreditsResponse = {
	data?: {
		total_credits?: number;
		total_usage?: number;
	};
};

type CachedBalance = {
	apiKey: string;
	expiresAt: number;
	summary: OpenRouterBalanceSummary;
};

let cachedBalance: CachedBalance | undefined;

export function formatOpenRouterAmount(value: number) {
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

function formatTimestamp(raw: string) {
	const date = new Date(raw);
	if (Number.isNaN(date.getTime())) {
		return raw;
	}
	return date.toISOString().replace(".000Z", "Z");
}

function parseNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function inspectOpenRouterBalance(params?: {
	apiKey?: string;
	cacheTtlMs?: number;
	useCache?: boolean;
}): Promise<OpenRouterBalanceSummary> {
	const apiKey = params?.apiKey?.trim();
	if (!apiKey) {
		throw new Error("OpenRouter API key is missing.");
	}

	const now = Date.now();
	if (params?.useCache !== false && cachedBalance && cachedBalance.apiKey === apiKey) {
		if (cachedBalance.expiresAt > now) {
			return cachedBalance.summary;
		}
	}

	const response = await fetch(OPENROUTER_CREDITS_URL, {
		method: "GET",
		headers: {
			authorization: `Bearer ${apiKey}`,
			accept: "application/json",
		},
		signal: AbortSignal.timeout(10_000),
	});

	if (!response.ok) {
		let details = "";
		try {
			details = (await response.text()).trim();
		} catch {
			// Ignore response body read failures and keep the status code.
		}
		throw new Error(
			`OpenRouter credits HTTP ${response.status}${details ? `: ${details}` : ""}. A management key is required.`,
		);
	}

	const payload = (await response.json()) as OpenRouterCreditsResponse;
	const totalCredits = parseNumber(payload.data?.total_credits);
	const totalUsage = parseNumber(payload.data?.total_usage);

	if (totalCredits === undefined || totalUsage === undefined) {
		throw new Error("OpenRouter credits response was missing total_credits or total_usage.");
	}

	const summary: OpenRouterBalanceSummary = {
		totalCredits,
		totalUsage,
		remainingCredits: Math.max(0, totalCredits - totalUsage),
		retrievedAt: new Date().toISOString(),
	};

	cachedBalance = {
		apiKey,
		expiresAt: now + (params?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS),
		summary,
	};

	return summary;
}

export function formatOpenRouterBalanceReport(summary: OpenRouterBalanceSummary) {
	const lines = [
		"OpenRouter balance",
		`Remaining: ${formatOpenRouterAmount(summary.remainingCredits)}`,
		`Total credits: ${formatOpenRouterAmount(summary.totalCredits)}`,
		`Used: ${formatOpenRouterAmount(summary.totalUsage)}`,
		`Retrieved: ${formatTimestamp(summary.retrievedAt)}`,
		"Note: OpenRouter credits can be up to 60 seconds stale.",
	];

	return lines.join("\n");
}

export async function buildOpenRouterBalanceReport(params?: {
	apiKey?: string;
	cacheTtlMs?: number;
	useCache?: boolean;
}) {
	const summary = await inspectOpenRouterBalance(params);
	return formatOpenRouterBalanceReport(summary);
}
