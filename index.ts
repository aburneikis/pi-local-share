import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_DURATION = "1h";
const STATE_DIR = join(tmpdir(), "pi-lshare");
const SERVER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");

interface ShareState {
	pid: number;
	url: string;
	expiresAt: number;
	sessionFile: string;
	sessionName: string;
}

function parseDuration(text: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(text.trim());
	if (!match) return undefined;
	const value = Number(match[1]);
	const unit = (match[2] ?? "m").toLowerCase();
	const factor = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 60_000;
	return value * factor;
}

function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
	return `${s}s`;
}

function lanAddress(): string | undefined {
	const skip = /^(lo|docker|br-|veth|virbr|tun|tap|wg)/;
	const candidates: { name: string; address: string }[] = [];
	for (const [name, infos] of Object.entries(networkInterfaces())) {
		if (skip.test(name)) continue;
		for (const info of infos ?? []) {
			if (info.family === "IPv4" && !info.internal) candidates.push({ name, address: info.address });
		}
	}
	const rank = (name: string) => (/^(wl|en|eth)/.test(name) ? 0 : 1);
	candidates.sort((a, b) => rank(a.name) - rank(b.name));
	return candidates[0]?.address;
}

// `pi --export` ignores the user's theme and renders with the black ANSI "system" theme,
// and the themed exporter is not part of pi's public API, so load it from pi's dist dir.
async function exportSnapshot(ctx: ExtensionCommandContext, outputPath: string): Promise<void> {
	const cliPath = realpathSync(process.argv[1]);
	const distDir = cliPath.slice(0, cliPath.lastIndexOf(`${sep}dist${sep}`) + `${sep}dist`.length);
	const exporter = await import(pathToFileURL(join(distDir, "core", "export-html", "index.js")).href);
	await exporter.exportSessionToHtml(ctx.sessionManager, undefined, {
		outputPath,
		themeName: ctx.ui.theme.name,
	});
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function stateFileFor(sessionFile: string): string {
	return join(STATE_DIR, `${basename(sessionFile, ".jsonl")}.json`);
}

async function readState(stateFile: string): Promise<ShareState | undefined> {
	try {
		const state = JSON.parse(await readFile(stateFile, "utf8")) as ShareState;
		if (isAlive(state.pid) && state.expiresAt > Date.now()) return state;
	} catch {}
	await rm(stateFile, { force: true });
	return undefined;
}

async function listShares(): Promise<ShareState[]> {
	let files: string[];
	try {
		files = await readdir(STATE_DIR);
	} catch {
		return [];
	}
	const states = await Promise.all(
		files.filter((f) => f.endsWith(".json")).map((f) => readState(join(STATE_DIR, f))),
	);
	return states.filter((s): s is ShareState => s !== undefined).sort((a, b) => a.expiresAt - b.expiresAt);
}

async function stopShare(stateFile: string): Promise<boolean> {
	const state = await readState(stateFile);
	if (!state) return false;
	process.kill(state.pid, "SIGTERM");
	return true;
}

async function stopAllShares(): Promise<number> {
	const shares = await listShares();
	for (const share of shares) process.kill(share.pid, "SIGTERM");
	return shares.length;
}

export default function (pi: ExtensionAPI) {
	async function copyToClipboard(text: string): Promise<boolean> {
		const result = await pi.exec("sh", ["-c", `printf %s "$1" | wl-copy`, "sh", text], { timeout: 3_000 });
		return result.code === 0;
	}

	async function waitForState(stateFile: string): Promise<ShareState> {
		for (let i = 0; i < 100; i++) {
			try {
				return JSON.parse(await readFile(stateFile, "utf8")) as ShareState;
			} catch {
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		throw new Error("share server did not start");
	}

	async function start(durationMs: number, sessionFile: string, ctx: ExtensionCommandContext) {
		const stateFile = stateFileFor(sessionFile);
		await stopShare(stateFile);
		await mkdir(STATE_DIR, { recursive: true });

		const slug = randomBytes(6).toString("base64url");
		const outputPath = join(STATE_DIR, `${slug}.html`);
		const host = lanAddress() ?? "127.0.0.1";
		const sessionName = pi.getSessionName() ?? basename(sessionFile, ".jsonl");

		try {
			await exportSnapshot(ctx, outputPath);
		} catch (err) {
			ctx.ui.notify(`Export failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}

		const child = spawn(
			process.execPath,
			[SERVER_SCRIPT, outputPath, slug, String(durationMs), host, stateFile, sessionFile, sessionName],
			{ detached: true, stdio: "ignore" },
		);
		child.unref();

		try {
			const state = await waitForState(stateFile);
			const copied = await copyToClipboard(state.url);
			ctx.ui.notify(
				`Sharing on LAN for ${formatRemaining(durationMs)}: ${state.url}${copied ? " (copied)" : ""}`,
				"info",
			);
		} catch (err) {
			ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		}
	}

	pi.registerCommand("lshare", {
		description: `Serve a snapshot of this session as HTML on the LAN, survives pi exit. Usage: /lshare [duration|stop|stop all|status] (default ${DEFAULT_DURATION})`,
		getArgumentCompletions: (prefix) => {
			const items = ["30m", "1h", "2h", "4h", "8h", "stop", "stop all", "status"].map((v) => ({ value: v, label: v }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("Cannot share an in-memory session", "error");
				return;
			}
			const stateFile = stateFileFor(sessionFile);
			const arg = args.trim();

			if (/^stop\s+all$/.test(arg)) {
				const count = await stopAllShares();
				ctx.ui.notify(count > 0 ? `Stopped ${count} share${count === 1 ? "" : "s"}` : "No active shares", "info");
				return;
			}
			if (arg === "stop") {
				const stopped = await stopShare(stateFile);
				ctx.ui.notify(stopped ? "Local share stopped" : "No active share", "info");
				return;
			}
			if (arg === "status") {
				const shares = await listShares();
				if (shares.length === 0) {
					ctx.ui.notify("No active shares", "info");
					return;
				}
				const lines = shares.map((s) => {
					const marker = s.sessionFile === sessionFile ? "* " : "  ";
					return `${marker}${s.url}  ${formatRemaining(s.expiresAt - Date.now())} left  ${s.sessionName}`;
				});
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			const durationMs = parseDuration(arg || DEFAULT_DURATION);
			if (durationMs === undefined || durationMs <= 0) {
				ctx.ui.notify(`Invalid duration "${arg}". Examples: 30m, 1h, 2h`, "error");
				return;
			}
			await start(durationMs, sessionFile, ctx);
		},
	});
}
