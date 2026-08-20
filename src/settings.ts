import { App, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import { DEFAULT_STAR_SUBTREE, ICE_GIANT_CHILDREN } from "./classify";
import type SolarGraphPlugin from "./main";

export type Hierarchy = "links" | "folders";
export type RootMode = "hub" | "active";
export type LinkDirection = "both" | "outgoing";
export type LabelMode = "near" | "roots" | "none";
export type ShadowQuality = "off" | "low" | "medium" | "high";

/** Shadow map resolution and how many stars cast, per quality step. */
export const SHADOW_PRESETS: Record<ShadowQuality, { size: number; lights: number }> = {
	off: { size: 0, lights: 0 },
	low: { size: 512, lights: 1 },
	medium: { size: 1024, lights: 2 },
	high: { size: 2048, lights: 3 },
};

export interface SolarGraphSettings {
	/** Which tree the orbits express. */
	hierarchy: Hierarchy;
	/** How the primary star is chosen in link mode. */
	rootMode: RootMode;
	/** Follow links in both directions when building the tree, or outgoing only. */
	linkDirection: LinkDirection;
	/** Show links that point at notes which don't exist yet. */
	includeUnresolved: boolean;
	/** Folder mode: include images, PDFs and other non-note files. */
	includeAttachments: boolean;

	/** Orbital speed multiplier. 0 freezes the system. */
	speed: number;
	/** Gap between sibling orbits, in scene units. */
	orbitSpacing: number;
	/** Overall body size multiplier. */
	bodyScale: number;
	/** Maximum orbit-plane tilt, in degrees. 0 makes every system flat. */
	inclinationSpread: number;

	showOrbits: boolean;
	showCrossLinks: boolean;
	/** Photographic surface maps. Off gives flat coloured spheres. */
	useTextures: boolean;
	/** Saturn-style ring planes on notes with enough children. */
	showRings: boolean;
	/** Star coronas, belt dust and the haze across the system plane. */
	showParticles: boolean;

	/**
	 * Subtree size at which a note ignites into a star of its own, counting all
	 * its descendants. 0 leaves only the root of each system as a star.
	 */
	starSubtreeSize: number;

	/** Overall brightness of star light. */
	starBrightness: number;
	/**
	 * How fast star light dims with distance. 0 is uniform, 1 linear, 2 physically
	 * correct inverse-square. Higher values make the nearest star dominate, which
	 * is what stops two stars lighting one body from opposite sides.
	 */
	lightFalloff: number;
	/**
	 * Let the nearest star dominate the lighting, dimming the others right down.
	 * Off means every star lights everything within reach, which is more honest but
	 * leaves bodies between two stars lit from both sides with a seam between.
	 */
	dominantLighting: boolean;
	/** Size and strength of the halo around a star or planet. */
	starGlow: number;
	/** Density of the plasma motes around a star. */
	coronaStrength: number;

	/** Cast shadows, so a moon behind a planet is genuinely eclipsed. */
	shadowQuality: ShadowQuality;
	/** How dark an eclipsed or night-side surface gets. */
	shadowDepth: number;
	/** Volumetric light shafts streaming past the bodies that block them. */
	lightShafts: boolean;
	lightShaftStrength: number;
	/** Interstellar haze. Gives depth and catches the light shafts. */
	fogDensity: number;
	/** Bloom around bright surfaces. */
	glowStrength: number;
	labelMode: LabelMode;
	/** Cap on simultaneously drawn labels; the nearest ones win. */
	labelBudget: number;

	/** Clicking a body opens its note. */
	openOnClick: boolean;
	/** Keep the camera locked on the selected body as it orbits. */
	followSelection: boolean;

	/** Safety valve for very large vaults. */
	maxNodes: number;
}

export const DEFAULT_SETTINGS: SolarGraphSettings = {
	hierarchy: "links",
	rootMode: "hub",
	linkDirection: "both",
	includeUnresolved: true,
	includeAttachments: false,

	speed: 1,
	orbitSpacing: 4,
	bodyScale: 1,
	inclinationSpread: 16,

	showOrbits: true,
	showCrossLinks: true,
	useTextures: true,
	showRings: true,
	showParticles: true,

	starSubtreeSize: DEFAULT_STAR_SUBTREE,

	starBrightness: 1,
	lightFalloff: 1,
	dominantLighting: true,
	starGlow: 1,
	coronaStrength: 1,

	shadowQuality: "medium",
	shadowDepth: 0.6,
	lightShafts: true,
	lightShaftStrength: 0.55,
	fogDensity: 0.25,
	glowStrength: 0.5,
	labelMode: "near",
	labelBudget: 60,

	openOnClick: true,
	followSelection: true,

	maxNodes: 3000,
};

/**
 * Changes that only need a re-layout are cheap; changes to these keys require
 * rebuilding the tree from the vault.
 */
const REBUILD_KEYS: Array<keyof SolarGraphSettings> = [
	"hierarchy",
	"rootMode",
	"linkDirection",
	"includeUnresolved",
	"includeAttachments",
	"maxNodes",
	// Body classes are decided while the tree is built, so this one has to go
	// back through the builders.
	"starSubtreeSize",
];

export function needsRebuild(changed: keyof SolarGraphSettings): boolean {
	return REBUILD_KEYS.includes(changed);
}
/** One control in the settings UI, and which setting it reads and writes. */
type ControlSpec =
	| { type: "toggle" }
	| { type: "dropdown"; options: Record<string, string> }
	| { type: "slider"; min: number; max: number; step: number };

interface SettingSpec {
	key: keyof SolarGraphSettings;
	name: string;
	desc?: string;
	control: ControlSpec;
}

interface SettingGroupSpec {
	heading: string;
	items: SettingSpec[];
}

/**
 * Every setting, described once.
 *
 * Obsidian 1.13 and later render settings from getSettingDefinitions() and never
 * call display(); older versions know only display(). Both read this table, so the
 * two paths cannot drift apart.
 */
const SETTING_GROUPS: SettingGroupSpec[] = [
	{
		heading: "Hierarchy",
		items: [
			{
				key: "hierarchy",
				name: "What orbits what",
				desc:
					"Links builds a spanning tree from your wikilinks, and your most connected note becomes the star. Folders uses the vault's folder tree instead.",
				control: { type: "dropdown", options: { "links": "Links", "folders": "Folders" } },
			},
			{
				key: "rootMode",
				name: "Star of the primary system",
				desc:
					"Link mode only. Alt-click any body in the view to re-root on it.",
				control: { type: "dropdown", options: { "hub": "Most connected note", "active": "Currently open note" } },
			},
			{
				key: "linkDirection",
				name: "Link direction",
				desc:
					"Both treats links as two-way, so nothing is stranded. Outgoing only follows links away from a note, which keeps the tree closer to how you wrote it.",
				control: { type: "dropdown", options: { "both": "Both directions", "outgoing": "Outgoing only" } },
			},
			{
				key: "includeUnresolved",
				name: "Show unresolved links",
				desc:
					"Links to notes that don't exist yet appear as dim, unlit bodies.",
				control: { type: "toggle" },
			},
			{
				key: "includeAttachments",
				name: "Include attachments",
				desc:
					"Folder mode only. Also shows images, documents and other attachments.",
				control: { type: "toggle" },
			},
		],
	},
	{
		heading: "Motion and scale",
		items: [
			{
				key: "speed",
				name: "Orbital speed",
				desc:
					"Inner orbits always run faster than outer ones, the way a real system does.",
				control: { type: "slider", min: 0, max: 4, step: 0.1 },
			},
			{
				key: "orbitSpacing",
				name: "Orbit spacing",
				desc:
					"Distance between neighbouring orbits.",
				control: { type: "slider", min: 1, max: 16, step: 0.5 },
			},
			{
				key: "bodyScale",
				name: "Body size",
				control: { type: "slider", min: 0.3, max: 3, step: 0.1 },
			},
			{
				key: "inclinationSpread",
				name: "Orbit tilt",
				desc:
					"Maximum tilt of an orbit plane, in degrees. Zero makes every system flat.",
				control: { type: "slider", min: 0, max: 60, step: 1 },
			},
			{
				key: "starSubtreeSize",
				name: "Stars",
				desc:
					"A note carrying at least this many notes beneath it, counting children and grandchildren and so on, becomes a star of its own and lights everything that orbits it. Set it to 1 to leave only the root of each system as a star.",
				control: { type: "slider", min: 1, max: 60, step: 1 },
			},
		],
	},
	{
		heading: "Light and shadow",
		items: [
			{
				key: "starBrightness",
				name: "Star brightness",
				desc:
					"How hard the stars shine on everything orbiting them.",
				control: { type: "slider", min: 0.2, max: 3, step: 0.1 },
			},
			{
				key: "lightFalloff",
				name: "Light falloff",
				desc:
					"How fast light dims with distance: 0 spreads it evenly, 1 is linear, 2 is physically correct inverse-square. Raise it if a body lit by two stars shows two bright patches with a hard seam, so the nearer star wins clearly.",
				control: { type: "slider", min: 0, max: 2, step: 0.1 },
			},
			{
				key: "dominantLighting",
				name: "Nearest star dominates",
				desc:
					"Fades down every star but the closest one, so a body is lit from a single direction. Turn it off for true multi-star lighting, though a body sitting between two stars is then lit from both sides, with a dark seam where the two pools of light meet.",
				control: { type: "toggle" },
			},
			{
				key: "starGlow",
				name: "Star halo",
				desc:
					"Size of the glow around a star. The halo is cut out around the body itself, so it never lies on top of the surface.",
				control: { type: "slider", min: 0, max: 2.5, step: 0.1 },
			},
			{
				key: "coronaStrength",
				name: "Corona",
				desc:
					"Density of the plasma motes boiling off a star's surface.",
				control: { type: "slider", min: 0, max: 2.5, step: 0.1 },
			},
			{
				key: "shadowQuality",
				name: "Shadows",
				desc:
					"Bodies cast real shadows, so a moon passing behind its planet is genuinely eclipsed. Higher settings are sharper and cost more, and each step lets another star cast.",
				control: { type: "dropdown", options: { "off": "Off", "low": "Low: 512px, 1 star", "medium": "Medium: 1024px, 2 stars", "high": "High: 2048px, 3 stars" } },
			},
			{
				key: "shadowDepth",
				name: "Shadow depth",
				desc:
					"How dark an eclipsed or unlit surface goes. This is the ambient fill, the only light reaching a shadowed face. Higher is more dramatic and makes eclipses obvious, lower keeps night sides readable.",
				control: { type: "slider", min: 0, max: 1, step: 0.05 },
			},
			{
				key: "lightShafts",
				name: "Light shafts",
				desc:
					"Volumetric rays streaming out from the stars, broken by whatever passes in front of them. This is the most expensive effect here, so turn it off first if the frame rate drops.",
				control: { type: "toggle" },
			},
			{
				key: "lightShaftStrength",
				name: "Light shaft strength",
				control: { type: "slider", min: 0, max: 1.5, step: 0.05 },
			},
			{
				key: "fogDensity",
				name: "Interstellar haze",
				desc:
					"Fog through the system. Adds depth and gives the light shafts something to travel through. Zero is clear vacuum.",
				control: { type: "slider", min: 0, max: 1.5, step: 0.05 },
			},
			{
				key: "glowStrength",
				name: "Glow",
				desc:
					"Bloom around stars, rings and bright surfaces. Zero turns the effect off entirely.",
				control: { type: "slider", min: 0, max: 1.5, step: 0.05 },
			},
		],
	},
	{
		heading: "Appearance",
		items: [
			{
				key: "useTextures",
				name: "Surface textures",
				desc:
					"Photographic surfaces: cloud bands on giants, craters on rocky notes, ice on leaves. Off gives flat coloured spheres, which is faster on weak hardware.",
				control: { type: "toggle" },
			},
			{
				key: "showRings",
				name: "Planetary rings",
				desc: `Saturn-style rings on notes with ${ICE_GIANT_CHILDREN} or more children.`,
				control: { type: "toggle" },
			},
			{
				key: "showParticles",
				name: "Particle effects",
				desc:
					"Star coronas, dust along the asteroid belt, and haze across the system.",
				control: { type: "toggle" },
			},
			{
				key: "showOrbits",
				name: "Show orbit rings",
				control: { type: "toggle" },
			},
			{
				key: "showCrossLinks",
				name: "Show cross-links",
				desc:
					"Faint chords for the links the orbits can't express. In link mode that means every link outside the spanning tree.",
				control: { type: "toggle" },
			},
			{
				key: "labelMode",
				name: "Labels",
				control: { type: "dropdown", options: { "near": "Nearest bodies", "roots": "Stars and their planets", "none": "Hover only" } },
			},
			{
				key: "labelBudget",
				name: "Label budget",
				desc:
					"How many labels may be on screen at once.",
				control: { type: "slider", min: 10, max: 300, step: 10 },
			},
		],
	},
	{
		heading: "Interaction",
		items: [
			{
				key: "openOnClick",
				name: "Open note on click",
				desc:
					"Ctrl-click opens the note in a new tab. Alt-click rebuilds the system around it.",
				control: { type: "toggle" },
			},
			{
				key: "followSelection",
				name: "Follow selection",
				desc:
					"Keep the camera locked on the selected body while it orbits.",
				control: { type: "toggle" },
			},
		],
	},
	{
		heading: "Performance",
		items: [
			{
				key: "maxNodes",
				name: "Maximum bodies",
				desc:
					"Vaults larger than this are truncated; the view says so when it happens.",
				control: { type: "slider", min: 200, max: 8000, step: 100 },
			},
		],
	},
];

export class SolarGraphSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: SolarGraphPlugin) {
		super(app, plugin);
	}

	/**
	 * The declarative settings, used by Obsidian 1.13 and later. Returning a
	 * non-empty array here is what makes Obsidian skip display(), and it is also
	 * what puts these settings in the settings search index.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return SETTING_GROUPS.map((group) => ({
			type: "group",
			heading: group.heading,
			items: group.items.map((item) => ({
				name: item.name,
				desc: item.desc,
				control: { key: item.key, ...item.control },
			})),
		}));
	}

	/**
	 * Obsidian's default writes the value and persists it, which isn't enough here:
	 * an open view has to hear about the change, and how much work it implies varies
	 * from a repaint to re-reading the whole vault.
	 */
	async setControlValue(key: string, value: unknown): Promise<void> {
		await this.commit(key as keyof SolarGraphSettings, value);
	}

	/**
	 * The imperative fallback for Obsidian before 1.13, which has no declarative
	 * settings API. Built from the same table, in the same order.
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const group of SETTING_GROUPS) {
			new Setting(containerEl).setName(group.heading).setHeading();
			for (const spec of group.items) this.renderSetting(containerEl, spec);
		}
	}

	private renderSetting(containerEl: HTMLElement, spec: SettingSpec): void {
		const setting = new Setting(containerEl).setName(spec.name);
		if (spec.desc) setting.setDesc(spec.desc);
		const control = spec.control;

		if (control.type === "toggle") {
			setting.addToggle((toggle) =>
				toggle
					.setValue(this.read<boolean>(spec.key))
					.onChange((value) => void this.commit(spec.key, value))
			);
			return;
		}
		if (control.type === "dropdown") {
			setting.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(control.options)) {
					dropdown.addOption(value, label);
				}
				dropdown
					.setValue(this.read<string>(spec.key))
					.onChange((value) => void this.commit(spec.key, value));
			});
			return;
		}
		setting.addSlider((slider) =>
			slider
				.setLimits(control.min, control.max, control.step)
				.setValue(this.read<number>(spec.key))
				.onChange((value) => void this.commit(spec.key, value))
		);
	}

	/** Current value of a setting, narrowed to what its control deals in. */
	private read<T>(key: keyof SolarGraphSettings): T {
		return this.plugin.settings[key] as T;
	}

	private async commit(key: keyof SolarGraphSettings, value: unknown): Promise<void> {
		// The table pairs each key with a control of the right type, which is the
		// guarantee this index assignment relies on. SolarGraphSettings has no index
		// signature, hence the trip through unknown.
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings(key);
	}
}
