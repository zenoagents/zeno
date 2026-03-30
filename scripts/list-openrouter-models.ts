import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

const provider = "openrouter";
const authStorage = AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);

const allModels = modelRegistry
	.getAll()
	.filter((model) => model.provider === provider)
	.sort((a, b) => a.id.localeCompare(b.id));

const availableModelIds = new Set(
	(await modelRegistry.getAvailable())
		.filter((model) => model.provider === provider)
		.map((model) => model.id),
);

console.log(`Provider: ${provider}`);
console.log(`Configured key: ${process.env.OPENROUTER_API_KEY ? "yes" : "no"}`);
console.log(`Known models: ${allModels.length}`);
console.log(`Available models: ${availableModelIds.size}`);
console.log();

for (const model of allModels) {
	const availability = availableModelIds.has(model.id) ? "available" : "no-key";
	const reasoning = model.reasoning ? "reasoning" : "standard";
	console.log(`${model.id}\t${availability}\t${reasoning}\t${model.name}`);
}
