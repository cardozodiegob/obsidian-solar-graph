// Feeds the running plugin a synthetic vault so every body class can be seen at
// once — the real vault has no unlinked notes and nothing with enough children to
// become a giant. Nothing is written to disk: the metadata cache is swapped out,
// the view is rebuilt, and then everything is put back.
//
// Usage:  node test/inspect.mjs test/demo-graph.js shot.png
//         node test/inspect.mjs test/demo-graph.js shot.png   (then restore.js)
(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const leaf = window.app.workspace.getLeavesOfType("solar-graph-view")[0];
	if (!leaf) return "no solar graph view open";
	const view = leaf.view;
	const cache = window.app.metadataCache;
	const vault = window.app.vault;

	// --- build the synthetic vault ---------------------------------------
	const resolved = {};
	const unresolved = {};
	const files = new Set();
	const add = (p) => {
		files.add(p);
		resolved[p] = resolved[p] ?? {};
		return p;
	};
	const link = (a, b) => {
		add(a);
		add(b);
		resolved[a][b] = 1;
	};

	const star = add("Atlas.md");
	// A note's body class comes from how many notes orbit it, so each of these
	// hubs is given a different number of children.
	const plan = [
		["Alpha", 9], // gas giant + rings
		["Beta", 6], // ringed ice giant
		["Gamma", 3], // terrestrial
		["Delta", 1], // rocky
		["Epsilon", 0], // ice moon
		["Zeta", 0],
		["Eta", 0],
	];
	for (const [name, count] of plan) {
		const hub = add(`${name}.md`);
		link(star, hub);
		for (let i = 0; i < count; i++) {
			const child = add(`${name}/${name}-${i}.md`);
			link(hub, child);
		}
	}
	// A moon with its own ringed retinue, to show nesting two levels down.
	for (let i = 0; i < 5; i++) link("Alpha/Alpha-0.md", `Alpha/Alpha-0/moon-${i}.md`);
	// A note pointing at something unwritten: that becomes a ghost.
	unresolved["Gamma.md"] = { "Unwritten Idea": 1, "Someday Note": 1 };
	// Debris: no links in, none out.
	for (let i = 0; i < 30; i++) add(`rogue/rock-${i}.md`);

	// --- swap it in ------------------------------------------------------
	if (!window.__solarDemoBackup) {
		window.__solarDemoBackup = {
			resolvedLinks: cache.resolvedLinks,
			unresolvedLinks: cache.unresolvedLinks,
			getMarkdownFiles: vault.getMarkdownFiles,
			rootOverride: view.rootOverride,
			hierarchy: view.plugin.settings.hierarchy,
		};
	}
	cache.resolvedLinks = resolved;
	cache.unresolvedLinks = unresolved;
	vault.getMarkdownFiles = () => [...files].map((path) => ({ path, extension: "md" }));

	view.plugin.settings.hierarchy = "links";
	// Pin the root, or the most-linked note wins and it wouldn't be Atlas.
	view.rootOverride = "Atlas.md";
	view.rebuild();
	await sleep(2500);

	const classes = {};
	for (const [, body] of view.scene.bodies) {
		classes[body.style.kind] = (classes[body.style.kind] ?? 0) + 1;
	}
	const withRings = [...view.scene.bodies.values()].filter((b) => b.rings).length;

	return JSON.stringify(
		{
			status: document.querySelector(".solar-graph-status")?.innerText,
			bodies: view.scene.bodies.size,
			classes,
			withRings,
			particleFields: view.scene.particles.length,
			texturesLoaded: Object.keys(view.textures),
		},
		null,
		1
	);
})();
