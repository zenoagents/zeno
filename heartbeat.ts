import { hostname } from "node:os";
import { BOT_SLUG } from "./branding.js";
import type { Logger } from "./logging.js";

export type HeartbeatTarget = {
	chatId: number;
	messageThreadId?: number;
};

export type HeartbeatReportContext = {
	agentVersion: string;
	now: Date;
	target: HeartbeatTarget;
};

type BuildReportMessage = (context: HeartbeatReportContext) => Promise<string> | string;

type ScheduledReportEntry = {
	id: string;
	label: string;
	frequencyMs: number;
	nextRun: number;
	buildMessage: BuildReportMessage;
};

export type HeartbeatReportHandle = {
	cancel(): void;
};

type ScheduleReportOptions = {
	label?: string;
	frequencyMinutes: number;
	buildMessage: BuildReportMessage;
	initialDelayMinutes?: number;
	runImmediately?: boolean;
};

export type HeartbeatManager = {
	observeChat(chatId: number, messageThreadId?: number): void;
	stop(): void;
	scheduleReport(options: ScheduleReportOptions): HeartbeatReportHandle;
};

export function formatUptime(totalSeconds: number) {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	if (hours > 0) {
		const remainingMinutes = minutes % 60;
		const remainingSeconds = seconds % 60;
		return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`;
	}

	if (minutes > 0) {
		const remainingSeconds = seconds % 60;
		return `${minutes}m ${remainingSeconds}s`;
	}

	return `${seconds}s`;
}

export function buildHeartbeatText(agentVersion: string) {
	return `${BOT_SLUG} alive ${new Date().toISOString()} uptime ${formatUptime(process.uptime())}`;
}

export function buildStartupIdentityText(agentVersion: string) {
	return `${BOT_SLUG} ${agentVersion} on ${hostname()}`;
}

export function startHeartbeatLoop(params: {
	enabled?: boolean;
	intervalMinutes: number;
	initialChatTargets?: HeartbeatTarget[];
	agentVersion: string;
	logger: Logger;
	sendTelegramMessage: (params: { chatId: number; text: string; messageThreadId?: number }) => Promise<void>;
}): HeartbeatManager {
	if (params.enabled === false) {
		params.logger.info("heartbeat disabled");
		return {
			observeChat() {},
			stop() {},
			scheduleReport(_options: ScheduleReportOptions) {
				return { cancel() {} };
			},
		};
	}

	const observedTargets = new Set<string>(
		(params.initialChatTargets ?? []).map((target) => targetKey(target.chatId, target.messageThreadId)),
	);
	const chatQueues = new Map<string, Promise<void>>();
	const intervalMs = Math.max(1, Math.floor(params.intervalMinutes)) * 60_000;
	let schedulerInFlight = false;
	const scheduledReports = new Map<string, ScheduledReportEntry>();
	let nextReportId = 0;
	let reportInFlight = false;

	params.logger.info("heartbeat initialized", {
		enabled: true,
		intervalMinutes: Math.max(1, Math.floor(params.intervalMinutes)),
		observedChats: [...observedTargets],
	});

	const timer = setInterval(() => {
		void runSchedulerCycle();
		void runReportSchedulerCycle();
	}, intervalMs);

	const enqueue = (target: HeartbeatTarget, task: () => Promise<void>) => {
		const key = targetKey(target.chatId, target.messageThreadId);
		const previous = chatQueues.get(key) ?? Promise.resolve();
		let current: Promise<void>;

		current = previous
			.catch(() => {})
			.then(task)
			.finally(() => {
				if (chatQueues.get(key) === current) {
					chatQueues.delete(key);
				}
			});

		chatQueues.set(key, current);
		return current;
	};

	const queueReportForEntry = (entry: ScheduledReportEntry) => {
		if (observedTargets.size === 0) {
			return;
		}

		const runTimestamp = new Date();
		for (const rawTarget of observedTargets) {
			const target = parseTargetKey(rawTarget);
			void enqueue(target, async () => {
				try {
					const message = await entry.buildMessage({
						agentVersion: params.agentVersion,
						now: runTimestamp,
						target,
					});
					await params.sendTelegramMessage({
						chatId: target.chatId,
						messageThreadId: target.messageThreadId,
						text: message,
					});
					params.logger.info("scheduled report sent", {
						label: entry.label,
						chatId: target.chatId,
						messageThreadId: target.messageThreadId,
					});
				} catch (error) {
					params.logger.error(`scheduled report failed for ${entry.label} on chat ${target.chatId}`, error);
				}
			});
		}
	};

	const runReportSchedulerCycle = async () => {
		if (scheduledReports.size === 0) {
			return;
		}

		if (reportInFlight) {
			params.logger.warn("scheduled report cycle skipped because a previous cycle is still running");
			return;
		}

		reportInFlight = true;
		try {
			const now = Date.now();
			const dueEntries: ScheduledReportEntry[] = [];

			for (const entry of scheduledReports.values()) {
				if (entry.nextRun > now) {
					continue;
				}

				dueEntries.push(entry);
				entry.nextRun = now + entry.frequencyMs;
			}

			if (dueEntries.length === 0) {
				return;
			}

			params.logger.info("scheduled report cycle started", {
				dueReportLabels: dueEntries.map((entry) => entry.label),
				observedChats: observedTargets.size,
			});

			for (const entry of dueEntries) {
				queueReportForEntry(entry);
			}
		} finally {
			reportInFlight = false;
		}
	};

	const scheduleReport = (options: ScheduleReportOptions): HeartbeatReportHandle => {
		const frequencyMinutes = Math.max(1, Math.floor(options.frequencyMinutes));
		const frequencyMs = frequencyMinutes * 60_000;
		const normalizedLabel = (options.label?.trim() || "report").replace(/\s+/g, "-").toLowerCase();
		const initialDelayMinutes =
			options.initialDelayMinutes === undefined ? frequencyMinutes : options.initialDelayMinutes;
		const initialDelayMs = Math.max(0, Math.floor(initialDelayMinutes) * 60_000);

		const entry: ScheduledReportEntry = {
			id: `${normalizedLabel}:${nextReportId++}`,
			label: normalizedLabel || "report",
			frequencyMs,
			nextRun: Date.now() + initialDelayMs,
			buildMessage: options.buildMessage,
		};

		scheduledReports.set(entry.id, entry);
		params.logger.info("scheduled report registered", {
			id: entry.id,
			label: entry.label,
			frequencyMinutes,
		});

		if (options.runImmediately) {
			entry.nextRun = Date.now() + frequencyMs;
			queueReportForEntry(entry);
		}

		return {
			cancel() {
				if (scheduledReports.delete(entry.id)) {
					params.logger.info("scheduled report cancelled", { id: entry.id, label: entry.label });
				}
			},
		};
	};

	const runSchedulerCycle = async () => {
		if (schedulerInFlight) {
			params.logger.warn("heartbeat cycle skipped because a previous cycle is still running");
			return;
		}

		schedulerInFlight = true;
		try {
			const message = buildHeartbeatText(params.agentVersion);
			params.logger.info("heartbeat cycle started", {
				observedChats: observedTargets.size,
				message,
			});

			for (const rawTarget of observedTargets) {
				const target = parseTargetKey(rawTarget);
				void enqueue(target, async () => {
					try {
						await params.sendTelegramMessage({
							chatId: target.chatId,
							messageThreadId: target.messageThreadId,
							text: message,
						});
						params.logger.info("heartbeat sent", { chatId: target.chatId, messageThreadId: target.messageThreadId, message });
					} catch (error) {
						params.logger.error(`heartbeat failed for chat ${target.chatId}`, error);
					}
				});
			}
		} finally {
			schedulerInFlight = false;
		}
	};

	void runSchedulerCycle();

	return {
		observeChat(chatId: number, messageThreadId?: number) {
			observedTargets.add(targetKey(chatId, messageThreadId));
			params.logger.info("heartbeat chat observed", {
				chatId,
				messageThreadId,
				totalChats: observedTargets.size,
			});
		},
		stop() {
			clearInterval(timer);
			scheduledReports.clear();
			params.logger.info("heartbeat stopped");
		},
		scheduleReport,
	};
}

function targetKey(chatId: number, messageThreadId?: number) {
	return messageThreadId === undefined ? String(chatId) : `${chatId}:topic:${messageThreadId}`;
}

function parseTargetKey(raw: string): HeartbeatTarget {
	const [chatIdPart, threadMarker, threadIdPart] = raw.split(":");
	const chatId = Number.parseInt(chatIdPart, 10);
	if (!Number.isFinite(chatId)) {
		throw new Error(`Invalid heartbeat target: ${raw}`);
	}

	const messageThreadId =
		threadMarker === "topic" && threadIdPart ? Number.parseInt(threadIdPart, 10) : undefined;
	if (threadMarker === "topic" && !Number.isFinite(messageThreadId)) {
		throw new Error(`Invalid heartbeat topic target: ${raw}`);
	}

	return { chatId, messageThreadId };
}
