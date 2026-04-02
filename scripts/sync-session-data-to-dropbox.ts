import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadCredentialsToml } from "../credentials.js";

const execFile = promisify(execFileCallback);

type CliOptions = {
	sessionsDir: string;
	remotePath?: string;
	keepHistory: boolean;
	dryRun: boolean;
};

type DropboxFileMetadata = {
	id?: string;
	name?: string;
	path_display?: string;
	path_lower?: string;
	size?: number;
	server_modified?: string;
};

function printUsage() {
	console.error(
		"Usage: npm run sessions:sync:dropbox -- [--sessions-dir <path>] [--remote-path <dropbox-path>] [--keep-history] [--dry-run]",
	);
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		sessionsDir: join(process.cwd(), "sessions"),
		keepHistory: false,
		dryRun: false,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--sessions-dir") {
			const value = argv[i + 1];
			if (!value || value.startsWith("--")) {
				throw new Error("Missing value for --sessions-dir.");
			}
			options.sessionsDir = value;
			i += 1;
			continue;
		}
		if (arg === "--remote-path") {
			const value = argv[i + 1];
			if (!value || value.startsWith("--")) {
				throw new Error("Missing value for --remote-path.");
			}
			options.remotePath = value;
			i += 1;
			continue;
		}
		if (arg === "--keep-history") {
			options.keepHistory = true;
			continue;
		}
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			printUsage();
			process.exit(0);
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

function normalizeRemotePath(rawPath: string): string {
	const value = rawPath.trim();
	if (!value) {
		throw new Error("Dropbox remote path must not be empty.");
	}
	if (!value.startsWith("/")) {
		throw new Error("Dropbox remote path must start with '/'.");
	}
	if (value.endsWith("/")) {
		return `${value}session-data-latest.tar.gz`;
	}
	return value;
}

function buildHistoryPath(remotePath: string, timestamp: string): string {
	const archiveSuffix = ".tar.gz";
	if (remotePath.endsWith(archiveSuffix)) {
		return `${remotePath.slice(0, -archiveSuffix.length)}-${timestamp}${archiveSuffix}`;
	}
	return `${remotePath}-${timestamp}`;
}

function formatTimestamp(now: Date): string {
	return now.toISOString().replace(/[:]/g, "-").replace(/\.\d{3}Z$/, "Z");
}

async function ensureDirectory(path: string) {
	const info = await stat(path);
	if (!info.isDirectory()) {
		throw new Error(`Expected a directory but got: ${path}`);
	}
}

function parseDropboxJson(value: string, context: string): DropboxFileMetadata {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`${context} returned invalid JSON: ${value.slice(0, 200)}`);
	}

	if (!parsed || typeof parsed !== "object") {
		throw new Error(`${context} returned an unexpected response shape.`);
	}

	return parsed as DropboxFileMetadata;
}

async function uploadArchive(params: {
	token: string;
	remotePath: string;
	archiveBytes: Uint8Array;
}): Promise<DropboxFileMetadata> {
	const response = await fetch("https://content.dropboxapi.com/2/files/upload", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${params.token}`,
			"Content-Type": "application/octet-stream",
			"Dropbox-API-Arg": JSON.stringify({
				path: params.remotePath,
				mode: "overwrite",
				autorename: false,
				mute: true,
				strict_conflict: false,
			}),
		},
		body: params.archiveBytes as unknown as BodyInit,
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Dropbox upload failed (${response.status}): ${text.slice(0, 400)}`);
	}

	return parseDropboxJson(text, "Dropbox upload");
}

async function fetchMetadata(params: {
	token: string;
	remotePath: string;
}): Promise<DropboxFileMetadata> {
	const response = await fetch("https://api.dropboxapi.com/2/files/get_metadata", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${params.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			path: params.remotePath,
		}),
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Dropbox metadata check failed (${response.status}): ${text.slice(0, 400)}`);
	}

	return parseDropboxJson(text, "Dropbox metadata check");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const credentials = await loadCredentialsToml();

	const token = process.env.DROPBOX_ACCESS_TOKEN?.trim() || credentials.dropbox?.access_token?.trim();
	if (!token) {
		throw new Error("Missing Dropbox token. Set DROPBOX_ACCESS_TOKEN or dropbox.access_token in credentials.toml.");
	}

	const configuredRemotePath =
		options.remotePath?.trim() ||
		process.env.DROPBOX_SESSION_REMOTE_PATH?.trim() ||
		credentials.dropbox?.session_remote_path?.trim() ||
		"/zeno/session-data/session-data-latest.tar.gz";

	const sessionsDir = resolve(options.sessionsDir);
	const baseRemotePath = normalizeRemotePath(configuredRemotePath);
	const remotePath = options.keepHistory ? buildHistoryPath(baseRemotePath, formatTimestamp(new Date())) : baseRemotePath;

	await ensureDirectory(sessionsDir);

	const tempDir = await mkdtemp(join(tmpdir(), "zeno-session-sync-"));
	const archivePath = join(tempDir, "session-data.tar.gz");

	try {
		await execFile("tar", ["-czf", archivePath, "-C", sessionsDir, "."]);
		const archiveBytes = await readFile(archivePath);

		if (archiveBytes.length === 0) {
			throw new Error("Session archive is empty. Confirm the sessions directory contains files.");
		}

		if (options.dryRun) {
			console.log("Dry run only. No network request was sent.");
			console.log(`Sessions directory: ${sessionsDir}`);
			console.log(`Archive size: ${archiveBytes.length} bytes`);
			console.log(`Remote path: ${remotePath}`);
			return;
		}

		const uploadResult = await uploadArchive({ token, remotePath, archiveBytes });
		const metadataResult = await fetchMetadata({ token, remotePath });

		console.log("Dropbox session sync complete.");
		console.log(`Remote path: ${metadataResult.path_display || uploadResult.path_display || remotePath}`);
		console.log(`Size: ${metadataResult.size ?? uploadResult.size ?? archiveBytes.length} bytes`);
		if (metadataResult.server_modified) {
			console.log(`Server modified: ${metadataResult.server_modified}`);
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	printUsage();
	process.exit(1);
});
