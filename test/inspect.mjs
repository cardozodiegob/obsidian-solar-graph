/**
 * Drives a running Obsidian over the Chrome DevTools Protocol so changes can be
 * verified in the real app: evaluates an expression in the renderer, reports any
 * errors or warnings the page logged, and optionally saves a screenshot.
 *
 * Obsidian must be started with --remote-debugging-port=9222.
 *
 *   node test/inspect.mjs "window.app.plugins.plugins['solar-graph'] != null"
 *   node test/inspect.mjs "await something()" shot.png
 */
import { readFileSync, writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT ?? "9222";
const argument = process.argv[2] ?? "1";
// A path to a .js file is read and evaluated; anything else is the expression.
const expression = argument.endsWith(".js") ? readFileSync(argument, "utf8") : argument;
const screenshotPath = process.argv[3] ?? null;

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("index.html"));
if (!page) {
	console.error("No Obsidian page target found. Is it running with --remote-debugging-port?");
	process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const problems = [];
let nextId = 1;

function send(method, params = {}) {
	const id = nextId++;
	socket.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

socket.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	if (message.id && pending.has(message.id)) {
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) reject(new Error(JSON.stringify(message.error)));
		else resolve(message.result);
		return;
	}
	if (message.method === "Runtime.exceptionThrown") {
		const detail = message.params.exceptionDetails;
		problems.push(
			`EXCEPTION ${detail.exception?.description ?? detail.text} @ ${detail.url ?? "?"}`
		);
	}
	if (message.method === "Log.entryAdded") {
		const entry = message.params.entry;
		if (entry.level === "error" || entry.level === "warning") {
			problems.push(`${entry.level.toUpperCase()} ${entry.text} @ ${entry.url ?? "?"}`);
		}
	}
	if (message.method === "Runtime.consoleAPICalled") {
		const { type, args } = message.params;
		if (type === "error" || type === "warning") {
			const text = args.map((a) => a.description ?? a.value).join(" ");
			problems.push(`CONSOLE.${type.toUpperCase()} ${text}`);
		}
	}
});

await new Promise((resolve, reject) => {
	socket.addEventListener("open", resolve, { once: true });
	socket.addEventListener("error", reject, { once: true });
});

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
// A hidden or unfocused window gets no animation frames at all, so anything
// measuring frame rate reads zero. Bring it up first.
await send("Page.bringToFront").catch(() => {});

const result = await send("Runtime.evaluate", {
	expression,
	awaitPromise: true,
	returnByValue: true,
	userGesture: true,
});

if (result.exceptionDetails) {
	console.error("EVAL FAILED:", JSON.stringify(result.exceptionDetails.exception ?? result.exceptionDetails, null, 1));
} else {
	console.log("RESULT:", JSON.stringify(result.result.value, null, 1));
}

if (screenshotPath) {
	// fromSurface:false renders from the renderer rather than the OS window surface,
	// which is the only way to capture an occluded or background window. Obsidian
	// reports document.hidden while it's covered, and a hidden page gets no
	// animation frames at all — see the note about driving scene.tick() by hand.
	const shot = await send("Page.captureScreenshot", {
		format: "png",
		fromSurface: false,
		captureBeyondViewport: false,
	});
	writeFileSync(screenshotPath, Buffer.from(shot.data, "base64"));
	console.log("SCREENSHOT:", screenshotPath);
}

console.log(problems.length === 0 ? "PAGE LOG: clean" : `PAGE LOG: ${problems.length} problem(s)`);
for (const problem of problems.slice(0, 25)) console.log("  " + problem);

socket.close();
process.exit(0);
