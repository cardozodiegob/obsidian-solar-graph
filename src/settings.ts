import { App, PluginSettingTab, Setting } from "obsidian";
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

export class SolarGraphSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: SolarGraphPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		const commit = async (key: keyof SolarGraphSettings) => {
			await this.plugin.saveSettings(key);
		};

		new Setting(containerEl).setName("Hierarchy").setHeading();

		new Setting(containerEl)
			.setName("What orbits what")
			.setDesc(
				"Links builds a spanning tree from your wikilinks — the most connected note becomes the star. Folders uses the vault's folder tree."
			)
			.addDropdown((d) =>
				d
					.addOption("links", "Links")
					.addOption("folders", "Folders")
					.setValue(s.hierarchy)
					.onChange(async (v) => {
						s.hierarchy = v as Hierarchy;
						await commit("hierarchy");
					})
			);

		new Setting(containerEl)
			.setName("Star of the primary system")
			.setDesc("Link mode only. Alt-click any body in the view to re-root on it.")
			.addDropdown((d) =>
				d
					.addOption("hub", "Most connected note")
					.addOption("active", "Currently open note")
					.setValue(s.rootMode)
					.onChange(async (v) => {
						s.rootMode = v as RootMode;
						await commit("rootMode");
					})
			);

		new Setting(containerEl)
			.setName("Link direction")
			.setDesc(
				"Both treats links as two-way, so nothing is stranded. Outgoing only follows links away from a note, which keeps the tree closer to how you wrote it."
			)
			.addDropdown((d) =>
				d
					.addOption("both", "Both directions")
					.addOption("outgoing", "Outgoing only")
					.setValue(s.linkDirection)
					.onChange(async (v) => {
						s.linkDirection = v as LinkDirection;
						await commit("linkDirection");
					})
			);

		new Setting(containerEl)
			.setName("Show unresolved links")
			.setDesc("Links to notes that don't exist yet appear as dim, unlit bodies.")
			.addToggle((t) =>
				t.setValue(s.includeUnresolved).onChange(async (v) => {
					s.includeUnresolved = v;
					await commit("includeUnresolved");
				})
			);

		new Setting(containerEl)
			.setName("Include attachments")
			.setDesc("Folder mode only. Adds images, PDFs and other non-note files.")
			.addToggle((t) =>
				t.setValue(s.includeAttachments).onChange(async (v) => {
					s.includeAttachments = v;
					await commit("includeAttachments");
				})
			);

		new Setting(containerEl).setName("Motion and scale").setHeading();

		new Setting(containerEl)
			.setName("Orbital speed")
			.setDesc("Inner orbits always run faster than outer ones (Kepler's third law).")
			.addSlider((sl) =>
				sl
					.setLimits(0, 4, 0.1)
					.setValue(s.speed)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.speed = v;
						await commit("speed");
					})
			);

		new Setting(containerEl)
			.setName("Orbit spacing")
			.setDesc("Distance between neighbouring orbits.")
			.addSlider((sl) =>
				sl
					.setLimits(1, 16, 0.5)
					.setValue(s.orbitSpacing)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.orbitSpacing = v;
						await commit("orbitSpacing");
					})
			);

		new Setting(containerEl)
			.setName("Body size")
			.addSlider((sl) =>
				sl
					.setLimits(0.3, 3, 0.1)
					.setValue(s.bodyScale)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.bodyScale = v;
						await commit("bodyScale");
					})
			);

		new Setting(containerEl)
			.setName("Orbit tilt")
			.setDesc("Maximum tilt of an orbit plane, in degrees. Zero makes every system flat.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 60, 1)
					.setValue(s.inclinationSpread)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.inclinationSpread = v;
						await commit("inclinationSpread");
					})
			);

		new Setting(containerEl)
			.setName("Stars")
			.setDesc(
				"A note carrying at least this many notes beneath it — children, grandchildren and so on — becomes a star of its own, lighting everything that orbits it. 1 leaves only the root of each system as a star."
			)
			.addSlider((sl) =>
				sl
					.setLimits(1, 60, 1)
					.setValue(s.starSubtreeSize)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.starSubtreeSize = v;
						await commit("starSubtreeSize");
					})
			);

		new Setting(containerEl).setName("Light and shadow").setHeading();

		new Setting(containerEl)
			.setName("Star brightness")
			.setDesc("How hard the stars shine on everything orbiting them.")
			.addSlider((sl) =>
				sl
					.setLimits(0.2, 3, 0.1)
					.setValue(s.starBrightness)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.starBrightness = v;
						await commit("starBrightness");
					})
			);

		new Setting(containerEl)
			.setName("Light falloff")
			.setDesc(
				"How fast light dims with distance: 0 spreads it evenly, 1 is linear, 2 is physically correct inverse-square. Raise it if a body lit by two stars shows two bright patches with a hard seam — the nearer star then wins clearly."
			)
			.addSlider((sl) =>
				sl
					.setLimits(0, 2, 0.1)
					.setValue(s.lightFalloff)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.lightFalloff = v;
						await commit("lightFalloff");
					})
			);

		new Setting(containerEl)
			.setName("Nearest star dominates")
			.setDesc(
				"Fades down every star but the closest one, so a body is lit from a single direction. Turn it off for true multi-star lighting — but a body sitting between two stars is then lit from both sides, with a dark seam where the two pools of light meet."
			)
			.addToggle((tg) =>
				tg.setValue(s.dominantLighting).onChange(async (v) => {
					s.dominantLighting = v;
					await commit("dominantLighting");
				})
			);

		new Setting(containerEl)
			.setName("Star halo")
			.setDesc(
				"Size of the glow around a star. The halo is cut out around the body itself, so it never lies on top of the surface."
			)
			.addSlider((sl) =>
				sl
					.setLimits(0, 2.5, 0.1)
					.setValue(s.starGlow)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.starGlow = v;
						await commit("starGlow");
					})
			);

		new Setting(containerEl)
			.setName("Corona")
			.setDesc("Density of the plasma motes boiling off a star's surface.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 2.5, 0.1)
					.setValue(s.coronaStrength)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.coronaStrength = v;
						await commit("coronaStrength");
					})
			);

		new Setting(containerEl)
			.setName("Shadows")
			.setDesc(
				"Bodies cast real shadows, so a moon passing behind its planet is genuinely eclipsed. Higher settings are sharper and cost more — each step also lets another star cast."
			)
			.addDropdown((d) =>
				d
					.addOption("off", "Off")
					.addOption("low", "Low — 512px, 1 star")
					.addOption("medium", "Medium — 1024px, 2 stars")
					.addOption("high", "High — 2048px, 3 stars")
					.setValue(s.shadowQuality)
					.onChange(async (v) => {
						s.shadowQuality = v as ShadowQuality;
						await commit("shadowQuality");
					})
			);

		new Setting(containerEl)
			.setName("Shadow depth")
			.setDesc(
				"How dark an eclipsed or unlit surface goes — this is the ambient fill, the only light reaching a shadowed face. Higher is more dramatic and makes eclipses obvious; lower keeps night sides readable."
			)
			.addSlider((sl) =>
				sl
					.setLimits(0, 1, 0.05)
					.setValue(s.shadowDepth)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.shadowDepth = v;
						await commit("shadowDepth");
					})
			);

		new Setting(containerEl)
			.setName("Light shafts")
			.setDesc(
				"Volumetric rays streaming out from the stars, broken by whatever passes in front of them. The most expensive effect here — turn it off first if the frame rate drops."
			)
			.addToggle((t) =>
				t.setValue(s.lightShafts).onChange(async (v) => {
					s.lightShafts = v;
					await commit("lightShafts");
				})
			);

		new Setting(containerEl)
			.setName("Light shaft strength")
			.addSlider((sl) =>
				sl
					.setLimits(0, 1.5, 0.05)
					.setValue(s.lightShaftStrength)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.lightShaftStrength = v;
						await commit("lightShaftStrength");
					})
			);

		new Setting(containerEl)
			.setName("Interstellar haze")
			.setDesc(
				"Fog through the system. Adds depth and gives the light shafts something to travel through. 0 is clear vacuum."
			)
			.addSlider((sl) =>
				sl
					.setLimits(0, 1.5, 0.05)
					.setValue(s.fogDensity)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.fogDensity = v;
						await commit("fogDensity");
					})
			);

		new Setting(containerEl)
			.setName("Glow")
			.setDesc("Bloom around stars, rings and bright surfaces. 0 turns the pass off entirely.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 1.5, 0.05)
					.setValue(s.glowStrength)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.glowStrength = v;
						await commit("glowStrength");
					})
			);

		new Setting(containerEl).setName("Appearance").setHeading();

		new Setting(containerEl)
			.setName("Surface textures")
			.setDesc(
				"Photographic surfaces: cloud bands on giants, craters on rocky notes, ice on leaves. Off gives flat coloured spheres, which is faster on weak hardware."
			)
			.addToggle((t) =>
				t.setValue(s.useTextures).onChange(async (v) => {
					s.useTextures = v;
					await commit("useTextures");
				})
			);

		new Setting(containerEl)
			.setName("Planetary rings")
			.setDesc(
				`Saturn-style rings on notes with ${ICE_GIANT_CHILDREN} or more children.`
			)
			.addToggle((t) =>
				t.setValue(s.showRings).onChange(async (v) => {
					s.showRings = v;
					await commit("showRings");
				})
			);

		new Setting(containerEl)
			.setName("Particle effects")
			.setDesc("Star coronas, dust along the asteroid belt, and haze across the system.")
			.addToggle((t) =>
				t.setValue(s.showParticles).onChange(async (v) => {
					s.showParticles = v;
					await commit("showParticles");
				})
			);

		new Setting(containerEl).setName("Show orbit rings").addToggle((t) =>
			t.setValue(s.showOrbits).onChange(async (v) => {
				s.showOrbits = v;
				await commit("showOrbits");
			})
		);

		new Setting(containerEl)
			.setName("Show cross-links")
			.setDesc(
				"Faint chords for the links the orbits can't express — in link mode that's every link outside the spanning tree."
			)
			.addToggle((t) =>
				t.setValue(s.showCrossLinks).onChange(async (v) => {
					s.showCrossLinks = v;
					await commit("showCrossLinks");
				})
			);

		new Setting(containerEl)
			.setName("Labels")
			.addDropdown((d) =>
				d
					.addOption("near", "Nearest bodies")
					.addOption("roots", "Stars and their planets")
					.addOption("none", "Hover only")
					.setValue(s.labelMode)
					.onChange(async (v) => {
						s.labelMode = v as LabelMode;
						await commit("labelMode");
					})
			);

		new Setting(containerEl)
			.setName("Label budget")
			.setDesc("How many labels may be on screen at once.")
			.addSlider((sl) =>
				sl
					.setLimits(10, 300, 10)
					.setValue(s.labelBudget)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.labelBudget = v;
						await commit("labelBudget");
					})
			);

		new Setting(containerEl).setName("Interaction").setHeading();

		new Setting(containerEl)
			.setName("Open note on click")
			.setDesc("Ctrl/Cmd-click opens in a new tab. Alt-click re-roots the system.")
			.addToggle((t) =>
				t.setValue(s.openOnClick).onChange(async (v) => {
					s.openOnClick = v;
					await commit("openOnClick");
				})
			);

		new Setting(containerEl)
			.setName("Follow selection")
			.setDesc("Keep the camera locked on the selected body while it orbits.")
			.addToggle((t) =>
				t.setValue(s.followSelection).onChange(async (v) => {
					s.followSelection = v;
					await commit("followSelection");
				})
			);

		new Setting(containerEl).setName("Performance").setHeading();

		new Setting(containerEl)
			.setName("Maximum bodies")
			.setDesc("Vaults larger than this are truncated; the view says so when it happens.")
			.addSlider((sl) =>
				sl
					.setLimits(200, 8000, 100)
					.setValue(s.maxNodes)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.maxNodes = v;
						await commit("maxNodes");
					})
			);
	}
}
