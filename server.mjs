import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const [htmlPath, slug, durationMs, host, stateFile, sessionFile, sessionName] = process.argv.slice(2);
const html = await readFile(htmlPath, "utf8");

async function shutdown() {
	await Promise.all([rm(stateFile, { force: true }), rm(htmlPath, { force: true })]);
	process.exit(0);
}

const server = createServer((req, res) => {
	const path = (req.url ?? "/").split("?")[0];
	if (path !== `/${slug}` && path !== `/${slug}/`) {
		res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
		return;
	}
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html);
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
