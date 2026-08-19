import type { SolarNode } from "./graph";

/**
 * What kind of world a note renders as. Derived purely from structure — how many
 * notes orbit it and whether anything links to it — so it works on any vault
 * without conventions or configuration.
 */
export type BodyClass =
	| "star"
	| "gas-giant"
	| "ice-giant"
	| "terrestrial"
	| "rocky"
	| "icy"
	| "asteroid"
	| "ghost";

export type TextureKey =
	| "star"
	| "gas-warm"
	| "gas-cool"
	| "terrestrial"
	| "rocky"
	| "ice"
	| "asteroid";

export interface BodyStyle {
	kind: BodyClass;
	texture: TextureKey | null;
	hasRings: boolean;
	/** Multiplier on the radius the layout computed. */
	sizeScale: number;
	/** Lumpy shape and end-over-end tumble instead of a tidy sphere. */
	irregular: boolean;
	/**
	 * Self-illumination. Kept at zero for anything lit by a star: a body that
	 * glows on its own can't be eclipsed, and ambient light is the fill instead.
	 */
	emissive: number;
	/** Glow sprite size relative to the body radius. 0 for none. */
	glow: number;
}

/** A note needs at least this many children to become a gas giant. */
export const GAS_GIANT_CHILDREN = 8;
/** ...and at least this many to become a ringed ice giant. */
export const ICE_GIANT_CHILDREN = 5;
const TERRESTRIAL_CHILDREN = 3;
const ROCKY_CHILDREN = 1;

/**
 * Default subtree size at which a note stops being a planet and ignites into a
 * star of its own — counting children, grandchildren and so on down. Adjustable;
 * 0 means only the roots of each system are stars.
 */
export const DEFAULT_STAR_SUBTREE = 14;
/**
 * A star below the root would otherwise be shrunk by its generation, so it gets
 * this much of its size back and reads as a star among its siblings.
 */
const NESTED_STAR_SCALE = 2.1;

const STYLES: Record<BodyClass, Omit<BodyStyle, "kind">> = {
	star: {
		texture: "star",
		hasRings: false,
		sizeScale: 1,
		irregular: false,
		emissive: 1,
		glow: 4.5,
	},
	"gas-giant": {
		texture: "gas-warm",
		hasRings: true,
		sizeScale: 1.35,
		irregular: false,
		emissive: 0,
		glow: 1.9,
	},
	"ice-giant": {
		texture: "gas-cool",
		hasRings: true,
		sizeScale: 1.18,
		irregular: false,
		emissive: 0,
		glow: 2.3,
	},
	terrestrial: {
		texture: "terrestrial",
		hasRings: false,
		sizeScale: 1,
		irregular: false,
		emissive: 0,
		glow: 2.1,
	},
	rocky: {
		texture: "rocky",
		hasRings: false,
		sizeScale: 0.94,
		irregular: false,
		emissive: 0,
		glow: 2.4,
	},
	icy: {
		texture: "ice",
		hasRings: false,
		sizeScale: 0.88,
		irregular: false,
		emissive: 0,
		glow: 2.0,
	},
	asteroid: {
		texture: "asteroid",
		hasRings: false,
		sizeScale: 0.5,
		irregular: true,
		emissive: 0,
		glow: 0,
	},
	ghost: {
		texture: null,
		hasRings: false,
		sizeScale: 0.7,
		irregular: true,
		emissive: 0.04,
		glow: 0,
	},
};

/**
 * Picks a body class for a note.
 *
 * The ladder is deliberately monotonic in how much a note anchors: the more notes
 * orbit it the more substantial the world, from ice moon up through the giants,
 * and past a whole subtree's worth of descendants it ignites as a star.
 */
export function classify(node: SolarNode, starSubtree = DEFAULT_STAR_SUBTREE): BodyStyle {
	const kind = classifyKind(node, starSubtree);
	const style = { kind, ...STYLES[kind] };
	if (kind === "star" && node.depth > 0) style.sizeScale = NESTED_STAR_SCALE;
	return style;
}

/** Human-readable names, for the hover card. */
export const CLASS_LABELS: Record<BodyClass, string> = {
	star: "star",
	"gas-giant": "gas giant",
	"ice-giant": "ringed ice giant",
	terrestrial: "terrestrial world",
	rocky: "rocky world",
	icy: "ice moon",
	asteroid: "asteroid",
	ghost: "not created yet",
};

/** The style the graph builder assigned, or a fresh one if it somehow wasn't. */
export function styleOf(node: SolarNode): BodyStyle {
	return node.style ?? classify(node);
}

/**
 * Tints for the star surface variants, in the same order as the files, so a
 * blue-white star doesn't end up with a gold corona and gold light.
 */
export const STAR_TINTS = [0xffcf6b, 0xbfd8ff, 0xff8a5c];

function classifyKind(node: SolarNode, starSubtree: number): BodyClass {
	if (node.kind === "unresolved") return "ghost";
	if (node.parent === null) return "star";
	// Nothing links to it and it links to nothing: debris, wherever it sits.
	if (node.rogue) return "asteroid";
	// A note carrying a whole region of the vault is a star in its own right, and
	// lights the notes orbiting it. subtreeSize counts the note itself, hence > 1.
	if (starSubtree > 1 && node.subtreeSize >= starSubtree) return "star";

	const children = node.children.length;
	if (children >= GAS_GIANT_CHILDREN) return "gas-giant";
	if (children >= ICE_GIANT_CHILDREN) return "ice-giant";
	if (children >= TERRESTRIAL_CHILDREN) return "terrestrial";
	if (children >= ROCKY_CHILDREN) return "rocky";
	return "icy";
}
