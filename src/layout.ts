import type { SolarGraph, SolarNode } from "./graph";
import { walkGraph } from "./graph";
import type { SolarGraphSettings } from "./settings";

const STAR_RADIUS = 4;
/** Each generation is this fraction of its parent's size. */
const DEPTH_FALLOFF = 0.52;
const MIN_BODY_RADIUS = 0.22;
/** Beyond this many children, siblings start sharing orbits instead of each getting one. */
const MAX_ORBITS_PER_NODE = 10;
const MAX_PER_RING = 12;
/** Sets the absolute pace; angular velocity is this over r^1.5. */
export const KEPLER_CONSTANT = 14;
const RETROGRADE_CHANCE = 0.08;

/** Asteroids per belt sub-ring, and how many sub-rings a belt may use. */
const BELT_PER_RING = 22;
const MAX_BELT_RINGS = 7;
/** Belt sub-rings sit far closer together than planetary orbits do. */
const BELT_GAP_SCALE = 0.22;
/** Vertical scatter of belt debris, as a multiple of its own radius. */
const BELT_THICKNESS = 2.6;
/** Debris tumbles noticeably faster than a settled world rotates. */
const ASTEROID_SPIN = 2.4;

export interface LayoutResult {
	/** Furthest a body can ever get from the centre, measured sideways. */
	extent: number;
	/** Furthest a body can ever get above or below the primary plane. */
	verticalExtent: number;
	maxDepth: number;
}

/** Deterministic 32-bit string hash — the same vault always lays out the same way. */
function hashString(str: string): number {
	let h = 2166136261;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** Stable pseudo-random in [0, 1) from a node id and a salt. */
function rand(id: string, salt: number): number {
	let h = hashString(id) ^ Math.imul(salt + 1, 0x9e3779b9);
	h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const DEPTH_HUES = [
	{ h: 0.11, s: 0.85, l: 0.62 }, // star — warm gold
	{ h: 0.55, s: 0.72, l: 0.62 }, // sky blue
	{ h: 0.73, s: 0.62, l: 0.68 }, // violet
	{ h: 0.42, s: 0.58, l: 0.62 }, // mint
	{ h: 0.05, s: 0.7, l: 0.66 }, // coral
	{ h: 0.87, s: 0.55, l: 0.68 }, // magenta
];
const UNRESOLVED_COLOR = 0x59617a;

function hslToHex(h: number, s: number, l: number): number {
	const f = (n: number) => {
		const k = (n + h * 12) % 12;
		const a = s * Math.min(l, 1 - l);
		const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
		return Math.round(Math.max(0, Math.min(1, v)) * 255);
	};
	return (f(0) << 16) | (f(8) << 8) | f(4);
}

function colorFor(node: SolarNode): number {
	if (node.kind === "unresolved") return UNRESOLVED_COLOR;
	const base = DEPTH_HUES[Math.min(node.depth, DEPTH_HUES.length - 1)];
	// A touch of per-node hue drift so siblings aren't identical.
	const drift = (rand(node.id, 7) - 0.5) * 0.06;
	const lightness = base.l + (rand(node.id, 8) - 0.5) * 0.1;
	return hslToHex((base.h + drift + 1) % 1, base.s, lightness);
}

/**
 * Assigns every node a size, an orbit, a tilt and an orbital speed.
 *
 * Sizing runs top-down (each generation smaller than the last) and packing runs
 * bottom-up: a node can only place its children once it knows how much room each
 * child's *entire* subsystem needs. Siblings are then packed into disjoint
 * annuli, which makes overlap between subsystems impossible rather than unlikely.
 */
export function layoutGraph(
	graph: SolarGraph,
	settings: SolarGraphSettings
): LayoutResult {
	let maxDegree = 1;
	let maxDepth = 0;
	walkGraph(graph, (node) => {
		if (node.degree > maxDegree) maxDegree = node.degree;
		if (node.depth > maxDepth) maxDepth = node.depth;
	});
	const degreeNorm = Math.log1p(maxDegree);
	const tiltMax = (settings.inclinationSpread * Math.PI) / 180;

	const sizeOf = (node: SolarNode): number => {
		const byDepth = STAR_RADIUS * Math.pow(DEPTH_FALLOFF, node.depth);
		// Well-connected notes read as bigger worlds, but only within their generation.
		const connect =
			degreeNorm > 0 ? 0.75 + (0.5 * Math.log1p(node.degree)) / degreeNorm : 1;
		const scale = node.style?.sizeScale ?? 1;
		return Math.max(MIN_BODY_RADIUS, byDepth * connect * scale) * settings.bodyScale;
	};

	/**
	 * One orbit's worth of bodies. Planets get a group each (or share one when a
	 * note has too many children), and belt debris is split into several tight
	 * sub-rings that all sort to the same place so they end up adjacent.
	 */
	interface PackGroup {
		members: SolarNode[];
		/** Radial half-thickness this group needs, including any vertical scatter. */
		halfWidth: number;
		/** Radial sort key. */
		order: number;
		belt: boolean;
	}

	const buildGroups = (children: SolarNode[]): PackGroup[] => {
		const debris = children.filter((child) => child.inBelt);
		const planets = children.filter((child) => !child.inBelt);
		const groups: PackGroup[] = [];
		const widthOf = (members: SolarNode[]) =>
			members.reduce((m, c) => Math.max(m, c.systemRadius), 0);

		// Small families get one body per orbit — the classic solar-system read.
		// Large ones share rings so the system doesn't sprawl across the galaxy.
		const perRing =
			planets.length <= MAX_ORBITS_PER_NODE
				? 1
				: Math.min(MAX_PER_RING, Math.ceil(planets.length / MAX_ORBITS_PER_NODE));

		// Smallest subsystems inside, largest outside: the roomy ones get the room.
		const ordered = [...planets].sort((a, b) => a.systemRadius - b.systemRadius);
		for (let i = 0; i < ordered.length; i += perRing) {
			const members = ordered.slice(i, i + perRing);
			const halfWidth = widthOf(members);
			groups.push({ members, halfWidth, order: halfWidth, belt: false });
		}

		if (debris.length > 0) {
			// Sort the belt to the middle of the planets rather than inside or beyond
			// all of them, so there are worlds on both sides of it.
			const order =
				groups.length > 0 ? groups[Math.floor(groups.length / 2)].halfWidth : 0;
			const subRings = Math.min(
				MAX_BELT_RINGS,
				Math.max(1, Math.ceil(debris.length / BELT_PER_RING))
			);
			const perSub = Math.ceil(debris.length / subRings);
			const sorted = [...debris].sort((a, b) => (a.id < b.id ? -1 : 1));
			for (let i = 0; i < sorted.length; i += perSub) {
				const members = sorted.slice(i, i + perSub);
				groups.push({ members, halfWidth: widthOf(members), order, belt: true });
			}
		}

		// Stable, so the belt's sub-rings stay contiguous and land after the planet
		// group they tie with.
		return groups.sort((a, b) => a.order - b.order);
	};

	/**
	 * Places `children` in rings around a parent of radius `parentRadius`.
	 * Returns the radius of the whole arrangement.
	 */
	const packChildren = (
		children: SolarNode[],
		parentRadius: number,
		depth: number,
		spin: boolean,
		spacingScale = 1
	): number => {
		const gap = Math.max(
			0.6,
			settings.orbitSpacing * spacingScale * Math.pow(0.78, depth)
		);
		let boundary = parentRadius * 2.2 + gap;
		if (children.length === 0) return parentRadius;

		for (const group of buildGroups(children)) {
			const { members, halfWidth } = group;
			const localGap = group.belt ? gap * BELT_GAP_SCALE : gap;
			// Radial constraint: clear the previous ring.
			let radius = boundary + halfWidth;
			if (members.length > 1) {
				// Angular constraint: with k bodies spaced evenly, neighbours are a
				// chord of 2r·sin(π/k) apart, and that chord has to fit both
				// subsystems plus a gap. Solving for r gives the exact minimum —
				// approximating the chord by arc length under-shoots and lets
				// crowded rings touch.
				const required =
					(2 * halfWidth + localGap) / (2 * Math.sin(Math.PI / members.length));
				radius = Math.max(radius, required);
			}

			// One plane per ring, not per body: two circles of equal radius in
			// different planes cross at two points, so co-orbital bodies must be
			// coplanar for the chord spacing above to actually hold.
			const inclination = (rand(members[0].id, 1) * 2 - 1) * tiltMax;
			const ascendingNode = rand(members[0].id, 2) * Math.PI * 2;
			const baseAngle = rand(members[0].id, 3) * Math.PI * 2;
			// Shared radius means shared speed, so an evenly spaced ring stays
			// evenly spaced forever.
			const direction = rand(members[0].id, 4) < RETROGRADE_CHANCE ? -1 : 1;
			const angularSpeed = spin
				? (direction * KEPLER_CONSTANT) / Math.pow(Math.max(radius, 0.5), 1.5)
				: 0;

			members.forEach((child, j) => {
				child.orbitRadius = radius;
				child.phase = baseAngle + (j * Math.PI * 2) / members.length;
				child.inclination = inclination;
				child.ascendingNode = ascendingNode;
				child.angularSpeed = angularSpeed;
				const tumble = child.style?.irregular ? ASTEROID_SPIN : 1;
				child.spinSpeed =
					(0.15 + rand(child.id, 5) * 0.5) * tumble * (direction > 0 ? 1 : -1);
				child.axialTilt = (rand(child.id, 6) * 2 - 1) * 0.45;
			});

			boundary = radius + halfWidth + localGap;
		}
		return Math.max(parentRadius, boundary);
	};

	/** Post-order: children are packed before the parent claims its own extent. */
	const pack = (node: SolarNode) => {
		node.bodyRadius = sizeOf(node);
		node.color = colorFor(node);
		// Scattering debris off its orbit plane is what makes a belt look like a
		// belt rather than a bead necklace.
		node.verticalOffset = node.inBelt
			? (rand(node.id, 9) * 2 - 1) * node.bodyRadius * BELT_THICKNESS
			: 0;
		for (const child of node.children) pack(child);
		// A leaf's bounding sphere is just its own body; all clearance comes from
		// the gaps the packer adds. The vertical offset moves a body off the ring,
		// so it has to count towards the room the body claims.
		node.systemRadius =
			packChildren(node.children, node.bodyRadius, node.depth, true) +
			Math.abs(node.verticalOffset);
	};

	for (const star of graph.stars) {
		pack(star);
		star.orbitRadius = 0;
		star.phase = 0;
		star.inclination = 0;
		star.ascendingNode = 0;
		star.angularSpeed = 0;
		star.spinSpeed = 0.1;
		star.axialTilt = 0;
	}

	// Disconnected components become sibling star systems drifting around the primary.
	const [primary, ...others] = graph.stars;
	if (!primary) return { extent: 40, verticalExtent: 10, maxDepth: 0 };

	if (others.length > 0) {
		// Wide, slow rings: separate systems should feel far away and nearly still,
		// not whipping around a shared centre. parentRadius is divided by the 2.2
		// clearance factor so packing starts exactly at the primary system's edge.
		packChildren(others, primary.systemRadius / 2.2, 0, false, 3);
		for (const star of others) {
			star.angularSpeed = 0.3 / Math.pow(Math.max(star.orbitRadius, 1), 1.2);
			star.inclination *= 0.6;
		}
	}

	// Framing wants a tight bound, not the padded packing radius: the furthest a
	// body can ever swing from the origin is the sum of the orbit radii along its
	// ancestor chain (all of them aligned at once). Sideways and vertical reach are
	// tracked separately because a system of tilted orbits is a flattened disc, not
	// a ball, and framing it as a ball wastes most of the screen.
	let extent = 0;
	let verticalExtent = 0;
	const measure = (node: SolarNode, carried: number, carriedY: number) => {
		const reach = carried + node.orbitRadius;
		const reachY =
			carriedY +
			node.orbitRadius * Math.abs(Math.sin(node.inclination)) +
			Math.abs(node.verticalOffset);
		extent = Math.max(extent, reach + node.bodyRadius);
		verticalExtent = Math.max(verticalExtent, reachY + node.bodyRadius);
		for (const child of node.children) measure(child, reach, reachY);
	};
	for (const star of graph.stars) measure(star, 0, 0);

	return {
		extent: Math.max(extent * 1.06, 20),
		verticalExtent: Math.max(verticalExtent * 1.06, 1),
		maxDepth,
	};
}
