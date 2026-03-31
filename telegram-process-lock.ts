import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type LockMetadata = {
	pid: number;
	startedAt: string;
};

export type TelegramProcessLock = {
	release(): Promise<void>;
	path: string;
};

export function defaultTelegramProcessLockPath(rootDir = process.cwd()) {
	return join(rootDir, "data", "telegram-process.lock");
}

export function isTelegramGetUpdatesConflict(error: unknown) {
	return (
		error instanceof Error &&
		error.message.toLowerCase().includes("getupdates") &&
		(error.message.includes("HTTP 409") ||
			error.message.includes("409 Conflict") ||
			error.message.toLowerCase().includes("conflict"))
	);
}

async function processIsRunning(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const nodeError = error as NodeJS.ErrnoException;
		return nodeError.code === "EPERM";
	}
}

async function readLockMetadata(lockDirPath: string): Promise<LockMetadata | undefined> {
	try {
		const raw = await readFile(join(lockDirPath, "owner.json"), "utf8");
		const parsed = JSON.parse(raw) as Partial<LockMetadata>;
		if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid)) {
			return undefined;
		}

		return {
			pid: Math.trunc(parsed.pid),
			startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "unknown",
		};
	} catch {
		return undefined;
	}
}

export async function acquireTelegramProcessLock(lockDirPath = defaultTelegramProcessLockPath()) {
	await mkdir(dirname(lockDirPath), { recursive: true });

	for (;;) {
		try {
			await mkdir(lockDirPath);
			const metadata: LockMetadata = {
				pid: process.pid,
				startedAt: new Date().toISOString(),
			};
			await writeFile(join(lockDirPath, "owner.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

			let released = false;
			return {
				path: lockDirPath,
				release: async () => {
					if (released) {
						return;
					}
					released = true;
					await rm(lockDirPath, { recursive: true, force: true });
				},
			} satisfies TelegramProcessLock;
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			if (nodeError.code !== "EEXIST") {
				throw error;
			}

			const metadata = await readLockMetadata(lockDirPath);
			if (metadata && (await processIsRunning(metadata.pid))) {
				throw new Error(
					`Telegram bot start blocked: another process is already running (pid ${metadata.pid}, started ${metadata.startedAt}).`,
				);
			}

			await rm(lockDirPath, { recursive: true, force: true });
		}
	}
}
