import { AuthStorage, ModelRegistry, SettingsManager } from "@mariozechner/pi-coding-agent";
import {
	buildAllowlistedModelLookup,
	getAllowlistedModelRefCandidates,
	loadDefaultModelSelections,
	normalizeModelRef,
} from "../models.js";

const input = process.argv[2];
const defaultModelSelections = await loadDefaultModelSelections();
const allowlistedLookup = buildAllowlistedModelLookup(defaultModelSelections);

if (!input) {
	console.error("Usage: npm run model:set-default -- <provider/model>");
	console.error("Example: npm run model:set-default -- openai/gpt-5.4-pro");
	console.error("\nAllowed models:");
	for (const modelRef of defaultModelSelections) {
		console.error(`- ${modelRef}`);
	}
	process.exit(1);
}

const slashIndex = input.indexOf("/");
if (slashIndex <= 0 || slashIndex === input.length - 1) {
	console.error(`Invalid model "${input}". Expected format: provider/model`);
	process.exit(1);
}

const provider = input.slice(0, slashIndex);
const modelId = input.slice(slashIndex + 1);
const requestedRef = `${provider}/${modelId}`;

const configuredAllowlistRef = allowlistedLookup.get(normalizeModelRef(requestedRef));
if (!configuredAllowlistRef) {
	console.error(`Model is not allowlisted in models.json: ${requestedRef}`);
	console.error("Allowed models:");
	for (const modelRef of defaultModelSelections) {
		console.error(`- ${modelRef}`);
	}
	process.exit(1);
}

const authStorage = AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);
const availableModels = await modelRegistry.getAvailable();
const availableByRef = new Map(
	availableModels.map((model) => [normalizeModelRef(`${model.provider}/${model.id}`), model]),
);
const model = getAllowlistedModelRefCandidates(configuredAllowlistRef)
	.map((candidateRef) => availableByRef.get(normalizeModelRef(candidateRef)))
	.find((candidate) => candidate !== undefined);

if (!model) {
	console.error(`Model is allowlisted but not available with current API keys: ${configuredAllowlistRef}`);
	process.exit(1);
}

const settingsManager = SettingsManager.create(process.cwd());
settingsManager.setDefaultModelAndProvider(model.provider, model.id);
await settingsManager.flush();

const errors = settingsManager.drainErrors();
if (errors.length > 0) {
	for (const { scope, error } of errors) {
		console.error(`[${scope}] ${error.message}`);
	}
	process.exit(1);
}

console.log(`Default model set to ${model.provider}/${model.id}`);
if (`${model.provider}/${model.id}` !== configuredAllowlistRef) {
	console.log(`Allowlist entry: ${configuredAllowlistRef}`);
}
console.log(`Name: ${model.name}`);
