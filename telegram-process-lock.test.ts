import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	acquireTelegramProcessLock,
	defaultTelegramProcessLockPath,
	isTelegramGetUpdatesConflict,
} from "./telegram-process-lock.js";

test("detects Telegram getUpdates 409 conflicts", () => {
	assert.equal(
		isTelegramGetUpdatesConflict(
			new Error('Telegram API HTTP 409 on getUpdates: {"ok":false,"error_code":409}'),
		),
		true,
	);
	assert.equal(isTelegramGetUpdatesConflict(new Error("HTTP 500 on getUpdates")), false);
	assert.equal(isTelegramGetUpdatesConflict(new Error("Telegram API HTTP 409 on sendMessage")), false);
});

test("acquires the Telegram process lock after removing a stale owner record", async () => {
	const tempDirectory = mkdtempSync(join(tmpdir(), "zeno-telegram-lock-"));
	const lockPath = defaultTelegramProcessLockPath(tempDirectory);

	try {
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(
			join(lockPath, "owner.json"),
			`${JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, startedAt: "2026-03-31T00:00:00.000Z" })}\n`,
			"utf8",
		);

		const lock = await acquireTelegramProcessLock(lockPath);
		try {
			assert.equal(lock.path, lockPath);
		} finally {
			await lock.release();
		}
	} finally {
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});

test("rejects a live Telegram process lock", async () => {
	const tempDirectory = mkdtempSync(join(tmpdir(), "zeno-telegram-lock-live-"));
	const lockPath = defaultTelegramProcessLockPath(tempDirectory);

	try {
		mkdirSync(lockPath, { recursive: true });
		writeFileSync(
			join(lockPath, "owner.json"),
			`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
			"utf8",
		);

		await assert.rejects(
			acquireTelegramProcessLock(lockPath),
			/another process is already running/i,
		);
	} finally {
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});
