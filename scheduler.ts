import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "./logging.js";

export type ScheduledAction = {
	type: "send_message";
	text: string;
	chatId: number;
	messageThreadId?: number;
};

export type ScheduledJob = {
	id: string;
	createdAt: number;
	scheduleType: "recurring" | "one_time";
	intervalMs?: number;
	startAt?: number;
	dailyWindowStartMs?: number;
	dailyWindowEndMs?: number;
	nextRun: number;
	ownerKey: string;
	label: string;
	action: ScheduledAction;
};

type SchedulerLogger = Pick<Logger, "info" | "warn" | "error">;

type SchedulerOptions = {
	tickMs?: number;
	executeAction: (action: ScheduledAction, job: ScheduledJob) => Promise<void>;
	logger?: SchedulerLogger;
	now?: () => number;
	idFactory?: () => string;
	storagePath?: string;
};

type ScheduleTaskInput = {
	intervalMinutes?: number;
	delayMinutes?: number;
	runAtIso?: string;
	startAtIso?: string;
	dailyWindowStart?: string;
	dailyWindowEnd?: string;
	text: string;
	chatId: number;
	messageThreadId?: number;
	label?: string;
};

type ScheduleTaskResult = {
	id: string;
	scheduleType: "recurring" | "one_time";
	intervalMinutes?: number;
	startAtIso?: string;
	dailyWindowStart?: string;
	dailyWindowEnd?: string;
	nextRunIso: string;
};

type ListTasksInput = {
	chatId: number;
	messageThreadId?: number;
};

type CancelTaskInput = {
	id: string;
	chatId: number;
	messageThreadId?: number;
};

export type NotificationScheduler = {
	start(): void;
	stop(): void;
	scheduleTask(input: ScheduleTaskInput): ScheduleTaskResult;
	listTasks(input: ListTasksInput): ScheduledJob[];
	cancelTask(input: CancelTaskInput): { removed: boolean };
};

const MIN_INTERVAL_MINUTES = 1;
const MIN_DELAY_MINUTES = 1;
const DEFAULT_TICK_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

type SchedulerStore = {
	jobs: ScheduledJob[];
};

function ownerKey(chatId: number, messageThreadId?: number) {
	return `${chatId}:${messageThreadId ?? ""}`;
}

function normalizeLabel(rawLabel: string) {
	const compact = rawLabel.trim().replace(/\s+/g, " ");
	if (!compact) {
		return "scheduled-notification";
	}

	return compact.slice(0, 80);
}

function normalizeIntervalMinutes(raw: number) {
	if (!Number.isFinite(raw)) {
		throw new Error("interval_minutes must be a finite number");
	}

	const floored = Math.floor(raw);
	if (floored < MIN_INTERVAL_MINUTES) {
		throw new Error(`interval_minutes must be at least ${MIN_INTERVAL_MINUTES}`);
	}

	return floored;
}

function normalizeDelayMinutes(raw: number) {
	if (!Number.isFinite(raw)) {
		throw new Error("delay_minutes must be a finite number");
	}

	const floored = Math.floor(raw);
	if (floored < MIN_DELAY_MINUTES) {
		throw new Error(`delay_minutes must be at least ${MIN_DELAY_MINUTES}`);
	}

	return floored;
}

function normalizeRunAt(raw: string, createdAt: number) {
	const trimmed = raw.trim();
	if (!trimmed) {
		throw new Error("run_at_iso cannot be empty");
	}

	const runAt = Date.parse(trimmed);
	if (Number.isNaN(runAt)) {
		throw new Error("run_at_iso must be a valid ISO-8601 timestamp");
	}

	if (runAt <= createdAt) {
		throw new Error("run_at_iso must be in the future");
	}

	return runAt;
}

function normalizeDailyWindowTime(raw: string, fieldName: string) {
	const trimmed = raw.trim();
	const match = /^(?<hours>[01]\d|2[0-3]):(?<minutes>[0-5]\d)$/.exec(trimmed);
	if (!match?.groups) {
		throw new Error(`${fieldName} must use HH:MM in 24-hour time.`);
	}

	const hours = Number.parseInt(match.groups.hours, 10);
	const minutes = Number.parseInt(match.groups.minutes, 10);
	return (hours * 60 + minutes) * 60_000;
}

function formatDailyWindowTime(timeOfDayMs: number) {
	const totalMinutes = Math.floor(timeOfDayMs / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

function buildDailyWindow(startRaw?: string, endRaw?: string) {
	if (startRaw === undefined && endRaw === undefined) {
		return undefined;
	}
	if (startRaw === undefined || endRaw === undefined) {
		throw new Error("daily_window_start and daily_window_end must be provided together.");
	}

	const startMs = normalizeDailyWindowTime(startRaw, "daily_window_start");
	const endMs = normalizeDailyWindowTime(endRaw, "daily_window_end");
	if (startMs === endMs) {
		throw new Error("daily_window_start and daily_window_end cannot be the same.");
	}

	return { startMs, endMs };
}

function timeOfDayMs(timestamp: number) {
	const date = new Date(timestamp);
	return (
		((date.getHours() * 60 + date.getMinutes()) * 60 + date.getSeconds()) * 1_000 +
		date.getMilliseconds()
	);
}

function isWithinDailyWindow(timestamp: number, window: { startMs: number; endMs: number }) {
	const currentTimeMs = timeOfDayMs(timestamp);
	if (window.startMs < window.endMs) {
		return currentTimeMs >= window.startMs && currentTimeMs <= window.endMs;
	}
	return currentTimeMs >= window.startMs || currentTimeMs <= window.endMs;
}

function greatestCommonDivisor(a: number, b: number): number {
	let left = Math.abs(a);
	let right = Math.abs(b);
	while (right !== 0) {
		const remainder = left % right;
		left = right;
		right = remainder;
	}
	return left;
}

function resolveNextRecurringRun(
	baseTime: number,
	intervalMs: number,
	notBeforeExclusive: number,
	window?: { startMs: number; endMs: number },
) {
	if (!window) {
		let nextRun = baseTime;
		while (nextRun <= notBeforeExclusive) {
			nextRun += intervalMs;
		}
		return nextRun;
	}

	const maxSteps = DAY_MS / greatestCommonDivisor(intervalMs, DAY_MS);
	let nextRun = baseTime;
	for (let step = 0; step <= maxSteps; step += 1) {
		if (nextRun > notBeforeExclusive && isWithinDailyWindow(nextRun, window)) {
			return nextRun;
		}
		nextRun += intervalMs;
	}

	throw new Error(
		"The selected interval and daily window never overlap. Choose a different interval, start time, or window.",
	);
}

function createDefaultIdFactory() {
	return () => {
		const millis = Date.now().toString(36);
		const random = Math.random().toString(36).slice(2, 8);
		return `sched_${millis}_${random}`;
	};
}

function cloneJob(job: ScheduledJob): ScheduledJob {
	return {
		...job,
		action: {
			...job.action,
		},
	};
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseStoredJob(value: unknown): ScheduledJob | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}

	const candidate = value as Partial<ScheduledJob> & {
		action?: Partial<ScheduledAction>;
	};

	if (
		typeof candidate.id !== "string" ||
		!isFiniteNumber(candidate.createdAt) ||
		(candidate.scheduleType !== "recurring" && candidate.scheduleType !== "one_time") ||
		!isFiniteNumber(candidate.nextRun) ||
		typeof candidate.ownerKey !== "string" ||
		typeof candidate.label !== "string" ||
		!candidate.action ||
		candidate.action.type !== "send_message" ||
		typeof candidate.action.text !== "string" ||
		!isFiniteNumber(candidate.action.chatId)
	) {
		return undefined;
	}

	if (candidate.intervalMs !== undefined && !isFiniteNumber(candidate.intervalMs)) {
		return undefined;
	}
	if (candidate.startAt !== undefined && !isFiniteNumber(candidate.startAt)) {
		return undefined;
	}
	if (candidate.dailyWindowStartMs !== undefined && !isFiniteNumber(candidate.dailyWindowStartMs)) {
		return undefined;
	}
	if (candidate.dailyWindowEndMs !== undefined && !isFiniteNumber(candidate.dailyWindowEndMs)) {
		return undefined;
	}
	if (
		candidate.action.messageThreadId !== undefined &&
		!isFiniteNumber(candidate.action.messageThreadId)
	) {
		return undefined;
	}

	return {
		id: candidate.id,
		createdAt: candidate.createdAt,
		scheduleType: candidate.scheduleType,
		intervalMs: candidate.intervalMs,
		startAt: candidate.startAt,
		dailyWindowStartMs: candidate.dailyWindowStartMs,
		dailyWindowEndMs: candidate.dailyWindowEndMs,
		nextRun: candidate.nextRun,
		ownerKey: candidate.ownerKey,
		label: candidate.label,
		action: {
			type: "send_message",
			text: candidate.action.text,
			chatId: candidate.action.chatId,
			messageThreadId: candidate.action.messageThreadId,
		},
	};
}

function loadSchedulerStore(storagePath: string): SchedulerStore {
	try {
		const raw = readFileSync(storagePath, "utf8");
		const parsed = JSON.parse(raw) as { jobs?: unknown };
		const jobs = Array.isArray(parsed.jobs)
			? parsed.jobs.map((job) => parseStoredJob(job)).filter((job): job is ScheduledJob => job !== undefined)
			: [];
		return { jobs };
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		if (nodeError.code === "ENOENT") {
			return { jobs: [] };
		}
		if (error instanceof SyntaxError) {
			throw new Error(`Invalid JSON in ${storagePath}: ${error.message}`);
		}
		throw error;
	}
}

function saveSchedulerStore(storagePath: string, store: SchedulerStore) {
	const directory = dirname(storagePath);
	mkdirSync(directory, { recursive: true });
	const tempPath = `${storagePath}.tmp`;
	const payload = `${JSON.stringify(
		{
			jobs: store.jobs
				.map((job) => cloneJob(job))
				.sort((left, right) => left.nextRun - right.nextRun || left.id.localeCompare(right.id)),
		},
		null,
		2,
	)}\n`;
	writeFileSync(tempPath, payload, "utf8");
	try {
		renameSync(tempPath, storagePath);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

export function createNotificationScheduler(options: SchedulerOptions): NotificationScheduler {
	const tickMs = Math.max(1_000, Math.floor(options.tickMs ?? DEFAULT_TICK_MS));
	const now = options.now ?? (() => Date.now());
	const makeId = options.idFactory ?? createDefaultIdFactory();
	const jobs = new Map<string, ScheduledJob>();
	let timer: NodeJS.Timeout | undefined;
	let tickInFlight = false;

	if (options.storagePath) {
		for (const storedJob of loadSchedulerStore(options.storagePath).jobs) {
			jobs.set(storedJob.id, storedJob);
		}
	}

	const persistJobs = () => {
		if (!options.storagePath) {
			return;
		}

		saveSchedulerStore(options.storagePath, { jobs: [...jobs.values()] });
	};

	const start = () => {
		if (timer) {
			return;
		}

		timer = setInterval(() => {
			void runTick();
		}, tickMs);

		if (typeof timer.unref === "function") {
			timer.unref();
		}

		options.logger?.info("notification scheduler started", { tickMs });
	};

	const stop = () => {
		if (!timer) {
			return;
		}

		clearInterval(timer);
		timer = undefined;
		options.logger?.info("notification scheduler stopped");
	};

	const scheduleTask = (input: ScheduleTaskInput): ScheduleTaskResult => {
		const createdAt = now();
		const id = makeId();
		const modeCount =
			(input.intervalMinutes !== undefined ? 1 : 0) +
			(input.delayMinutes !== undefined ? 1 : 0) +
			(input.runAtIso !== undefined ? 1 : 0);

		if (modeCount !== 1) {
			throw new Error(
				"Provide exactly one primary scheduling mode: interval_minutes, delay_minutes, or run_at_iso.",
			);
		}
		if (input.startAtIso !== undefined && input.intervalMinutes === undefined) {
			throw new Error("start_at_iso is only supported with interval_minutes.");
		}
		if (input.startAtIso !== undefined && input.runAtIso !== undefined) {
			throw new Error("start_at_iso cannot be combined with run_at_iso.");
		}
		if (input.startAtIso !== undefined && input.delayMinutes !== undefined) {
			throw new Error("start_at_iso cannot be combined with delay_minutes.");
		}
		if (
			(input.dailyWindowStart !== undefined || input.dailyWindowEnd !== undefined) &&
			input.intervalMinutes === undefined
		) {
			throw new Error("daily_window_start and daily_window_end are only supported with interval_minutes.");
		}

		const dailyWindow = buildDailyWindow(input.dailyWindowStart, input.dailyWindowEnd);

		let scheduleType: ScheduledJob["scheduleType"];
		let intervalMinutes: number | undefined;
		let intervalMs: number | undefined;
		let startAt: number | undefined;
		let nextRun: number;

		if (input.intervalMinutes !== undefined) {
			intervalMinutes = normalizeIntervalMinutes(input.intervalMinutes);
			intervalMs = intervalMinutes * 60_000;
			startAt =
				input.startAtIso !== undefined
					? normalizeRunAt(input.startAtIso, createdAt)
					: createdAt + intervalMs;
			if (dailyWindow && input.startAtIso !== undefined && !isWithinDailyWindow(startAt, dailyWindow)) {
				throw new Error("start_at_iso must fall within the daily active window.");
			}
			nextRun = resolveNextRecurringRun(startAt, intervalMs, createdAt, dailyWindow);
			scheduleType = "recurring";
		} else if (input.delayMinutes !== undefined) {
			const delayMinutes = normalizeDelayMinutes(input.delayMinutes);
			nextRun = createdAt + delayMinutes * 60_000;
			scheduleType = "one_time";
		} else {
			nextRun = normalizeRunAt(input.runAtIso ?? "", createdAt);
			scheduleType = "one_time";
		}

		if (jobs.has(id)) {
			throw new Error("failed to allocate a unique schedule id");
		}

		const job: ScheduledJob = {
			id,
			createdAt,
			scheduleType,
			intervalMs,
			startAt,
			dailyWindowStartMs: dailyWindow?.startMs,
			dailyWindowEndMs: dailyWindow?.endMs,
			nextRun,
			ownerKey: ownerKey(input.chatId, input.messageThreadId),
			label: normalizeLabel(input.label ?? input.text),
			action: {
				type: "send_message",
				text: input.text,
				chatId: input.chatId,
				messageThreadId: input.messageThreadId,
			},
		};

		jobs.set(job.id, job);
		try {
			persistJobs();
		} catch (error) {
			jobs.delete(job.id);
			throw error;
		}
		options.logger?.info("notification scheduled", {
			id: job.id,
			ownerKey: job.ownerKey,
			scheduleType,
			intervalMinutes,
			label: job.label,
		});

		return {
			id: job.id,
			scheduleType,
			intervalMinutes,
			startAtIso: typeof job.startAt === "number" ? new Date(job.startAt).toISOString() : undefined,
			dailyWindowStart:
				typeof job.dailyWindowStartMs === "number"
					? formatDailyWindowTime(job.dailyWindowStartMs)
					: undefined,
			dailyWindowEnd:
				typeof job.dailyWindowEndMs === "number"
					? formatDailyWindowTime(job.dailyWindowEndMs)
					: undefined,
			nextRunIso: new Date(job.nextRun).toISOString(),
		};
	};

	const listTasks = (input: ListTasksInput) => {
		const key = ownerKey(input.chatId, input.messageThreadId);
		return [...jobs.values()]
			.filter((job) => job.ownerKey === key)
			.sort((a, b) => a.nextRun - b.nextRun)
			.map((job) => ({ ...job, action: { ...job.action } }));
	};

	const cancelTask = (input: CancelTaskInput) => {
		const existing = jobs.get(input.id);
		if (!existing) {
			return { removed: false };
		}

		if (existing.ownerKey !== ownerKey(input.chatId, input.messageThreadId)) {
			return { removed: false };
		}

		const removed = jobs.delete(input.id);
		if (removed) {
			try {
				persistJobs();
			} catch (error) {
				jobs.set(existing.id, existing);
				throw error;
			}
			options.logger?.info("notification cancelled", {
				id: input.id,
				ownerKey: existing.ownerKey,
				label: existing.label,
			});
		}
		return { removed };
	};

	const runTick = async () => {
		if (tickInFlight) {
			options.logger?.warn("notification cycle skipped because previous cycle is still running");
			return;
		}

		tickInFlight = true;
		try {
			const startedAt = now();
			const dueJobs = [...jobs.values()].filter((job) => job.nextRun <= startedAt);
			if (dueJobs.length === 0) {
				return;
			}

			let jobsChanged = false;
			for (const job of dueJobs) {
				try {
					await options.executeAction(job.action, job);
				} catch (error) {
					options.logger?.error(`scheduled notification failed for ${job.id}`, error);
				} finally {
					const latest = jobs.get(job.id);
					if (!latest) {
						continue;
					}
					if (latest.scheduleType === "one_time") {
						jobs.delete(latest.id);
						jobsChanged = true;
						continue;
					}
					if (typeof latest.intervalMs !== "number") {
						options.logger?.warn("recurring schedule missing interval, cancelling", {
							id: latest.id,
							ownerKey: latest.ownerKey,
						});
						jobs.delete(latest.id);
						jobsChanged = true;
						continue;
					}
					const completedAt = now();
					const dailyWindow =
						typeof latest.dailyWindowStartMs === "number" &&
						typeof latest.dailyWindowEndMs === "number"
							? {
									startMs: latest.dailyWindowStartMs,
									endMs: latest.dailyWindowEndMs,
								}
							: undefined;
					latest.nextRun = resolveNextRecurringRun(
						latest.nextRun + latest.intervalMs,
						latest.intervalMs,
						completedAt,
						dailyWindow,
					);
					jobsChanged = true;
				}
			}

			if (jobsChanged) {
				try {
					persistJobs();
				} catch (error) {
					options.logger?.error("failed to persist scheduled notifications", error);
				}
			}
		} finally {
			tickInFlight = false;
		}
	};

	return {
		start,
		stop,
		scheduleTask,
		listTasks,
		cancelTask,
	};
}
