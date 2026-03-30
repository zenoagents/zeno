import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const defaultLogFilePath = join(process.cwd(), "logs", "agent.log");

type LogLevel = "info" | "warn" | "error";

export type Logger = {
	logFilePath: string;
	info(message: string, details?: unknown): void;
	warn(message: string, details?: unknown): void;
	error(message: string, details?: unknown): void;
};

function formatDetails(details: unknown) {
	if (details === undefined) {
		return "";
	}

	if (details instanceof Error) {
		return details.stack ?? `${details.name}: ${details.message}`;
	}

	if (typeof details === "string") {
		return details;
	}

	try {
		return JSON.stringify(details);
	} catch {
		return String(details);
	}
}

function formatLine(scope: string, level: LogLevel, message: string, details?: unknown) {
	const parts = [`[${new Date().toISOString()}]`, `[${scope}]`, `[${level}]`, message];
	const formattedDetails = formatDetails(details);
	if (formattedDetails) {
		parts.push(formattedDetails);
	}
	return parts.join(" ");
}

function consoleMethod(level: LogLevel) {
	if (level === "warn") {
		return console.warn.bind(console);
	}
	if (level === "error") {
		return console.error.bind(console);
	}
	return console.log.bind(console);
}

export function createLogger(scope: string, logFilePath = defaultLogFilePath): Logger {
	mkdirSync(dirname(logFilePath), { recursive: true });

	const write = (level: LogLevel, message: string, details?: unknown) => {
		const line = formatLine(scope, level, message, details);
		consoleMethod(level)(line);
		appendFileSync(logFilePath, `${line}\n`, "utf8");
	};

	return {
		logFilePath,
		info(message: string, details?: unknown) {
			write("info", message, details);
		},
		warn(message: string, details?: unknown) {
			write("warn", message, details);
		},
		error(message: string, details?: unknown) {
			write("error", message, details);
		},
	};
}
