import { Plugin, WorkspaceLeaf } from "obsidian";
import {
	DEFAULT_SETTINGS,
	SolarGraphSettingTab,
	needsRebuild,
	type SolarGraphSettings,
} from "./settings";
import { SOLAR_GRAPH_VIEW, SolarGraphView } from "./view";

/**
 * Settings that change how bodies are placed or built, but not which bodies
 * exist. These rebuild the scene from the existing tree — no vault re-read.
 */
const RELAYOUT_KEYS: Array<keyof SolarGraphSettings> = [
	"orbitSpacing",
	"bodyScale",
	"inclinationSpread",
	// Materials, particle clouds and shadow-casting flags are all set during the
	// build, so toggling them can't be done by flipping a visibility flag.
	"useTextures",
	"showParticles",
	"shadowQuality",
];

export default class SolarGraphPlugin extends Plugin {
	settings: SolarGraphSettings = { ...DEFAULT_SETTINGS };

	async onload() {
		await this.loadSettings();

		this.registerView(
			SOLAR_GRAPH_VIEW,
			(leaf: WorkspaceLeaf) => new SolarGraphView(leaf, this)
		);

		this.addRibbonIcon("orbit", "Open solar graph", () => void this.activateView());

		// Obsidian prefixes command ids with the plugin id and names with the plugin
		// name, so neither repeats "solar graph" here.
		this.addCommand({
			id: "open-view",
			name: "Open view",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "toggle-hierarchy",
			name: "Toggle hierarchy: links / folders",
			callback: async () => {
				this.settings.hierarchy = this.settings.hierarchy === "links" ? "folders" : "links";
				await this.saveSettings("hierarchy");
			},
		});

		this.addSettingTab(new SolarGraphSettingTab(this.app, this));
	}

	async activateView() {
		const existing = this.app.workspace.getLeavesOfType(SOLAR_GRAPH_VIEW);
		if (existing.length > 0) {
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: SOLAR_GRAPH_VIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	/**
	 * Persists settings and tells open views how much work the change implies —
	 * a live tweak, a re-layout, or a full read of the vault.
	 */
	async saveSettings(changed?: keyof SolarGraphSettings) {
		await this.saveData(this.settings);
		const rebuild = changed ? needsRebuild(changed) : true;
		const relayout = changed ? RELAYOUT_KEYS.includes(changed) : true;
		for (const leaf of this.app.workspace.getLeavesOfType(SOLAR_GRAPH_VIEW)) {
			const view = leaf.view;
			if (view instanceof SolarGraphView) view.applySettings(rebuild, relayout);
		}
	}
}
