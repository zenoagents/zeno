import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const modelsConfigPath = join(process.cwd(), "models.json");

type ModelsConfig = {
	defaultSelections?: unknown;
};

function asModelRefList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const refs = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);

	return [...new Set(refs)];
}

export function normalizeModelRef(ref: string) {
	return ref.trim().toLowerCase();
}

export function getAllowlistedModelRefCandidates(ref: string): string[] {
	const trimmed = ref.trim();
	if (!trimmed) {
		return [];
	}

	const normalized = normalizeModelRef(trimmed);
	if (normalized.startsWith("openrouter/")) {
		const alias = normalized.slice("openrouter/".length);
		return alias ? [normalized, alias] : [normalized];
	}

	return [normalized, normalizeModelRef(`openrouter/${trimmed}`)];
}

export function buildAllowlistedModelLookup(allowlistedRefs: readonly string[]) {
	const lookup = new Map<string, string>();
	for (const configuredRef of allowlistedRefs) {
		for (const candidateRef of getAllowlistedModelRefCandidates(configuredRef)) {
			lookup.set(candidateRef, configuredRef);
		}
	}
	return lookup;
}

export async function loadDefaultModelSelections(): Promise<string[]> {
	try {
		const raw = await readFile(modelsConfigPath, "utf8");
		const parsed = JSON.parse(raw) as ModelsConfig;
		const refs = asModelRefList(parsed.defaultSelections);
		if (refs.length === 0) {
			throw new Error(
				`Invalid models.json: "defaultSelections" must be a non-empty array of provider/model strings.`,
			);
		}
		return refs;
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code === "ENOENT") {
			throw new Error(`Missing models config file at ${modelsConfigPath}`);
		}
		if (error instanceof SyntaxError) {
			throw new Error(`Invalid JSON in ${modelsConfigPath}: ${error.message}`);
		}
		throw error;
	}
}

export function isModelAllowed(ref: string, allowedRefs: readonly string[]) {
	const normalized = normalizeModelRef(ref);
	const lookup = buildAllowlistedModelLookup(allowedRefs);
	return lookup.has(normalized);
}
