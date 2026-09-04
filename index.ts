import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DURATION = "1h";
const STATE_DIR = join(tmpdir(), "pi-lshare");
const SERVER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");

interface ShareState {
	pid: number;
	url: string;
	expiresAt: number;
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

async function stopShare(stateFile: string): Promise<boolean> {
	const state = await readState(stateFile);
	if (!state) return false;
	process.kill(state.pid, "SIGTERM");
	return true;
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

		const child = spawn(
			process.execPath,
			[SERVER_SCRIPT, sessionFile, slug, String(durationMs), host, stateFile, outputPath],
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
		description: `Serve this session as HTML on the LAN, survives pi exit. Usage: /lshare [duration|stop|status] (default ${DEFAULT_DURATION})`,
		getArgumentCompletions: (prefix) => {
			const items = ["30m", "1h", "2h", "4h", "8h", "stop", "status"].map((v) => ({ value: v, label: v }));
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

			if (arg === "stop") {
				const stopped = await stopShare(stateFile);
				ctx.ui.notify(stopped ? "Local share stopped" : "No active share", "info");
				return;
			}
			if (arg === "status") {
				const state = await readState(stateFile);
				ctx.ui.notify(
					state ? `${state.url} expires in ${formatRemaining(state.expiresAt - Date.now())}` : "No active share",
					"info",
				);
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
