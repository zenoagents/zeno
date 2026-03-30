import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const logFile = join(process.cwd(), ".pi", "prompt-api.log");
	mkdirSync(dirname(logFile), { recursive: true });

	// Raw user prompt
	pi.on("before_agent_start", (event) => {
		appendFileSync(
			logFile,
			JSON.stringify(
				{ ts: new Date().toISOString(), type: "before_agent_start", prompt: event.prompt },
				null,
				2,
			) + "\n\n",
			"utf8",
		);
	});

	// Final provider payload sent to API
	pi.on("before_provider_request", (event) => {
		appendFileSync(
			logFile,
			JSON.stringify(
				{ ts: new Date().toISOString(), type: "before_provider_request", payload: event.payload },
				null,
				2,
			) + "\n\n",
			"utf8",
		);
	});
}
