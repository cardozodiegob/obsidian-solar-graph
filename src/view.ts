import {
	ItemView,
	Notice,
	TFile,
	WorkspaceLeaf,
	debounce,
	setIcon,
	setTooltip,
} from "obsidian";
import {
	ClampToEdgeWrapping,
	RepeatWrapping,
	SRGBColorSpace,
	Texture,
	TextureLoader,
} from "three";
import { CLASS_LABELS, styleOf } from "./classify";
import type SolarGraphPlugin from "./main";
import { buildFolderGraph, buildLinkGraph, type SolarGraph, type SolarNode } from "./graph";
import { layoutGraph, type LayoutResult } from "./layout";
import { SolarScene, type TextureSet } from "./scene";
import { TEXTURE_SOURCES } from "./textures";
import type { SolarGraphSettings } from "./settings";

export const SOLAR_GRAPH_VIEW = "solar-graph-view";

export class SolarGraphView extends ItemView {
	private scene: SolarScene | null = null;
	private stage!: HTMLElement;
	private tooltip!: HTMLElement;
	private statusEl!: HTMLElement;
	private toolbarEl!: HTMLElement;

	private graph: SolarGraph | null = null;
	private layout: LayoutResult | null = null;
	/** Set by alt-clicking a body; overrides the root-mode setting until reset. */
	private rootOverride: string | null = null;
	private paused = false;
	private resizeObserver: ResizeObserver | null = null;
	private textures: TextureSet = {};

	private scheduleRebuild = debounce(() => this.rebuild(), 700, true);

	constructor(leaf: WorkspaceLeaf, private plugin: SolarGraphPlugin) {
		super(leaf);
		this.navigation = false;
	}

	getViewType() {
		return SOLAR_GRAPH_VIEW;
	}

	getDisplayText() {
		return "Solar graph";
	}

	getIcon() {
		return "orbit";
	}

	// -- lifecycle ----------------------------------------------------------

	async onOpen() {
		this.contentEl.empty();
		this.contentEl.addClass("solar-graph-content");

		this.stage = this.contentEl.createDiv({ cls: "solar-graph-stage" });
		// Focusable so the keyboard shortcuts have somewhere to land.
		this.stage.tabIndex = 0;

		this.textures = await this.loadTextures();
		this.scene = new SolarScene(this.stage, this.effectiveSettings(), this.textures);
		this.scene.onHover = (node, x, y) => this.showTooltip(node, x, y);
		this.scene.onSelect = (node, event) => this.handleSelect(node, event);

		this.toolbarEl = this.stage.createDiv({ cls: "solar-graph-toolbar" });
		this.tooltip = this.stage.createDiv({ cls: "solar-graph-tooltip" });
		this.statusEl = this.stage.createDiv({ cls: "solar-graph-status" });
		this.buildToolbar();

		this.resizeObserver = new ResizeObserver(() => this.scene?.resize());
		this.resizeObserver.observe(this.stage);

		this.registerEvent(
			this.app.metadataCache.on("resolved", () => this.scheduleRebuild())
		);
		this.registerEvent(this.app.vault.on("create", () => this.scheduleRebuild()));
		this.registerEvent(this.app.vault.on("delete", () => this.scheduleRebuild()));
		this.registerEvent(this.app.vault.on("rename", () => this.scheduleRebuild()));
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => this.handleFileOpen(file))
		);

		this.registerDomEvent(this.stage, "pointerdown", () => this.stage.focus());
		this.registerDomEvent(this.stage, "keydown", (event) => this.handleKey(event));
		// Don't burn frames on a system nobody is looking at.
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.hidden) this.scene?.stop();
			else this.scene?.start();
		});

		this.rebuild();
		this.scene.start();
	}

	async onClose() {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.scene?.dispose();
		this.scene = null;
		// The scene disposes materials it made; the maps belong to the view.
		for (const variants of Object.values(this.textures)) {
			for (const texture of variants ?? []) texture.dispose();
		}
		this.textures = {};
	}

	/**
	 * Decodes the surface maps that were embedded in the bundle at build time.
	 *
	 * Nothing is read from disk and nothing is fetched: the maps arrive as data URLs
	 * inside main.js, because Obsidian's installer only ever downloads main.js,
	 * manifest.json and styles.css from a release.
	 */
	private async loadTextures(): Promise<TextureSet> {
		const loader = new TextureLoader();
		const set: TextureSet = {};

		await Promise.all(
			Object.entries(TEXTURE_SOURCES).map(async ([key, sources]) => {
				const loaded: Texture[] = [];
				for (const source of sources) {
					try {
						const texture: Texture = await loader.loadAsync(source);
						texture.colorSpace = SRGBColorSpace;
						// Sphere maps wrap around the equator and clamp at the poles. The
						// ring strip is the other way round: it runs outward from the
						// planet, and repeats around the circumference.
						texture.wrapS = key === "rings" ? ClampToEdgeWrapping : RepeatWrapping;
						texture.wrapT = key === "rings" ? RepeatWrapping : ClampToEdgeWrapping;
						texture.anisotropy = 4;
						loaded.push(texture);
					} catch (error) {
						console.error(`Solar graph: could not decode a ${key} texture`, error);
					}
				}
				if (loaded.length > 0) set[key] = loaded;
			})
		);
		return set;
	}

	// -- toolbar ------------------------------------------------------------

	private buildToolbar() {
		const bar = this.toolbarEl;
		bar.empty();
		const settings = this.plugin.settings;

		const group = bar.createDiv({ cls: "solar-graph-segmented" });
		const addSegment = (label: string, value: "links" | "folders") => {
			const button = group.createEl("button", { text: label });
			button.toggleClass("is-active", settings.hierarchy === value);
			setTooltip(
				button,
				value === "links"
					? "Orbits follow your links (spanning tree from the root note)"
					: "Orbits follow the folder tree"
			);
			button.onclick = async () => {
				if (settings.hierarchy === value) return;
				settings.hierarchy = value;
				this.rootOverride = null;
				await this.plugin.saveSettings("hierarchy");
			};
		};
		addSegment("Links", "links");
		addSegment("Folders", "folders");

		const iconButton = (
			icon: string,
			tooltip: string,
			onClick: () => void
		): HTMLElement => {
			const button = bar.createEl("button", { cls: "solar-graph-icon-button" });
			setIcon(button, icon);
			setTooltip(button, tooltip);
			button.onclick = onClick;
			return button;
		};

		const playButton = iconButton(
			this.paused ? "play" : "pause",
			this.paused ? "Resume orbits (Space)" : "Pause orbits (Space)",
			() => {
				this.paused = !this.paused;
				setIcon(playButton, this.paused ? "play" : "pause");
				setTooltip(
					playButton,
					this.paused ? "Resume orbits (Space)" : "Pause orbits (Space)"
				);
				this.scene?.setSettings(this.effectiveSettings());
			}
		);

		const speed = bar.createEl("input", { cls: "solar-graph-speed" });
		speed.type = "range";
		speed.min = "0";
		speed.max = "4";
		speed.step = "0.1";
		speed.value = String(settings.speed);
		setTooltip(speed, "Orbital speed");
		speed.oninput = () => {
			settings.speed = Number(speed.value);
			this.scene?.setSettings(this.effectiveSettings());
		};
		speed.onchange = () => void this.plugin.saveSettings("speed");

		iconButton("crosshair", "Re-root on the open note (link mode)", () => {
			const file = this.app.workspace.getActiveFile();
			if (!file) {
				new Notice("No note is open.");
				return;
			}
			if (settings.hierarchy !== "links") {
				new Notice("Re-rooting only applies in link mode.");
				return;
			}
			this.rootOverride = file.path;
			this.rebuild();
		});

		iconButton("focus", "Frame the whole system (R)", () => this.scene?.resetCamera());
	}

	private handleKey(event: KeyboardEvent) {
		if (event.key === " ") {
			event.preventDefault();
			this.paused = !this.paused;
			this.scene?.setSettings(this.effectiveSettings());
			this.buildToolbar();
		} else if (event.key === "r" || event.key === "R") {
			this.scene?.resetCamera();
		} else if (event.key === "Escape") {
			this.scene?.select(null);
			this.hideTooltip();
		}
	}

	// -- data ---------------------------------------------------------------

	private effectiveSettings(): SolarGraphSettings {
		// Pausing is a view concern, not a saved setting, so it's layered on here.
		return { ...this.plugin.settings, speed: this.paused ? 0 : this.plugin.settings.speed };
	}

	private resolveRoot(): string | null {
		if (this.rootOverride) return this.rootOverride;
		if (this.plugin.settings.rootMode === "active") {
			return this.app.workspace.getActiveFile()?.path ?? null;
		}
		return null;
	}

	/** Re-reads the vault, rebuilds the tree, re-lays it out and rebuilds the scene. */
	rebuild() {
		if (!this.scene) return;
		const settings = this.plugin.settings;
		this.graph =
			settings.hierarchy === "folders"
				? buildFolderGraph(this.app, settings)
				: buildLinkGraph(this.app, settings, this.resolveRoot());
		this.layout = layoutGraph(this.graph, settings);
		this.scene.setSettings(this.effectiveSettings());
		this.scene.build(this.graph, this.layout);
		this.updateStatus();
		this.selectActiveFile(false);
	}

	/** Cheaper path for changes that only move things around. */
	relayout() {
		if (!this.scene || !this.graph) return this.rebuild();
		this.layout = layoutGraph(this.graph, this.plugin.settings);
		this.scene.setSettings(this.effectiveSettings());
		this.scene.build(this.graph, this.layout);
		this.updateStatus();
	}

	/** Called by the plugin when settings change. */
	applySettings(needsRebuild: boolean, needsRelayout: boolean) {
		if (needsRebuild) this.rebuild();
		else if (needsRelayout) this.relayout();
		else this.scene?.setSettings(this.effectiveSettings());
		this.buildToolbar();
	}

	private updateStatus() {
		if (!this.graph) return;
		const star = this.graph.stars[0];
		const parts = [
			`${this.graph.nodeCount} ${this.graph.nodeCount === 1 ? "body" : "bodies"}`,
		];
		if (this.graph.stars.length > 1) parts.push(`${this.graph.stars.length} systems`);
		const belt = star?.children.filter((child) => child.inBelt).length ?? 0;
		if (belt > 0) parts.push(`${belt} in the belt`);
		if (this.plugin.settings.showCrossLinks && this.graph.crossLinks.length > 0) {
			parts.push(`${this.graph.crossLinks.length} cross-links`);
		}
		if (star) parts.push(`★ ${star.label}`);

		this.statusEl.empty();
		this.statusEl.createSpan({ text: parts.join("  ·  ") });
		if (this.graph.truncated) {
			this.statusEl.createSpan({
				cls: "solar-graph-warning",
				text: `  ·  truncated at ${this.plugin.settings.maxNodes} bodies`,
			});
		}
	}

	// -- interaction --------------------------------------------------------

	private handleSelect(node: SolarNode, event: MouseEvent) {
		if (event.altKey) {
			if (this.plugin.settings.hierarchy !== "links") {
				new Notice("Re-rooting only applies in link mode.");
				return;
			}
			if (!node.path) {
				new Notice(`"${node.label}" isn't a note, so it can't be a star.`);
				return;
			}
			this.rootOverride = node.path;
			this.rebuild();
			return;
		}

		this.scene?.select(node.id);

		if (!this.plugin.settings.openOnClick) return;
		if (node.kind === "unresolved") {
			new Notice(`"${node.label}" doesn't exist yet.`);
			return;
		}
		if (!node.path) return;
		const file = this.app.vault.getAbstractFileByPath(node.path);
		if (!(file instanceof TFile)) return;
		const newTab = event.ctrlKey || event.metaKey;
		void this.app.workspace.getLeaf(newTab ? "tab" : false).openFile(file);
	}

	private handleFileOpen(file: TFile | null) {
		if (this.plugin.settings.rootMode === "active" && !this.rootOverride && file) {
			this.scheduleRebuild();
			return;
		}
		this.selectActiveFile(false);
	}

	/** Mark the open note in the sky without yanking the camera around. */
	private selectActiveFile(focus: boolean) {
		const path = this.app.workspace.getActiveFile()?.path;
		if (!path || !this.graph?.nodes.has(path)) return;
		this.scene?.select(path, focus);
	}

	private showTooltip(node: SolarNode | null, x: number, y: number) {
		if (!node) {
			this.hideTooltip();
			return;
		}
		this.tooltip.empty();
		this.tooltip.createDiv({ cls: "solar-graph-tooltip-title", text: node.label });

		const detail: string[] = [CLASS_LABELS[styleOf(node).kind]];
		if (node.kind === "folder" || node.kind === "vault") detail.push("folder");
		if (node.children.length > 0) {
			detail.push(`${node.children.length} orbiting`);
		}
		if (node.kind === "file") {
			detail.push(`${node.degree} ${node.degree === 1 ? "link" : "links"}`);
		}
		if (node.subtreeSize > 1) detail.push(`${node.subtreeSize} in system`);
		this.tooltip.createDiv({
			cls: "solar-graph-tooltip-meta",
			text: detail.join("  ·  "),
		});

		this.tooltip.addClass("is-visible");
		const bounds = this.stage.getBoundingClientRect();
		const width = this.tooltip.offsetWidth;
		const height = this.tooltip.offsetHeight;
		// Keep the card on screen when the body is near an edge.
		const left = Math.min(Math.max(8, x + 16), bounds.width - width - 8);
		const top = Math.min(Math.max(8, y - height - 14), bounds.height - height - 8);
		this.tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
	}

	private hideTooltip() {
		this.tooltip.removeClass("is-visible");
	}
}
