import { App, TFile, TFolder, TAbstractFile } from "obsidian";
import { classify, type BodyStyle } from "./classify";
import type { SolarGraphSettings } from "./settings";

export type NodeKind = "file" | "folder" | "unresolved" | "vault";

/**
 * A single body in the solar system. `children` are the bodies that orbit it.
 * The tree is always acyclic by construction — see the builders below.
 */
export interface SolarNode {
	/** Stable, unique key. File nodes use the vault path so selection survives rebuilds. */
	id: string;
	label: string;
	/** Vault path of an openable file, or null for folders / unresolved links. */
	path: string | null;
	kind: NodeKind;
	depth: number;
	/** Number of graph links touching this node (folder mode: number of children). */
	degree: number;
	children: SolarNode[];
	parent: SolarNode | null;
	/** Number of nodes in this subtree, including itself. */
	subtreeSize: number;
	/** Nothing links to it and it links to nothing — debris. */
	rogue: boolean;
	/** Relocated into the asteroid belt around the primary star (link mode only). */
	inBelt: boolean;
	/** How this note renders. Assigned once the tree is complete. */
	style: BodyStyle | null;

	// --- filled in by layout.ts ---
	bodyRadius: number;
	/** Distance from the parent's centre. 0 for stars. */
	orbitRadius: number;
	/** Radius of the whole subsystem, used to pack siblings without overlap. */
	systemRadius: number;
	/** Orbit plane tilt (radians) and longitude of the ascending node (radians). */
	inclination: number;
	ascendingNode: number;
	/** Starting angle on the orbit (radians) and orbital angular velocity (rad/simsecond). */
	phase: number;
	angularSpeed: number;
	/** Axial spin rate (rad/simsecond) and axial tilt (radians). */
	spinSpeed: number;
	axialTilt: number;
	/** Static height above the orbit plane, which gives a belt its thickness. */
	verticalOffset: number;
	color: number;
}

export interface SolarGraph {
	/** Root bodies. `stars[0]` is the primary system; the rest are disconnected components. */
	stars: SolarNode[];
	nodes: Map<string, SolarNode>;
	/** Links that the spanning tree could not represent, as [idA, idB]. */
	crossLinks: Array<[string, string]>;
	/** True when nodes were dropped because of the maxNodes guard. */
	truncated: boolean;
	nodeCount: number;
}

function makeNode(
	id: string,
	label: string,
	path: string | null,
	kind: NodeKind
): SolarNode {
	return {
		id,
		label,
		path,
		kind,
		depth: 0,
		degree: 0,
		children: [],
		parent: null,
		subtreeSize: 1,
		rogue: false,
		inBelt: false,
		style: null,
		bodyRadius: 1,
		orbitRadius: 0,
		systemRadius: 1,
		inclination: 0,
		ascendingNode: 0,
		phase: 0,
		angularSpeed: 0,
		spinSpeed: 0,
		axialTilt: 0,
		verticalOffset: 0,
		color: 0xffffff,
	};
}

/** Strip folders and the extension so labels read like note titles. */
function basename(path: string): string {
	const file = path.slice(path.lastIndexOf("/") + 1);
	return file.replace(/\.(md|canvas)$/i, "");
}

function unresolvedId(name: string): string {
	return `unresolved:${name.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Link mode: breadth-first spanning tree over the vault's link graph
// ---------------------------------------------------------------------------

/**
 * Builds a hierarchy from links. Obsidian's link graph has cycles and multiple
 * parents, so we take a BFS spanning tree: whoever reaches a note first becomes
 * its star. Every link the tree can't express is kept in `crossLinks`.
 */
export function buildLinkGraph(
	app: App,
	settings: SolarGraphSettings,
	rootPath: string | null
): SolarGraph {
	const resolved = app.metadataCache.resolvedLinks ?? {};
	const unresolved = app.metadataCache.unresolvedLinks ?? {};

	// Adjacency over real files. Undirected unless the user asked for outgoing only.
	const adjacency = new Map<string, Set<string>>();
	const degree = new Map<string, number>();
	const touch = (p: string) => {
		if (!adjacency.has(p)) adjacency.set(p, new Set());
		if (!degree.has(p)) degree.set(p, 0);
	};

	for (const source of Object.keys(resolved)) {
		touch(source);
		for (const target of Object.keys(resolved[source])) {
			if (target === source) continue;
			touch(target);
			adjacency.get(source)!.add(target);
			if (settings.linkDirection === "both") {
				adjacency.get(target)!.add(source);
			}
			degree.set(source, degree.get(source)! + 1);
			degree.set(target, degree.get(target)! + 1);
		}
	}

	// Isolated notes still deserve a place in the sky.
	for (const file of app.vault.getMarkdownFiles()) touch(file.path);

	// Unresolved links, keyed by name, remembered per source so they can hang
	// off whichever note is placed first.
	const unresolvedBySource = new Map<string, string[]>();
	if (settings.includeUnresolved) {
		for (const source of Object.keys(unresolved)) {
			const names = Object.keys(unresolved[source]);
			if (names.length === 0) continue;
			unresolvedBySource.set(source, names);
			degree.set(source, (degree.get(source) ?? 0) + names.length);
			touch(source);
		}
	}

	const all = [...adjacency.keys()];
	const nodes = new Map<string, SolarNode>();
	const parentOf = new Map<string, string>();
	const stars: SolarNode[] = [];
	const visited = new Set<string>();
	const placedUnresolved = new Set<string>();
	let truncated = false;

	const budget = () => nodes.size >= settings.maxNodes;

	const attachUnresolved = (node: SolarNode) => {
		const names = unresolvedBySource.get(node.id);
		if (!names) return;
		for (const name of names) {
			const id = unresolvedId(name);
			if (placedUnresolved.has(id)) continue;
			if (budget()) {
				truncated = true;
				return;
			}
			placedUnresolved.add(id);
			const ghost = makeNode(id, name, null, "unresolved");
			ghost.parent = node;
			ghost.depth = node.depth + 1;
			ghost.degree = 1;
			node.children.push(ghost);
			nodes.set(id, ghost);
		}
	};

	/** One BFS sweep starting at `seed`, creating a single star system. */
	const sweep = (seed: string) => {
		if (visited.has(seed) || budget()) return;
		const star = makeNode(seed, basename(seed), seed, "file");
		star.degree = degree.get(seed) ?? 0;
		visited.add(seed);
		nodes.set(seed, star);
		stars.push(star);

		const queue: SolarNode[] = [star];
		while (queue.length > 0) {
			const current = queue.shift()!;
			attachUnresolved(current);

			// Higher-degree neighbours first: hubs become the inner, prominent
			// planets instead of being buried behind a leaf that happened to sort early.
			const neighbours = [...(adjacency.get(current.id) ?? [])].sort(
				(a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0)
			);
			for (const next of neighbours) {
				if (visited.has(next)) continue;
				if (budget()) {
					truncated = true;
					return;
				}
				visited.add(next);
				const child = makeNode(next, basename(next), next, "file");
				child.degree = degree.get(next) ?? 0;
				child.parent = current;
				child.depth = current.depth + 1;
				current.children.push(child);
				nodes.set(next, child);
				parentOf.set(next, current.id);
				queue.push(child);
			}
		}
	};

	// Notes with no links at all, in either direction, become belt debris rather
	// than lonely one-note star systems.
	const isRogue = (path: string) => (degree.get(path) ?? 0) === 0;
	const connected = all.filter((path) => !isRogue(path));

	// Primary system: the requested root, else the most connected note.
	let primary = rootPath && adjacency.has(rootPath) ? rootPath : null;
	if (!primary) {
		primary = connected.reduce<string | null>((best, path) => {
			if (best === null) return path;
			const d = degree.get(path) ?? 0;
			const bd = degree.get(best) ?? 0;
			// Ties broken by path so the view is stable across rebuilds.
			return d > bd || (d === bd && path < best) ? path : best;
		}, null);
	}
	// A vault of nothing but unlinked notes still needs something at the centre.
	if (!primary && all.length > 0) primary = all[0];
	if (primary) sweep(primary);

	// Remaining connected components, each seeded by its most connected member.
	const remaining = connected
		.filter((p) => !visited.has(p))
		.sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0));
	for (const seed of remaining) sweep(seed);

	// The belt: everything left over, orbiting the primary star as debris.
	const star = stars[0];
	if (star) {
		for (const path of all) {
			if (visited.has(path)) continue;
			if (nodes.size >= settings.maxNodes) {
				truncated = true;
				break;
			}
			visited.add(path);
			const rock = makeNode(path, basename(path), path, "file");
			rock.parent = star;
			rock.depth = star.depth + 1;
			rock.rogue = true;
			rock.inBelt = true;
			star.children.push(rock);
			nodes.set(path, rock);
		}
	}

	// Every resolved link the tree didn't already draw as an orbit.
	const crossLinks: Array<[string, string]> = [];
	const seen = new Set<string>();
	for (const source of Object.keys(resolved)) {
		if (!nodes.has(source)) continue;
		for (const target of Object.keys(resolved[source])) {
			if (source === target || !nodes.has(target)) continue;
			if (parentOf.get(source) === target || parentOf.get(target) === source) continue;
			// NUL separator: a path may contain a space, so "a b" + "c" and
			// "a" + "b c" would otherwise collide on the same key.
			const key = source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
			if (seen.has(key)) continue;
			seen.add(key);
			crossLinks.push([source, target]);
		}
	}

	finalize(stars, settings.starSubtreeSize);
	return { stars, nodes, crossLinks, truncated, nodeCount: nodes.size };
}

// ---------------------------------------------------------------------------
// Folder mode: the vault's own tree
// ---------------------------------------------------------------------------

/** Matches TFile.extension, which has no leading dot. */
const NOTE_EXTENSION = /^(md|canvas)$/i;

/** Builds a hierarchy from the folder tree. Acyclic for free. */
export function buildFolderGraph(
	app: App,
	settings: SolarGraphSettings
): SolarGraph {
	const nodes = new Map<string, SolarNode>();
	let truncated = false;

	const root = makeNode("folder:/", app.vault.getName(), null, "vault");
	nodes.set(root.id, root);

	const include = (child: TAbstractFile): boolean => {
		if (child instanceof TFolder) return true;
		if (child instanceof TFile) {
			return settings.includeAttachments || NOTE_EXTENSION.test(child.extension);
		}
		return false;
	};

	const walk = (folder: TFolder, node: SolarNode) => {
		// Folders before files, each group alphabetical — matches the file explorer.
		const children = folder.children.filter(include).sort((a, b) => {
			const af = a instanceof TFolder ? 0 : 1;
			const bf = b instanceof TFolder ? 0 : 1;
			return af !== bf ? af - bf : a.name.localeCompare(b.name);
		});

		for (const child of children) {
			if (nodes.size >= settings.maxNodes) {
				truncated = true;
				return;
			}
			if (child instanceof TFolder) {
				const sub = makeNode(`folder:${child.path}`, child.name, null, "folder");
				sub.parent = node;
				sub.depth = node.depth + 1;
				node.children.push(sub);
				nodes.set(sub.id, sub);
				walk(child, sub);
				sub.degree = sub.children.length;
			} else if (child instanceof TFile) {
				// Notes read better without ".md"; attachments keep their extension
				// because that's the useful part of the name.
				const leaf = makeNode(
					child.path,
					NOTE_EXTENSION.test(child.extension) ? child.basename : child.name,
					child.path,
					"file"
				);
				leaf.parent = node;
				leaf.depth = node.depth + 1;
				node.children.push(leaf);
				nodes.set(leaf.id, leaf);
			}
		}
	};

	walk(app.vault.getRoot(), root);
	root.degree = root.children.length;

	// Degree of a file node is its link count, so sizing still reflects connectedness.
	const resolved = app.metadataCache.resolvedLinks ?? {};
	for (const source of Object.keys(resolved)) {
		const targets = Object.keys(resolved[source]);
		const from = nodes.get(source);
		if (from) from.degree += targets.length;
		for (const target of targets) {
			const to = nodes.get(target);
			if (to) to.degree += 1;
		}
	}

	// Unlinked notes still render as debris, but they stay in their folder rather
	// than being pulled out into a belt — the folder tree is the whole point here.
	for (const node of nodes.values()) {
		if (node.kind === "file") node.rogue = node.degree === 0;
	}

	// In folder mode every link is a cross-link: orbits express containment instead.
	const crossLinks: Array<[string, string]> = [];
	const seen = new Set<string>();
	for (const source of Object.keys(resolved)) {
		if (!nodes.has(source)) continue;
		for (const target of Object.keys(resolved[source])) {
			if (source === target || !nodes.has(target)) continue;
			// NUL separator: a path may contain a space, so "a b" + "c" and
			// "a" + "b c" would otherwise collide on the same key.
			const key = source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
			if (seen.has(key)) continue;
			seen.add(key);
			crossLinks.push([source, target]);
		}
	}

	finalize([root], settings.starSubtreeSize);
	return { stars: [root], nodes, crossLinks, truncated, nodeCount: nodes.size };
}

// ---------------------------------------------------------------------------

/**
 * Bottom-up subtree sizes for the layout packer, plus the body style — which can
 * only be decided once a node's children are all attached.
 */
function finalize(stars: SolarNode[], starSubtree: number) {
	const size = (node: SolarNode): number => {
		let total = 1;
		for (const child of node.children) total += size(child);
		node.subtreeSize = total;
		node.style = classify(node, starSubtree);
		return total;
	};
	for (const star of stars) size(star);
}

/** Walk every node of a graph, parents before children. */
export function walkGraph(graph: SolarGraph, visit: (node: SolarNode) => void) {
	const stack = [...graph.stars];
	while (stack.length > 0) {
		const node = stack.pop()!;
		visit(node);
		for (const child of node.children) stack.push(child);
	}
}
