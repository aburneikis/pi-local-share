import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_DURATION = "1h";
const EXPORT_CACHE_MS = 5_000;

interface Share {
	server: Server;
	url: string;
	expiresAt: number;
	timer: NodeJS.Timeout;
	ticker: NodeJS.Timeout;
	outputPath: string;
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

export default function (pi: ExtensionAPI) {
	let share: Share | undefined;

	function stop(ctx: ExtensionCommandContext | { ui: { setStatus(key: string, text?: string): void } }) {
		if (!share) return;
		clearTimeout(share.timer);
		clearInterval(share.ticker);
		share.server.close();
		void rm(share.outputPath, { force: true });
		share = undefined;
		ctx.ui.setStatus("lshare", undefined);
	}

	async function exportHtml(sessionFile: string, outputPath: string): Promise<string> {
		const result = await pi.exec("pi", ["--export", sessionFile, outputPath], { timeout: 60_000 });
		if (result.code !== 0) throw new Error(result.stderr || result.stdout || `pi --export exited ${result.code}`);
		return readFile(outputPath, "utf8");
	}

	async function copyToClipboard(text: string): Promise<boolean> {
		const result = await pi.exec("sh", ["-c", `printf %s "$1" | wl-copy`, "sh", text], { timeout: 3_000 });
		return result.code === 0;
	}

	async function start(durationMs: number, ctx: ExtensionCommandContext) {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			ctx.ui.notify("Cannot share an in-memory session", "error");
			return;
		}

		stop(ctx);

		const slug = randomBytes(6).toString("base64url");
		const outputPath = join(tmpdir(), `pi-lshare-${slug}.html`);

		let cached: { html: string; at: number } | undefined;
		const getHtml = async () => {
			if (cached && Date.now() - cached.at < EXPORT_CACHE_MS) return cached.html;
			const html = await exportHtml(sessionFile, outputPath);
			cached = { html, at: Date.now() };
			return html;
		};

		try {
			await getHtml();
		} catch (err) {
			ctx.ui.notify(`Export failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}

		const server = createServer(async (req, res) => {
			const path = (req.url ?? "/").split("?")[0];
			if (path !== `/${slug}` && path !== `/${slug}/`) {
				res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
				return;
			}
			try {
				const html = await getHtml();
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html);
			} catch (err) {
				res.writeHead(500, { "Content-Type": "text/plain" }).end(err instanceof Error ? err.message : String(err));
			}
		});

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "0.0.0.0", () => resolve());
		});

		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const host = lanAddress() ?? "127.0.0.1";
		const url = `http://${host}:${port}/${slug}`;
		const expiresAt = Date.now() + durationMs;

		const updateStatus = () => {
			if (!share) return;
			ctx.ui.setStatus("lshare", `share ${url} (${formatRemaining(share.expiresAt - Date.now())})`);
		};

		share = {
			server,
			url,
			expiresAt,
			outputPath,
			timer: setTimeout(() => {
				stop(ctx);
				ctx.ui.notify("Local share expired", "info");
			}, durationMs),
			ticker: setInterval(updateStatus, 1_000),
		};
		updateStatus();

		const copied = await copyToClipboard(url);
		ctx.ui.notify(`Sharing on LAN for ${formatRemaining(durationMs)}: ${url}${copied ? " (copied)" : ""}`, "info");
	}

	pi.registerCommand("lshare", {
		description: `Serve this session as HTML on the LAN. Usage: /lshare [duration|stop|status] (default ${DEFAULT_DURATION})`,
		getArgumentCompletions: (prefix) => {
			const items = ["30m", "1h", "2h", "4h", "8h", "stop", "status"].map((v) => ({ value: v, label: v }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "stop") {
				if (!share) {
					ctx.ui.notify("No active share", "info");
					return;
				}
				stop(ctx);
				ctx.ui.notify("Local share stopped", "info");
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(
					share ? `${share.url} expires in ${formatRemaining(share.expiresAt - Date.now())}` : "No active share",
					"info",
				);
				return;
			}
			const durationMs = parseDuration(arg || DEFAULT_DURATION);
			if (durationMs === undefined || durationMs <= 0) {
				ctx.ui.notify(`Invalid duration "${arg}". Examples: 30m, 1h, 2h`, "error");
				return;
			}
			await start(durationMs, ctx);
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stop(ctx);
	});
}
