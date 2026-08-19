/**
 * Headless checks for the graph builders and the orbital layout.
 *
 * These run the real src/ code against a synthetic vault, so they catch tree
 * corruption, overlapping subsystems and bad orbital maths without needing
 * Obsidian or a GPU. Run with `npm test`.
 */
import { Object3D, Vector3 } from "three";
import { App, TFile, TFolder } from "obsidian";
import {
	buildFolderGraph,
	buildLinkGraph,
	walkGraph,
	type SolarGraph,
	type SolarNode,
} from "../src/graph";
import { layoutGraph } from "../src/layout";
import { styleOf } from "../src/classify";
import { DEFAULT_SETTINGS, type SolarGraphSettings } from "../src/settings";

let failures = 0;
let checks = 0;

function check(condition: boolean, message: string) {
	checks++;
	if (!condition) {
		failures++;
		console.error(`  FAIL  ${message}`);
	}
}

function section(name: string) {
	console.log(`\n${name}`);
}

// ---------------------------------------------------------------------------
// A synthetic vault: one dense hub, a deep chain, a wide fan-out, two isolated
// components, cycles, self-links and unresolved links.
// ---------------------------------------------------------------------------

interface MockVault {
	resolvedLinks: Record<string, Record<string, number>>;
	unresolvedLinks: Record<string, Record<string, number>>;
	files: string[];
}

function makeVault(): MockVault {
	const resolvedLinks: Record<string, Record<string, number>> = {};
	const unresolvedLinks: Record<string, Record<string, number>> = {};
	const files: string[] = [];

	const add = (path: string) => {
		if (!resolvedLinks[path]) resolvedLinks[path] = {};
		if (!files.includes(path)) files.push(path);
		return path;
	};
	const link = (from: string, to: string) => {
		add(from);
		add(to);
		resolvedLinks[from][to] = (resolvedLinks[from][to] ?? 0) + 1;
	};

	// Hub with 6 MOCs, each with a handful of notes.
	const hub = add("Home.md");
	for (let m = 0; m < 6; m++) {
		const moc = add(`MOCs/moc-${m}.md`);
		link(hub, moc);
		link(moc, hub); // cycle back to the hub
		for (let n = 0; n < 5 + m * 3; n++) {
			const note = add(`notes/note-${m}-${n}.md`);
			link(moc, note);
			if (n > 0) link(note, `notes/note-${m}-${n - 1}.md`); // sibling cycles
		}
		unresolvedLinks[moc] = { [`Planned ${m}`]: 1, "Shared ghost": 1 };
	}

	// A deep chain, to exercise nesting depth and shrinking scales.
	let previous = hub;
	for (let d = 0; d < 9; d++) {
		const deep = add(`chain/deep-${d}.md`);
		link(previous, deep);
		previous = deep;
	}

	// A wide fan-out that must fall back to shared rings.
	const wide = add("wide/wide-hub.md");
	link(hub, wide);
	for (let i = 0; i < 60; i++) link(wide, add(`wide/leaf-${i}.md`));

	// Two components with no path to the hub at all.
	link("islands/a1.md", "islands/a2.md");
	link("islands/a2.md", "islands/a3.md");
	link("islands/a3.md", "islands/a1.md");
	link("islands/b1.md", "islands/b2.md");

	// Degenerate cases: a self-link, and a note whose only link is to a note that
	// doesn't exist (so it is *not* rogue — it has a ghost orbiting it).
	link(hub, hub);
	add("lonely/orphan.md");
	unresolvedLinks["lonely/orphan.md"] = { "Never written": 1 };

	// Genuinely unlinked notes: no links in, none out. These become the belt.
	for (let i = 0; i < 25; i++) add(`rogue/rock-${i}.md`);

	return { resolvedLinks, unresolvedLinks, files };
}

function makeFolderTree(files: string[]): TFolder {
	const root = new TFolder();
	root.path = "/";
	root.name = "TestVault";
	const folders = new Map<string, TFolder>([["", root]]);

	const folderFor = (dir: string): TFolder => {
		if (folders.has(dir)) return folders.get(dir)!;
		const cut = dir.lastIndexOf("/");
		const parentDir = cut === -1 ? "" : dir.slice(0, cut);
		const parent = folderFor(parentDir);
		const folder = new TFolder();
		folder.path = dir;
		folder.name = cut === -1 ? dir : dir.slice(cut + 1);
		folder.parent = parent;
		parent.children.push(folder);
		folders.set(dir, folder);
		return folder;
	};

	for (const path of files) {
		const cut = path.lastIndexOf("/");
		const parent = folderFor(cut === -1 ? "" : path.slice(0, cut));
		const file = new TFile();
		file.path = path;
		file.name = cut === -1 ? path : path.slice(cut + 1);
		file.extension = path.slice(path.lastIndexOf(".") + 1);
		file.basename = file.name.replace(/\.[^.]+$/, "");
		file.parent = parent;
		parent.children.push(file);
	}
	// A couple of attachments, which should be excluded by default.
	for (const name of ["attachments/diagram.png", "attachments/paper.pdf"]) {
		const cut = name.lastIndexOf("/");
		const parent = folderFor(name.slice(0, cut));
		const file = new TFile();
		file.path = name;
		file.name = name.slice(cut + 1);
		file.extension = name.slice(name.lastIndexOf(".") + 1);
		file.basename = file.name.replace(/\.[^.]+$/, "");
		file.parent = parent;
		parent.children.push(file);
	}
	return root;
}

function makeApp(vault: MockVault): App {
	const root = makeFolderTree(vault.files);
	const markdown = vault.files.map((path) => {
		const file = new TFile();
		file.path = path;
		file.extension = "md";
		return file;
	});
	return {
		metadataCache: {
			resolvedLinks: vault.resolvedLinks,
			unresolvedLinks: vault.unresolvedLinks,
		},
		vault: {
			getName: () => "TestVault",
			getMarkdownFiles: () => markdown,
			getRoot: () => root,
		},
	} as unknown as App;
}

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

function assertWellFormedTree(graph: SolarGraph, label: string) {
	const seen = new Set<string>();
	let duplicates = 0;
	let badDepth = 0;
	let badParent = 0;
	let badSubtree = 0;

	const visit = (node: SolarNode, expectedDepth: number) => {
		if (seen.has(node.id)) duplicates++;
		seen.add(node.id);
		if (node.depth !== expectedDepth) badDepth++;
		let size = 1;
		for (const child of node.children) {
			if (child.parent !== node) badParent++;
			visit(child, expectedDepth + 1);
			size += child.subtreeSize;
		}
		if (node.subtreeSize !== size) badSubtree++;
	};
	for (const star of graph.stars) {
		if (star.parent !== null) badParent++;
		visit(star, 0);
	}

	check(duplicates === 0, `${label}: every node appears once (found ${duplicates} repeats)`);
	check(badDepth === 0, `${label}: depth equals distance from the star (${badDepth} wrong)`);
	check(badParent === 0, `${label}: parent pointers agree with children (${badParent} wrong)`);
	check(badSubtree === 0, `${label}: subtree sizes are correct (${badSubtree} wrong)`);
	check(
		seen.size === graph.nodes.size,
		`${label}: node map matches the tree (${seen.size} reachable vs ${graph.nodes.size} mapped)`
	);
}

/**
 * The core layout guarantee: sibling subsystems occupy disjoint annuli, so their
 * bounding spheres cannot intersect at any phase or tilt. Same-radius siblings
 * (shared rings) instead rely on angular separation, which is constant because
 * equal radii mean equal orbital speed.
 */
function assertNoOverlap(graph: SolarGraph, label: string) {
	let annulusClashes = 0;
	let ringClashes = 0;
	let parentClashes = 0;
	let nonCoplanar = 0;

	walkGraph(graph, (node) => {
		for (const child of node.children) {
			if (child.orbitRadius - child.systemRadius <= node.bodyRadius) parentClashes++;
		}
		for (let i = 0; i < node.children.length; i++) {
			for (let j = i + 1; j < node.children.length; j++) {
				const a = node.children[i];
				const b = node.children[j];
				const sameRing = Math.abs(a.orbitRadius - b.orbitRadius) < 1e-6;
				if (sameRing) {
					// Co-orbital bodies must share a plane, or their circles cross.
					if (
						Math.abs(a.inclination - b.inclination) > 1e-9 ||
						Math.abs(a.ascendingNode - b.ascendingNode) > 1e-9
					) {
						nonCoplanar++;
					}
					// Chord between two bodies on the same ring.
					const delta = Math.abs(a.phase - b.phase);
					const chord = 2 * a.orbitRadius * Math.abs(Math.sin(delta / 2));
					if (chord < a.systemRadius + b.systemRadius) ringClashes++;
				} else if (
					Math.abs(a.orbitRadius - b.orbitRadius) <
					a.systemRadius + b.systemRadius
				) {
					annulusClashes++;
				}
			}
		}
	});

	check(parentClashes === 0, `${label}: no subsystem swallows its parent (${parentClashes})`);
	check(annulusClashes === 0, `${label}: sibling annuli are disjoint (${annulusClashes} clashes)`);
	check(ringClashes === 0, `${label}: shared-ring siblings stay apart (${ringClashes} clashes)`);
	check(nonCoplanar === 0, `${label}: co-orbital siblings share a plane (${nonCoplanar} don't)`);
}

/**
 * Mirrors the transform chain built in scene.ts: tilt (YXZ) -> spin(y) ->
 * anchor at (r, 0, 0). Verifying it here proves the Euler convention actually
 * produces a circular orbit of the intended radius about the parent.
 */
function buildTransforms(graph: SolarGraph) {
	const anchors = new Map<string, Object3D>();
	const root = new Object3D();

	const add = (node: SolarNode, parentAnchor: Object3D) => {
		const tilt = new Object3D();
		tilt.rotation.order = "YXZ";
		tilt.rotation.set(node.inclination, node.ascendingNode, 0);
		parentAnchor.add(tilt);
		const spin = new Object3D();
		spin.rotation.y = node.phase;
		tilt.add(spin);
		const anchor = new Object3D();
		anchor.position.x = node.orbitRadius;
		anchor.position.y = node.verticalOffset;
		spin.add(anchor);
		anchor.userData.node = node;
		anchors.set(node.id, anchor);
		for (const child of node.children) add(child, anchor);
	};
	for (const star of graph.stars) add(star, root);
	return { root, anchors };
}

function advance(graph: SolarGraph, anchors: Map<string, Object3D>, simTime: number) {
	walkGraph(graph, (node) => {
		const anchor = anchors.get(node.id);
		if (!anchor) return;
		// anchor -> spin is the parent of the anchor in the chain above.
		const spin = anchor.parent!;
		spin.rotation.y = node.phase + node.angularSpeed * simTime;
	});
}

function assertOrbitGeometry(graph: SolarGraph, label: string) {
	const { root, anchors } = buildTransforms(graph);
	const times = [0, 1.7, 9.3, 41.5, 260];
	let radiusErrors = 0;
	let intersections = 0;
	let worstGap = Infinity;
	const offenders: string[] = [];

	const positions: Array<{ node: SolarNode; point: Vector3 }> = [];
	const scratch = new Vector3();

	for (const time of times) {
		advance(graph, anchors, time);
		root.updateMatrixWorld(true);

		// Each body must keep a fixed distance from its parent, always. Belt debris
		// is lifted off its ring, so that distance is the hypotenuse.
		walkGraph(graph, (node) => {
			if (!node.parent) return;
			const here = anchors.get(node.id)!.getWorldPosition(new Vector3());
			const there = anchors.get(node.parent.id)!.getWorldPosition(scratch);
			const expected = Math.hypot(node.orbitRadius, node.verticalOffset);
			if (Math.abs(here.distanceTo(there) - expected) > 1e-4) radiusErrors++;
		});

		// Brute-force overlap check between every pair that isn't an ancestor.
		positions.length = 0;
		walkGraph(graph, (node) => {
			positions.push({
				node,
				point: anchors.get(node.id)!.getWorldPosition(new Vector3()),
			});
		});
		for (let i = 0; i < positions.length; i++) {
			for (let j = i + 1; j < positions.length; j++) {
				const a = positions[i];
				const b = positions[j];
				if (isAncestor(a.node, b.node) || isAncestor(b.node, a.node)) continue;
				const gap =
					a.point.distanceTo(b.point) - (a.node.bodyRadius + b.node.bodyRadius);
				if (gap < 0) {
					intersections++;
					if (offenders.length < 6) offenders.push(describePair(a.node, b.node, gap));
				}
				if (gap < worstGap) worstGap = gap;
			}
		}
	}
	for (const line of offenders) console.log(`  overlap: ${line}`);

	check(radiusErrors === 0, `${label}: orbit radius holds over time (${radiusErrors} errors)`);
	check(
		intersections === 0,
		`${label}: no two bodies ever intersect (${intersections} at ${times.length} sampled times)`
	);
	console.log(`  tightest gap between any two bodies: ${worstGap.toFixed(3)} units`);
}

function describePair(a: SolarNode, b: SolarNode, gap: number): string {
	const show = (n: SolarNode) =>
		`${n.id} (d${n.depth}, parent=${n.parent?.id ?? "—"}, r=${n.orbitRadius.toFixed(2)}, body=${n.bodyRadius.toFixed(2)}, sys=${n.systemRadius.toFixed(2)})`;
	return `${show(a)}  vs  ${show(b)}  gap ${gap.toFixed(3)}`;
}

function isAncestor(maybe: SolarNode, node: SolarNode): boolean {
	let cursor = node.parent;
	while (cursor) {
		if (cursor === maybe) return true;
		cursor = cursor.parent;
	}
	return false;
}

function assertKepler(graph: SolarGraph, label: string) {
	let violations = 0;
	walkGraph(graph, (node) => {
		const moving = node.children
			.filter((c) => c.angularSpeed !== 0)
			.sort((a, b) => a.orbitRadius - b.orbitRadius);
		for (let i = 1; i < moving.length; i++) {
			if (Math.abs(moving[i].orbitRadius - moving[i - 1].orbitRadius) < 1e-9) continue;
			// Strictly slower the further out you go.
			if (Math.abs(moving[i].angularSpeed) >= Math.abs(moving[i - 1].angularSpeed)) {
				violations++;
			}
		}
	});
	check(violations === 0, `${label}: outer orbits run slower than inner ones (${violations})`);
}

// ---------------------------------------------------------------------------

const vault = makeVault();
const app = makeApp(vault);
const settings: SolarGraphSettings = { ...DEFAULT_SETTINGS };

section("Link mode — root selection");
const autoRoot = buildLinkGraph(app, settings, null);
// wide/wide-hub.md has 61 links against Home.md's 16, so it wins on degree.
check(
	autoRoot.stars[0].id === "wide/wide-hub.md",
	`the most connected note becomes the primary star (got ${autoRoot.stars[0].id})`
);
// Two link islands plus the fully isolated orphan, each its own star.
check(
	autoRoot.stars.length === 4,
	`disconnected components each get a star (got ${autoRoot.stars.length})`
);

section("Link mode");
// Rooted explicitly at the hub note so the rest of the assertions are stable.
const links = buildLinkGraph(app, settings, "Home.md");
console.log(
	`  ${links.nodeCount} bodies, ${links.stars.length} systems, ${links.crossLinks.length} cross-links`
);
assertWellFormedTree(links, "link tree");
check(!links.truncated, "nothing truncated below the node cap");

const ghosts = [...links.nodes.values()].filter((n) => n.kind === "unresolved");
check(ghosts.length > 0, `unresolved links appear as bodies (got ${ghosts.length})`);
check(
	ghosts.every((g) => g.children.length === 0),
	"unresolved bodies are always leaves"
);
check(
	new Set(ghosts.map((g) => g.id)).size === ghosts.length,
	"a link shared by several notes yields exactly one ghost"
);

for (const path of vault.files) {
	if (!links.nodes.has(path)) {
		check(false, `every vault note is placed somewhere (${path} is missing)`);
		break;
	}
}
check(
	vault.files.every((path) => links.nodes.has(path)),
	"every vault note is placed somewhere, including orphans"
);

const treeEdge = new Set<string>();
walkGraph(links, (node) => {
	if (node.parent) treeEdge.add(`${node.parent.id}>${node.id}`);
});
const crossOverlap = links.crossLinks.filter(
	([a, b]) => treeEdge.has(`${a}>${b}`) || treeEdge.has(`${b}>${a}`)
);
check(crossOverlap.length === 0, `cross-links never duplicate an orbit (${crossOverlap.length})`);
check(
	links.crossLinks.every(([a, b]) => a !== b),
	"self-links are not drawn as cross-links"
);

section("Link mode — determinism");
const again = buildLinkGraph(makeApp(makeVault()), { ...DEFAULT_SETTINGS }, "Home.md");
layoutGraph(again, { ...DEFAULT_SETTINGS });
const fingerprint = (graph: SolarGraph) => {
	const rows: string[] = [];
	walkGraph(graph, (node) => {
		rows.push(
			`${node.id}|${node.parent?.id ?? ""}|${node.orbitRadius.toFixed(4)}|${node.phase.toFixed(4)}|${node.inclination.toFixed(4)}`
		);
	});
	return rows.sort().join("\n");
};
const firstLayout = layoutGraph(links, settings);
check(
	fingerprint(links) === fingerprint(again),
	"the same vault always produces the identical system"
);

section("Link mode — layout");
console.log(`  extent ${firstLayout.extent.toFixed(1)} units, max depth ${firstLayout.maxDepth}`);
assertNoOverlap(links, "layout");
assertKepler(links, "layout");
assertOrbitGeometry(links, "layout");

const wideHub = links.nodes.get("wide/wide-hub.md")!;
const rings = new Set(wideHub.children.map((c) => c.orbitRadius.toFixed(4)));
check(
	wideHub.children.length === 60,
	`the wide hub keeps all 60 children (got ${wideHub.children.length})`
);
check(
	rings.size <= 10,
	`a 60-child fan-out shares rings instead of sprawling (${rings.size} rings)`
);
// Belt debris shares orbits on purpose, so only the planets are checked here.
const smallFamily = links.nodes.get("Home.md")!.children.filter((c) => !c.inBelt);
check(
	new Set(smallFamily.map((c) => c.orbitRadius.toFixed(4))).size === smallFamily.length,
	"a small family gets one body per orbit"
);

section("Body classes");
const styleFor = (id: string) => styleOf(links.nodes.get(id)!);
check(styleFor("Home.md").kind === "star", "the root note is the star");
// wide-hub carries 60 descendants, well past the default threshold of 14.
check(
	styleFor("wide/wide-hub.md").kind === "star",
	`a note carrying a whole region ignites as a star (got ${styleFor("wide/wide-hub.md").kind})`
);
check(
	styleFor("wide/wide-hub.md").sizeScale > 1.5,
	"a star below the root is scaled back up so it reads as a star"
);
check(
	styleFor("Home.md").sizeScale === 1,
	"the root star keeps its natural size — it isn't shrunk by a generation"
);
// moc-0 has 5 children, moc-1 has 8.
check(
	styleFor("MOCs/moc-0.md").kind === "ice-giant",
	`5 children makes a ringed ice giant (got ${styleFor("MOCs/moc-0.md").kind})`
);
check(styleFor("MOCs/moc-0.md").hasRings, "ice giants get rings too");
check(
	styleFor("MOCs/moc-1.md").kind === "gas-giant",
	`8 children crosses into gas giant (got ${styleFor("MOCs/moc-1.md").kind})`
);
check(styleFor("MOCs/moc-1.md").hasRings, "gas giants get rings");
check(
	styleFor("chain/deep-8.md").kind === "icy",
	`a childless leaf is an ice moon (got ${styleFor("chain/deep-8.md").kind})`
);
check(
	styleFor("chain/deep-7.md").kind === "rocky",
	`one child makes a rocky world (got ${styleFor("chain/deep-7.md").kind})`
);
check(
	styleFor("rogue/rock-3.md").kind === "asteroid",
	`an unlinked note is an asteroid (got ${styleFor("rogue/rock-3.md").kind})`
);
check(styleFor("rogue/rock-3.md").irregular, "asteroids get a lumpy shape");
const ghost = [...links.nodes.values()].find((n) => n.kind === "unresolved")!;
check(styleOf(ghost).kind === "ghost", "unresolved links stay ghosts, not asteroids");
check(
	[...links.nodes.values()].every((n) => n.style !== null),
	"every node is classified during the build"
);

section("Star threshold");
// Same vault, no nested stars: the big hub falls back to being a giant.
const noNested = buildLinkGraph(app, { ...DEFAULT_SETTINGS, starSubtreeSize: 1 }, "Home.md");
const nestedStars = (graph: SolarGraph) =>
	[...graph.nodes.values()].filter((n) => n.parent !== null && styleOf(n).kind === "star");
check(
	nestedStars(noNested).length === 0,
	`a threshold of 1 leaves only root stars (got ${nestedStars(noNested).length})`
);
check(
	styleOf(noNested.nodes.get("wide/wide-hub.md")!).kind === "gas-giant",
	"with nested stars off, a 60-child note is a gas giant again"
);
check(nestedStars(links).length > 0, "the default threshold does produce nested stars");

// A low threshold should light up more of the tree, never less.
const eager = buildLinkGraph(app, { ...DEFAULT_SETTINGS, starSubtreeSize: 4 }, "Home.md");
check(
	nestedStars(eager).length >= nestedStars(links).length,
	`lowering the threshold makes more stars (${nestedStars(eager).length} vs ${nestedStars(links).length})`
);
check(
	nestedStars(eager).every((n) => n.subtreeSize >= 4),
	"nothing becomes a star below the threshold"
);
layoutGraph(eager, { ...DEFAULT_SETTINGS, starSubtreeSize: 4 });
assertWellFormedTree(eager, "many-stars tree");
assertNoOverlap(eager, "many-stars layout");
assertOrbitGeometry(eager, "many-stars layout");

section("Asteroid belt");
const beltMembers = [...links.nodes.values()].filter((n) => n.inBelt);
check(beltMembers.length === 25, `all 25 unlinked notes join the belt (got ${beltMembers.length})`);
check(
	beltMembers.every((n) => n.parent === links.stars[0]),
	"belt debris orbits the primary star"
);
check(
	links.stars.every((s) => !s.rogue || s.children.length > 0),
	"an unlinked note never becomes a star of its own"
);
check(
	!links.nodes.get("lonely/orphan.md")!.rogue,
	"a note whose only link is unresolved is not rogue — it has a ghost orbiting it"
);
const beltRadii = new Set(beltMembers.map((n) => n.orbitRadius.toFixed(4)));
check(
	beltRadii.size >= 1 && beltRadii.size <= 7,
	`the belt uses a handful of tight sub-rings (got ${beltRadii.size})`
);
check(
	beltMembers.every((n) => n.verticalOffset !== 0),
	"belt debris is scattered off its ring, giving the belt thickness"
);
check(
	[...links.nodes.values()].every((n) => n.inBelt || n.verticalOffset === 0),
	"nothing outside the belt is displaced"
);
// The belt should have worlds on both sides of it, not sit inside or beyond them all.
const beltInner = Math.min(...beltMembers.map((n) => n.orbitRadius));
const beltOuter = Math.max(...beltMembers.map((n) => n.orbitRadius));
const planetRadii = links.stars[0].children
	.filter((c) => !c.inBelt)
	.map((c) => c.orbitRadius);
check(
	planetRadii.some((r) => r < beltInner) && planetRadii.some((r) => r > beltOuter),
	"planets orbit both inside and outside the belt"
);

section("Vault of nothing but unlinked notes");
const allRogue = buildLinkGraph(
	makeApp({
		resolvedLinks: {},
		unresolvedLinks: {},
		files: ["a.md", "b.md", "c.md"],
	}),
	settings,
	null
);
check(allRogue.stars.length === 1, "something still anchors the centre");
check(allRogue.nodeCount === 3, "and no note is lost");
assertWellFormedTree(allRogue, "all-rogue tree");
layoutGraph(allRogue, settings);
assertNoOverlap(allRogue, "all-rogue layout");

section("Link mode — outgoing only");
const outgoing = buildLinkGraph(app, { ...DEFAULT_SETTINGS, linkDirection: "outgoing" }, null);
assertWellFormedTree(outgoing, "outgoing tree");
layoutGraph(outgoing, { ...DEFAULT_SETTINGS, linkDirection: "outgoing" });
assertNoOverlap(outgoing, "outgoing layout");

section("Link mode — explicit root");
const rerooted = buildLinkGraph(app, settings, "wide/wide-hub.md");
check(
	rerooted.stars[0].id === "wide/wide-hub.md",
	`an explicit root becomes the star (got ${rerooted.stars[0].id})`
);
assertWellFormedTree(rerooted, "re-rooted tree");
const missingRoot = buildLinkGraph(app, settings, "does/not/exist.md");
check(
	missingRoot.stars[0].id === "wide/wide-hub.md",
	"a stale root falls back to the hub instead of failing"
);

section("Truncation");
const capped = buildLinkGraph(app, { ...DEFAULT_SETTINGS, maxNodes: 40 }, null);
check(capped.truncated, "the node cap reports truncation");
check(capped.nodeCount <= 40, `the node cap is respected (got ${capped.nodeCount})`);
assertWellFormedTree(capped, "truncated tree");
layoutGraph(capped, { ...DEFAULT_SETTINGS, maxNodes: 40 });
assertNoOverlap(capped, "truncated layout");

section("Folder mode");
const folders = buildFolderGraph(app, settings);
console.log(`  ${folders.nodeCount} bodies, ${folders.crossLinks.length} cross-links`);
assertWellFormedTree(folders, "folder tree");
check(folders.stars.length === 1, "the vault root is the only star");
check(folders.stars[0].label === "TestVault", "the star is named after the vault");
check(
	!folders.nodes.has("attachments/diagram.png"),
	"attachments are excluded by default"
);
const withAttachments = buildFolderGraph(app, {
	...DEFAULT_SETTINGS,
	includeAttachments: true,
});
check(
	withAttachments.nodes.has("attachments/diagram.png"),
	"attachments appear when enabled"
);
const notesFolder = folders.nodes.get("folder:notes");
check(!!notesFolder, "nested folders become bodies");
check(
	(notesFolder?.children.length ?? 0) > 0,
	"folder bodies carry their files as satellites"
);
layoutGraph(folders, settings);
assertNoOverlap(folders, "folder layout");
assertKepler(folders, "folder layout");
assertOrbitGeometry(folders, "folder layout");

section("Extremes");
for (const tweak of [
	{ label: "flat (no tilt)", patch: { inclinationSpread: 0 } },
	{ label: "max tilt", patch: { inclinationSpread: 60 } },
	{ label: "tiny bodies", patch: { bodyScale: 0.3 } },
	{ label: "huge bodies", patch: { bodyScale: 3 } },
	{ label: "tight spacing", patch: { orbitSpacing: 1 } },
	{ label: "loose spacing", patch: { orbitSpacing: 16 } },
] as const) {
	const config = { ...DEFAULT_SETTINGS, ...tweak.patch };
	const graph = buildLinkGraph(app, config, null);
	layoutGraph(graph, config);
	assertNoOverlap(graph, tweak.label);
}

const empty = buildLinkGraph(
	{
		metadataCache: { resolvedLinks: {}, unresolvedLinks: {} },
		vault: { getName: () => "Empty", getMarkdownFiles: () => [], getRoot: () => new TFolder() },
	} as unknown as App,
	settings,
	null
);
check(empty.nodeCount === 0, "an empty vault produces no bodies instead of throwing");
const emptyLayout = layoutGraph(empty, settings);
check(emptyLayout.extent > 0, "an empty vault still yields a usable camera extent");

console.log(
	`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed`
);
process.exit(failures === 0 ? 0 : 1);
