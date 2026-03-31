import { promises as fs } from "node:fs";
import path from "node:path";

type Totals = {
	files: number;
	totalLines: number;
	codeLines: number;
};

const ignoredDirectories = new Set([".git", "dist", "node_modules"]);

function parseTargets(argv: string[]): string[] {
	const targets = argv.filter((arg) => !arg.startsWith("-"));
	return targets.length > 0 ? targets : ["."];
}

async function collectTypeScriptFiles(targets: string[]): Promise<string[]> {
	const files: string[] = [];

	async function walk(entryPath: string): Promise<void> {
		const stat = await fs.stat(entryPath);

		if (stat.isFile()) {
			if (entryPath.endsWith(".ts")) {
				files.push(entryPath);
			}
			return;
		}

		if (!stat.isDirectory()) {
			return;
		}

		const baseName = path.basename(entryPath);
		if (ignoredDirectories.has(baseName) || baseName.startsWith(".")) {
			return;
		}

		const entries = await fs.readdir(entryPath, { withFileTypes: true });
		for (const entry of entries) {
			await walk(path.join(entryPath, entry.name));
		}
	}

	for (const target of targets) {
		await walk(path.resolve(target));
	}

	return files.sort((left, right) => left.localeCompare(right));
}

function countCodeLines(text: string): number {
	const lines = text.split(/\r?\n/);
	let inBlockComment = false;
	let count = 0;

	for (const line of lines) {
		let index = 0;
		let hasCode = false;

		while (index < line.length) {
			if (inBlockComment) {
				const end = line.indexOf("*/", index);
				if (end === -1) {
					index = line.length;
					break;
				}

				index = end + 2;
				inBlockComment = false;
				continue;
			}

			const char = line[index];

			if (/\s/.test(char)) {
				index += 1;
				continue;
			}

			if (char === "/" && line[index + 1] === "/") {
				break;
			}

			if (char === "/" && line[index + 1] === "*") {
				inBlockComment = true;
				index += 2;
				continue;
			}

			hasCode = true;
			break;
		}

		if (hasCode) {
			count += 1;
		}
	}

	return count;
}

async function main(): Promise<void> {
	const targets = parseTargets(process.argv.slice(2));
	const files = await collectTypeScriptFiles(targets);

	const perFile: Array<{ file: string; totalLines: number; codeLines: number }> = [];
	const totals: Totals = { files: 0, totalLines: 0, codeLines: 0 };

	for (const file of files) {
		const content = await fs.readFile(file, "utf8");
		const totalLines = content.split(/\r?\n/).length;
		const codeLines = countCodeLines(content);

		perFile.push({ file, totalLines, codeLines });
		totals.files += 1;
		totals.totalLines += totalLines;
		totals.codeLines += codeLines;
	}

	console.log(`TypeScript files: ${totals.files}`);
	console.log(`Total lines: ${totals.totalLines}`);
	console.log(`Code lines: ${totals.codeLines}`);

	for (const entry of perFile) {
		const { file, totalLines, codeLines } = entry;
		console.log(`${file}\t${codeLines}/${totalLines}`);
	}
}

await main();
