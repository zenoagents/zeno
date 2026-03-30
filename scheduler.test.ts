import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNotificationScheduler } from "./scheduler.js";

process.env.TZ = "Asia/Bangkok";

function localIso(
	year: number,
	month: number,
	day: number,
	hours: number,
	minutes = 0,
	seconds = 0,
) {
	return new Date(year, month - 1, day, hours, minutes, seconds, 0).toISOString();
}

test("recurring schedules can start in the future and stay anchored to that cadence", async () => {
	let nowMs = Date.parse("2026-03-29T08:00:00.000Z");
	const sentAt: number[] = [];

	const scheduler = createNotificationScheduler({
		tickMs: 1_000,
		now: () => nowMs,
		idFactory: () => "sched_test",
		executeAction: async () => {
			sentAt.push(nowMs);
		},
	});

	const result = scheduler.scheduleTask({
		text: "Standup reminder",
		chatId: 123,
		intervalMinutes: 5,
		startAtIso: "2026-03-29T08:10:00.000Z",
	});

	assert.equal(result.scheduleType, "recurring");
	assert.equal(result.startAtIso, "2026-03-29T08:10:00.000Z");
	assert.equal(result.nextRunIso, "2026-03-29T08:10:00.000Z");

	scheduler.start();

	try {
		nowMs = Date.parse("2026-03-29T08:10:01.000Z");
		await new Promise((resolve) => setTimeout(resolve, 1_100));

		let [job] = scheduler.listTasks({ chatId: 123 });
		assert.equal(sentAt.length, 1);
		assert.equal(job.startAt, Date.parse("2026-03-29T08:10:00.000Z"));
		assert.equal(job.nextRun, Date.parse("2026-03-29T08:15:00.000Z"));

		nowMs = Date.parse("2026-03-29T08:20:05.000Z");
		await new Promise((resolve) => setTimeout(resolve, 1_100));

		[job] = scheduler.listTasks({ chatId: 123 });
		assert.equal(sentAt.length, 2);
		assert.equal(job.nextRun, Date.parse("2026-03-29T08:25:00.000Z"));
	} finally {
		scheduler.stop();
	}
});

test("recurring schedules can be limited to a daily local-time window", async () => {
	let nowMs = Date.parse(localIso(2026, 3, 29, 8, 0));
	const sentAt: number[] = [];

	const scheduler = createNotificationScheduler({
		tickMs: 1_000,
		now: () => nowMs,
		idFactory: () => "sched_windowed",
		executeAction: async () => {
			sentAt.push(nowMs);
		},
	});

	const result = scheduler.scheduleTask({
		text: "Business-hours reminder",
		chatId: 456,
		intervalMinutes: 60,
		startAtIso: localIso(2026, 3, 29, 9, 0),
		dailyWindowStart: "09:00",
		dailyWindowEnd: "21:00",
	});

	assert.equal(result.dailyWindowStart, "09:00");
	assert.equal(result.dailyWindowEnd, "21:00");
	assert.equal(result.nextRunIso, localIso(2026, 3, 29, 9, 0));

	scheduler.start();

	try {
		nowMs = Date.parse(localIso(2026, 3, 29, 9, 0, 1));
		await new Promise((resolve) => setTimeout(resolve, 1_100));

		let [job] = scheduler.listTasks({ chatId: 456 });
		assert.equal(sentAt.length, 1);
		assert.equal(job.nextRun, Date.parse(localIso(2026, 3, 29, 10, 0)));

		nowMs = Date.parse(localIso(2026, 3, 29, 21, 0, 1));
		await new Promise((resolve) => setTimeout(resolve, 1_100));

		[job] = scheduler.listTasks({ chatId: 456 });
		assert.equal(sentAt.length, 2);
		assert.equal(job.nextRun, Date.parse(localIso(2026, 3, 30, 9, 0)));
	} finally {
		scheduler.stop();
	}
});

test("recurring schedules reject interval and daily window combinations that can never fire", () => {
	const scheduler = createNotificationScheduler({
		now: () => Date.parse("2026-03-29T08:00:00.000Z"),
		idFactory: () => "sched_invalid_window",
		executeAction: async () => {},
	});

	assert.throws(
		() =>
			scheduler.scheduleTask({
				text: "Impossible window",
				chatId: 789,
				intervalMinutes: 120,
				dailyWindowStart: "09:01",
				dailyWindowEnd: "09:59",
			}),
		/The selected interval and daily window never overlap\./,
	);
});

test("scheduled jobs persist to JSON and reload after restart", () => {
	const tempDirectory = mkdtempSync(join(tmpdir(), "zeno-scheduler-"));
	const storagePath = join(tempDirectory, "scheduled-notifications.json");

	try {
		const scheduler = createNotificationScheduler({
			now: () => Date.parse("2026-03-29T08:00:00.000Z"),
			idFactory: () => "sched_persisted",
			storagePath,
			executeAction: async () => {},
		});

		scheduler.scheduleTask({
			text: "Persist me",
			chatId: 987,
			messageThreadId: 654,
			intervalMinutes: 15,
			startAtIso: "2026-03-29T08:15:00.000Z",
			label: "Persistent reminder",
		});

		const restartedScheduler = createNotificationScheduler({
			now: () => Date.parse("2026-03-29T08:05:00.000Z"),
			storagePath,
			executeAction: async () => {},
		});

		const jobs = restartedScheduler.listTasks({ chatId: 987, messageThreadId: 654 });
		assert.equal(jobs.length, 1);
		assert.equal(jobs[0]?.id, "sched_persisted");
		assert.equal(jobs[0]?.label, "Persistent reminder");
		assert.equal(jobs[0]?.action.text, "Persist me");
		assert.equal(jobs[0]?.nextRun, Date.parse("2026-03-29T08:15:00.000Z"));
	} finally {
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});
