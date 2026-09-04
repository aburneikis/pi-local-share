import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { promisify } from "node:util";

const [sessionFile, slug, durationMs, host, stateFile, outputPath, sessionName] = process.argv.slice(2);
const EXPORT_CACHE_MS = 5_000;
const run = promisify(execFile);

let cached;
async function getHtml() {
	if (cached && Date.now() - cached.at < EXPORT_CACHE_MS) return cached.html;
	await run("pi", ["--export", sessionFile, outputPath], { timeout: 60_000 });
	const html = await readFile(outputPath, "utf8");
	cached = { html, at: Date.now() };
	return html;
}

async function shutdown() {
	await Promise.all([rm(stateFile, { force: true }), rm(outputPath, { force: true })]);
	process.exit(0);
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

server.listen(0, "0.0.0.0", async () => {
	const { port } = server.address();
	const expiresAt = Date.now() + Number(durationMs);
	const url = `http://${host}:${port}/${slug}`;
	await writeFile(stateFile, JSON.stringify({ pid: process.pid, url, expiresAt, sessionFile, sessionName }));
	setTimeout(shutdown, Number(durationMs));
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
