import {
	ACESFilmicToneMapping,
	AdditiveBlending,
	AmbientLight,
	BufferAttribute,
	BufferGeometry,
	CanvasTexture,
	Color,
	DoubleSide,
	Float32BufferAttribute,
	FogExp2,
	IcosahedronGeometry,
	LineBasicMaterial,
	LineLoop,
	LineSegments,
	Material,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	Object3D,
	PCFShadowMap,
	PerspectiveCamera,
	PointLight,
	Points,
	PointsMaterial,
	Raycaster,
	Scene,
	ShaderMaterial,
	SphereGeometry,
	Sprite,
	SpriteMaterial,
	SRGBColorSpace,
	Texture,
	Vector2,
	Vector3,
	WebGLRenderer,
	WebGLRenderTarget,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { BodyStyle } from "./classify";
import { STAR_TINTS, styleOf } from "./classify";
import type { SolarGraph, SolarNode } from "./graph";
import { walkGraph } from "./graph";
import { KEPLER_CONSTANT, type LayoutResult } from "./layout";
import { SHADOW_PRESETS, type SolarGraphSettings } from "./settings";

/**
 * Surface maps keyed the way classify.ts names them, plus "rings". Each class
 * holds several variants, picked per note so siblings don't look identical.
 */
export type TextureSet = Partial<Record<string, Texture[]>>;

/**
 * Render layers. Everything visible is on layer 0; these two extra ones exist so
 * the light shaft pass can draw the light sources and the things blocking them
 * separately.
 */
const LAYER_LIGHT = 1;
const LAYER_OCCLUDE = 2;

/** Point lights are per-star; too many wrecks the shader, so only the biggest get one. */
const MAX_STAR_LIGHTS = 4;
const MAX_CROSS_LINKS = 800;
const STARFIELD_COUNT = 2600;
/** Hover raycasting every frame is wasteful; every Nth is imperceptible. */
const HOVER_INTERVAL = 3;
const BACKGROUND = 0x05060e;
/** Camera elevation above the primary orbital plane, in radians. */
const VIEW_ELEVATION = 0.4;

/** Ring extent, as multiples of the planet's radius. */
const RING_INNER = 1.5;
const RING_OUTER = 2.45;
/** Particles in a star's corona, in a belt's dust cloud, and in the system haze. */
const CORONA_PARTICLES = 420;
const BELT_DUST_PARTICLES = 900;
const SYSTEM_DUST_PARTICLES = 700;
/** Only this many stars get a corona; the rest keep their glow sprite alone. */
const MAX_CORONAS = 4;
/**
 * Shadow maps are cube maps — six renders per light per frame — so past this many
 * bodies they're switched off rather than letting the view crawl.
 */
const SHADOW_BODY_LIMIT = 900;
/** A star's light reaches this many times its own system's radius, then stops. */
const LIGHT_RANGE = 2.8;
/** What a star that isn't the nearest one is dimmed to, when that's switched on. */
const SECONDARY_LIGHT = 0.12;
/** Fraction of the frame the framed system should fill. */
const FIT_MARGIN = 0.88;

interface BodyView {
	node: SolarNode;
	/** Rotated by ascending node + inclination; holds the static orbit ring. */
	tilt: Object3D;
	/** Rotated over time to sweep the body along its orbit. */
	spin: Object3D;
	/** Sits at orbitRadius; the body and all its children hang off this. */
	anchor: Object3D;
	mesh: Mesh;
	glow: Sprite | null;
	/** Resting glow opacity, restored when the pointer leaves. */
	glowOpacity: number;
	ring: LineLoop | null;
	/** Saturn-style ring plane, for notes with enough children to earn one. */
	rings: Mesh | null;
	style: BodyStyle;
}

/** A particle cloud that drifts, and optionally breathes. */
interface ParticleField {
	points: Points;
	spin: number;
	/** Opacity swing, as a fraction of the base opacity. 0 for none. */
	pulse: number;
	baseOpacity: number;
}

/**
 * Renders a SolarGraph as nested orbital systems.
 *
 * The hierarchy is expressed with real transform nesting — a child's tilt group
 * is parented to its parent's anchor — so rotating one pivot carries that body's
 * entire retinue of moons with it, exactly like a real system. No per-frame
 * position maths beyond setting one angle per body.
 */
export class SolarScene {
	private renderer: WebGLRenderer;
	private scene: Scene;
	private camera: PerspectiveCamera;
	private controls: OrbitControls;
	private labelLayer: HTMLElement;

	private root = new Object3D();
	private bodies = new Map<string, BodyView>();
	private meshes: Mesh[] = [];
	private crossLinkPairs: Array<[Object3D, Object3D]> = [];
	private crossLines: LineSegments | null = null;
	private starfield: Points | null = null;

	private sphereGeometries: SphereGeometry[] = [];
	/** Lumpy shapes for debris, so asteroids aren't just small planets. */
	private irregularGeometries: BufferGeometry[] = [];
	private circleGeometry: BufferGeometry;
	private ringPlaneGeometry: BufferGeometry;
	/**
	 * Halo textures by the fraction of the sprite the body fills. Each one has a
	 * hole in the middle so the halo never lies on top of the surface — a solid
	 * gradient there reads as a second, brighter light source pasted over the disc
	 * with a seam where it ends.
	 */
	private glowTextures = new Map<number, CanvasTexture>();
	private dustTexture: CanvasTexture;
	private ringMaterials: LineBasicMaterial[] = [];
	private highlightRing: LineBasicMaterial;
	private disposables: Array<{ dispose(): void }> = [];
	private particles: ParticleField[] = [];

	private ambient: AmbientLight;
	/**
	 * Star lights, brightest system first. `base` is the intensity the settings ask
	 * for; the live intensity is faded towards it so the nearest star can take over
	 * without the lighting popping.
	 */
	private starLights: Array<{ light: PointLight; node: SolarNode; base: number }> = [];
	/**
	 * The objects making up each star's light source, by node id. The shaft pass
	 * draws exactly one star at a time, so the others have to be maskable.
	 */
	private starLightObjects = new Map<string, Object3D[]>();
	/** Built lazily: only used while at least one effect is switched on. */
	private composer: EffectComposer | null = null;
	private renderPass: RenderPass | null = null;
	private shaftPass: LightShaftPass | null = null;
	private bloomPass: UnrealBloomPass | null = null;
	private outputPass: OutputPass | null = null;
	/** True when shadows were dropped because the system is too large for them. */
	shadowsSuppressed = false;

	private raycaster = new Raycaster();
	private pointer = new Vector2();
	private pointerInside = false;
	private pointerMoved = false;
	private frame = 0;
	private animationHandle = 0;
	private lastTick = 0;
	/** Advances with the speed setting applied, so pausing never jumps the system. */
	private simTime = 0;
	private extent = 40;
	private verticalExtent = 10;
	/** Throwaway camera used to solve for the framing distance. */
	private probeCamera = new PerspectiveCamera();
	private fitProbePoints: Vector3[] = [];

	private hovered: BodyView | null = null;
	private selected: BodyView | null = null;
	private focusTween: { from: Vector3; to: Vector3; target: Vector3; t: number } | null =
		null;

	private labelPool = new Map<string, HTMLElement>();
	private tmp = new Vector3();
	private tmp2 = new Vector3();

	onHover: ((node: SolarNode | null, x: number, y: number) => void) | null = null;
	onSelect: ((node: SolarNode, event: MouseEvent) => void) | null = null;

	constructor(
		private container: HTMLElement,
		private settings: SolarGraphSettings,
		private textures: TextureSet = {}
	) {
		this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
		// 1.5 rather than 2: combined with multisampling on the composer targets this
		// looks as good and renders far fewer pixels — at ratio 2 a full-width pane is
		// over 11 million of them.
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
		this.renderer.outputColorSpace = SRGBColorSpace;
		this.renderer.setClearColor(BACKGROUND, 1);
		// Star light spans a wide range once it falls off with distance, so an inner
		// world is far brighter than an outer one. Filmic tone mapping rolls the
		// highlights off instead of clipping them to flat white.
		this.renderer.toneMapping = ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.25;
		// PCFSoftShadowMap is deprecated in three 0.185; PCF gives a crisper edge,
		// which suits vacuum anyway — there's no atmosphere to soften an eclipse.
		this.renderer.shadowMap.type = PCFShadowMap;
		this.renderer.domElement.addClass("solar-graph-canvas");
		container.appendChild(this.renderer.domElement);

		this.labelLayer = container.createDiv({ cls: "solar-graph-labels" });

		this.scene = new Scene();
		// The background has to be set on the scene, not only via setClearColor:
		// the clear colour is written raw into the composer's linear buffer and the
		// output pass then gamma-converts it a second time, turning near-black into
		// navy. scene.background goes through three's colour management instead.
		this.scene.background = new Color(BACKGROUND);
		this.scene.add(this.root);
		this.ambient = new AmbientLight(0x8894b4, 0.9);
		this.scene.add(this.ambient);

		this.camera = new PerspectiveCamera(55, 1, 0.1, 200000);
		this.camera.position.set(0, 40, 90);

		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;
		this.controls.rotateSpeed = 0.7;
		this.controls.zoomSpeed = 0.9;

		// Shared geometry, one level of detail per generation.
		for (const [w, h] of [
			[48, 32],
			[32, 20],
			[20, 14],
			[12, 8],
		]) {
			this.sphereGeometries.push(new SphereGeometry(1, w, h));
		}
		for (let variant = 0; variant < 4; variant++) {
			this.irregularGeometries.push(makeIrregularGeometry(variant));
		}
		this.circleGeometry = makeCircleGeometry(160);
		this.ringPlaneGeometry = makeRingPlaneGeometry(RING_INNER, RING_OUTER, 96);
		this.dustTexture = makeDustTexture();
		this.highlightRing = new LineBasicMaterial({
			color: 0xffffff,
			transparent: true,
			opacity: 0.75,
		});
		for (let depth = 0; depth < 8; depth++) {
			this.ringMaterials.push(
				new LineBasicMaterial({
					color: 0x9fb4d9,
					transparent: true,
					opacity: Math.max(0.05, 0.22 - depth * 0.035),
				})
			);
		}

		this.bindEvents();
		this.resize();
	}

	// -- lifecycle ----------------------------------------------------------

	private bindEvents() {
		const canvas = this.renderer.domElement;
		let downX = 0;
		let downY = 0;
		let downTime = 0;

		const trackPointer = (event: PointerEvent) => {
			const rect = canvas.getBoundingClientRect();
			this.pointer.set(
				((event.clientX - rect.left) / rect.width) * 2 - 1,
				-((event.clientY - rect.top) / rect.height) * 2 + 1
			);
		};

		canvas.addEventListener("pointermove", (event) => {
			trackPointer(event);
			this.pointerInside = true;
			this.pointerMoved = true;
		});
		canvas.addEventListener("pointerleave", () => {
			this.pointerInside = false;
			this.setHovered(null);
		});
		canvas.addEventListener("pointerdown", (event) => {
			downX = event.clientX;
			downY = event.clientY;
			downTime = performance.now();
		});
		canvas.addEventListener("pointerup", (event) => {
			// A click is a press that neither dragged nor lingered — anything else
			// was the user orbiting the camera.
			const moved = Math.hypot(event.clientX - downX, event.clientY - downY);
			if (moved > 5 || performance.now() - downTime > 500) return;
			// Pick from where the release happened rather than the last hover: a tap
			// (touch, pen) never sends a move first.
			trackPointer(event);
			const hit = this.pick();
			if (hit && this.onSelect) this.onSelect(hit.node, event);
		});
	}

	start() {
		if (this.animationHandle) return;
		this.lastTick = performance.now();
		const loop = () => {
			// window-qualified so the loop keeps running in a popped-out window.
			this.animationHandle = window.requestAnimationFrame(loop);
			this.tick();
		};
		this.animationHandle = window.requestAnimationFrame(loop);
	}

	stop() {
		if (this.animationHandle) window.cancelAnimationFrame(this.animationHandle);
		this.animationHandle = 0;
	}

	dispose() {
		this.stop();
		this.clear();
		this.controls.dispose();
		for (const geometry of this.sphereGeometries) geometry.dispose();
		for (const geometry of this.irregularGeometries) geometry.dispose();
		this.circleGeometry.dispose();
		this.ringPlaneGeometry.dispose();
		for (const texture of this.glowTextures.values()) texture.dispose();
		this.glowTextures.clear();
		this.dustTexture.dispose();
		for (const material of this.ringMaterials) material.dispose();
		this.highlightRing.dispose();
		this.shaftPass?.dispose();
		this.bloomPass?.dispose();
		this.outputPass?.dispose();
		this.composer?.dispose();
		this.renderer.dispose();
		this.renderer.domElement.remove();
		this.labelLayer.remove();
	}

	resize() {
		const width = this.container.clientWidth;
		const height = this.container.clientHeight;
		// A pane in a background tab measures 0×0. Resizing to that would throw the
		// aspect ratio away and leave the framing wrong when the tab comes back.
		if (width < 2 || height < 2) return;
		this.renderer.setSize(width, height, false);
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.composer?.setSize(width, height);
	}

	/** Whether any post-processing effect is switched on. */
	private get postProcessing(): boolean {
		return (
			(this.settings.lightShafts && this.settings.lightShaftStrength > 0) ||
			this.settings.glowStrength > 0
		);
	}

	/**
	 * Builds the post-processing chain on first use. Kept lazy so a vault viewed
	 * with every effect off never pays for the extra render targets.
	 */
	private ensureComposer(): EffectComposer {
		if (this.composer) return this.composer;
		const width = Math.max(2, this.container.clientWidth);
		const height = Math.max(2, this.container.clientHeight);

		this.composer = new EffectComposer(this.renderer);
		this.renderPass = new RenderPass(this.scene, this.camera);
		this.shaftPass = new LightShaftPass(this.scene, this.camera, width, height);
		this.bloomPass = new UnrealBloomPass(new Vector2(width, height), 0.5, 0.75, 0.85);
		this.outputPass = new OutputPass();

		this.composer.addPass(this.renderPass);
		this.composer.addPass(this.shaftPass);
		this.composer.addPass(this.bloomPass);
		this.composer.addPass(this.outputPass);
		// The WebGL context is multisampled, but the composer's own targets are not
		// unless asked — without this, switching effects on visibly roughens every
		// orbit line.
		this.composer.renderTarget1.samples = 4;
		this.composer.renderTarget2.samples = 4;
		this.composer.setSize(width, height);
		return this.composer;
	}

	setSettings(settings: SolarGraphSettings) {
		this.settings = settings;
		for (const body of this.bodies.values()) {
			if (body.ring) body.ring.visible = settings.showOrbits;
			if (body.rings) body.rings.visible = settings.showRings;
		}
		if (this.crossLines) this.crossLines.visible = settings.showCrossLinks;
		for (const field of this.particles) field.points.visible = settings.showParticles;

		// Ambient light is the only thing reaching an unlit or eclipsed surface, so
		// it's the dial that decides how deep a shadow reads. Nothing else fills it
		// in: bodies deliberately have no self-illumination.
		this.ambient.intensity = 0.62 - settings.shadowDepth * 0.58;
		for (const entry of this.starLights) {
			this.tuneLight(entry.light, entry.node);
			entry.base = entry.light.intensity;
		}
		this.applyFog();

		if (this.postProcessing) {
			this.ensureComposer();
			if (this.shaftPass) {
				this.shaftPass.enabled = settings.lightShafts && settings.lightShaftStrength > 0;
				this.shaftPass.strength = settings.lightShaftStrength;
			}
			if (this.bloomPass) {
				this.bloomPass.enabled = settings.glowStrength > 0;
				this.bloomPass.strength = settings.glowStrength;
			}
		}
	}

	private applyFog() {
		const density = this.settings.fogDensity;
		if (density <= 0) {
			this.scene.fog = null;
			return;
		}
		// Scaled by the size of the system, so the haze looks the same whether the
		// vault is ten notes across or ten thousand.
		this.scene.fog = new FogExp2(0x060a16, (density * 0.55) / Math.max(this.extent, 1));
	}

	// -- construction -------------------------------------------------------

	/** Tears down the previous system and builds the new one. */
	build(graph: SolarGraph, layout: LayoutResult) {
		const previousSelection = this.selected?.node.id ?? null;
		this.clear();
		this.extent = layout.extent;
		this.verticalExtent = layout.verticalExtent;

		for (const star of graph.stars) this.addBody(star, this.root);
		this.addStarLights(graph);

		this.buildCrossLinks(graph);
		this.buildStarfield();
		if (this.settings.showParticles) {
			for (const star of graph.stars.slice(0, MAX_CORONAS)) this.buildCorona(star);
			for (const star of graph.stars) this.buildBeltDust(star);
			this.buildSystemDust();
		}
		// Framing reads world positions, so the fresh hierarchy must be resolved.
		this.scene.updateMatrixWorld(true);
		this.updateFitProbe();

		this.camera.far = Math.max(4000, this.extent * 60);
		this.camera.updateProjectionMatrix();
		this.controls.minDistance = 0.5;
		this.controls.maxDistance = this.extent * 14;

		if (previousSelection && this.bodies.has(previousSelection)) {
			this.selected = this.bodies.get(previousSelection) ?? null;
		}
		this.resetCamera();
	}

	private addBody(node: SolarNode, parentAnchor: Object3D) {
		const tilt = new Object3D();
		// YXZ: swing the orbit plane around the vertical first, then tip it over.
		tilt.rotation.order = "YXZ";
		tilt.rotation.set(node.inclination, node.ascendingNode, 0);
		parentAnchor.add(tilt);

		const spin = new Object3D();
		spin.rotation.y = node.phase;
		tilt.add(spin);

		const anchor = new Object3D();
		anchor.position.x = node.orbitRadius;
		// Belt debris is lifted off its ring so the belt has thickness.
		anchor.position.y = node.verticalOffset;
		spin.add(anchor);

		const style = styleOf(node);
		const isStar = style.kind === "star";
		const tint = this.tintFor(node, style);
		const geometry = style.irregular
			? this.irregularGeometries[hashIndex(node.id, this.irregularGeometries.length)]
			: this.sphereGeometries[Math.min(node.depth, this.sphereGeometries.length - 1)];
		const material = this.materialFor(node, style, tint);
		this.disposables.push(material);

		const mesh = new Mesh(geometry, material);
		mesh.scale.setScalar(node.bodyRadius);
		mesh.rotation.z = node.axialTilt;
		mesh.userData.nodeId = node.id;
		if (isStar) {
			// Stars are the light: they belong to the shaft pass's bright layer, and
			// they neither cast nor catch shadows. Which star is *on* that layer is
			// decided per frame — see aimLightShafts.
			this.registerLightObject(node.id, mesh);
		} else {
			mesh.layers.enable(LAYER_OCCLUDE);
			mesh.receiveShadow = true;
			// A translucent ghost casting a solid shadow looks wrong.
			mesh.castShadow = style.kind !== "ghost";
		}
		anchor.add(mesh);
		this.meshes.push(mesh);

		let glow: Sprite | null = null;
		// Dimmer than it was: with the hole cut out, the halo is read as light around
		// the body rather than as part of its surface, so it doesn't need to compete.
		const glowOpacity = (isStar ? 0.4 : 0.16) * Math.min(this.settings.starGlow, 1.6);
		const glowSpan = style.glow * Math.max(this.settings.starGlow, 0.001);
		if (style.glow > 0 && this.settings.starGlow > 0) {
			const glowMaterial = new SpriteMaterial({
				map: this.haloTexture(glowSpan),
				color: tint,
				blending: AdditiveBlending,
				transparent: true,
				depthWrite: false,
				opacity: glowOpacity,
			});
			this.disposables.push(glowMaterial);
			glow = new Sprite(glowMaterial);
			glow.scale.setScalar(node.bodyRadius * glowSpan);
			// Deliberately *not* on the light layer, even for stars: the halo is nine
			// times the body's radius, and smearing something that large radially
			// fills the frame with haze instead of producing rays.
			anchor.add(glow);
		}

		let rings: Mesh | null = null;
		const ringTexture = this.variantFor(node, "rings");
		if (style.hasRings && ringTexture && this.settings.useTextures) {
			const ringMaterial = new MeshBasicMaterial({
				map: ringTexture,
				transparent: true,
				side: DoubleSide,
				depthWrite: false,
				opacity: 0.92,
				// Shadow casting uses the depth material, which honours alphaTest but
				// not blending — without this the rings would cast a solid disc.
				alphaTest: 0.12,
			});
			this.disposables.push(ringMaterial);
			rings = new Mesh(this.ringPlaneGeometry, ringMaterial);
			rings.scale.setScalar(node.bodyRadius);
			// Rings sit in the planet's equatorial plane — the same tilt as its
			// spin axis — but on the anchor, so they don't turn with the surface.
			rings.rotation.z = node.axialTilt;
			rings.visible = this.settings.showRings;
			rings.castShadow = true;
			rings.receiveShadow = true;
			rings.layers.enable(LAYER_OCCLUDE);
			anchor.add(rings);
		}

		let ring: LineLoop | null = null;
		if (node.orbitRadius > 0) {
			ring = new LineLoop(
				this.circleGeometry,
				this.ringMaterials[Math.min(node.depth, this.ringMaterials.length - 1)]
			);
			ring.scale.setScalar(node.orbitRadius);
			ring.visible = this.settings.showOrbits;
			// On the tilt group, not the spin group: the path itself doesn't rotate.
			tilt.add(ring);
		}

		this.bodies.set(node.id, {
			node,
			tilt,
			spin,
			anchor,
			mesh,
			glow,
			glowOpacity,
			ring,
			rings,
			style,
		});

		for (const child of node.children) this.addBody(child, anchor);
	}

	/**
	 * Builds the surface material for a body. Stars are unlit so they read as the
	 * light source; everything else is shaded, with its own map doubling as an
	 * emissive map so the night side shows a hint of surface instead of a void.
	 */
	private materialFor(node: SolarNode, style: BodyStyle, tint: number): Material {
		const map =
			style.texture && this.settings.useTextures
				? this.variantFor(node, style.texture)
				: null;

		if (style.kind === "star") {
			return new MeshBasicMaterial({
				map: map ?? undefined,
				// Held below full white on purpose. At 1.0 the disc sits above the bloom
				// threshold everywhere, so the whole surface blooms into a flat white
				// blob and the granulation disappears. Dimming the disc keeps the detail
				// and lets the halo and corona do the blazing.
				color: map ? 0xc4c4c4 : tint,
			});
		}
		if (style.kind === "ghost") {
			return new MeshStandardMaterial({
				color: node.color,
				roughness: 0.95,
				metalness: 0,
				transparent: true,
				opacity: 0.6,
				emissive: new Color(node.color),
				emissiveIntensity: style.emissive,
			});
		}
		return new MeshStandardMaterial({
			map: map ?? undefined,
			// A little of the node's own colour keeps siblings from looking like
			// copies of each other, without washing the photograph out.
			color: map ? new Color(0xffffff).lerp(new Color(node.color), 0.22) : new Color(node.color),
			roughness: style.kind === "gas-giant" || style.kind === "ice-giant" ? 0.85 : 0.62,
			metalness: 0.02,
			// No emissive map. Using the surface as its own light source made every
			// body glow in the dark, which is exactly what hid the eclipses: a
			// shadowed moon still lit itself.
			emissive: new Color(node.color),
			emissiveIntensity: style.emissive,
		});
	}

	private buildCrossLinks(graph: SolarGraph) {
		const links = graph.crossLinks.slice(0, MAX_CROSS_LINKS);
		if (links.length === 0) return;

		this.crossLinkPairs = [];
		for (const [a, b] of links) {
			const from = this.bodies.get(a);
			const to = this.bodies.get(b);
			if (from && to) this.crossLinkPairs.push([from.anchor, to.anchor]);
		}
		if (this.crossLinkPairs.length === 0) return;

		const geometry = new BufferGeometry();
		geometry.setAttribute(
			"position",
			new BufferAttribute(new Float32Array(this.crossLinkPairs.length * 6), 3)
		);
		const material = new LineBasicMaterial({
			color: 0x93a7d4,
			transparent: true,
			opacity: 0.11,
			depthWrite: false,
		});
		this.crossLines = new LineSegments(geometry, material);
		this.crossLines.frustumCulled = false;
		this.crossLines.visible = this.settings.showCrossLinks;
		this.scene.add(this.crossLines);
		this.disposables.push(geometry, material);
	}

	/**
	 * Lights every star that earned one, biggest system first.
	 *
	 * Each light is *local*: it falls off and is cut off beyond its own system's
	 * reach. That matters for eclipses — with uniform lights, a moon in its
	 * planet's shadow is still lit by every other star in the vault and the shadow
	 * never shows. Only the first few stars cast shadows, since a point light's
	 * shadow is a cube map and costs six renders a frame.
	 */
	private addStarLights(graph: SolarGraph) {
		this.starLights = [];
		const stars: SolarNode[] = [];
		walkGraph(graph, (node) => {
			if (styleOf(node).kind === "star") stars.push(node);
		});
		// Biggest first, so the limited light and shadow slots go where they show.
		stars.sort((a, b) => b.subtreeSize - a.subtreeSize);

		const preset = SHADOW_PRESETS[this.settings.shadowQuality];
		this.shadowsSuppressed = preset.size > 0 && this.bodies.size > SHADOW_BODY_LIMIT;
		const shadowLights = this.shadowsSuppressed ? 0 : preset.lights;
		this.renderer.shadowMap.enabled = shadowLights > 0;

		for (const [index, star] of stars.slice(0, MAX_STAR_LIGHTS).entries()) {
			const body = this.bodies.get(star.id);
			if (!body) continue;
			const reach = Math.max(star.systemRadius, star.bodyRadius * 6) * LIGHT_RANGE;
			const light = new PointLight(
				new Color(this.tintFor(star, body.style)).lerp(new Color(0xffffff), 0.35)
			);
			light.distance = reach;
			this.tuneLight(light, star);

			if (index < shadowLights) {
				light.castShadow = true;
				light.shadow.mapSize.set(preset.size, preset.size);
				light.shadow.camera.near = Math.max(star.bodyRadius * 0.5, 0.05);
				light.shadow.camera.far = reach;
				// Without these, curved surfaces stripe themselves with their own
				// shadow at this scale.
				light.shadow.bias = -0.0015;
				light.shadow.normalBias = Math.max(0.02, star.bodyRadius * 0.02);
				light.shadow.radius = 2;
			}
			body.anchor.add(light);
			this.starLights.push({ light, node: star, base: light.intensity });
		}
	}

	/**
	 * A halo sized for a body that fills `1 / span` of the sprite, cached by span.
	 *
	 * The hole in the middle is the point: a plain radial gradient puts its
	 * brightest pixels over the body's own surface, so you see a bright blob with a
	 * soft edge sitting on the disc — two light sources that don't line up. Starting
	 * the glow at the limb instead makes it read as light coming off the body.
	 */
	private haloTexture(span: number): CanvasTexture {
		const key = Math.round(span * 20) / 20;
		const cached = this.glowTextures.get(key);
		if (cached) return cached;
		const texture = makeHaloTexture(1 / Math.max(key, 1.05));
		this.glowTextures.set(key, texture);
		return texture;
	}

	/** Adds an object to a star's light group, for the shaft pass to draw. */
	private registerLightObject(starId: string, object: Object3D) {
		const group = this.starLightObjects.get(starId);
		if (group) group.push(object);
		else this.starLightObjects.set(starId, [object]);
	}

	/**
	 * Puts exactly one star on the light layer.
	 *
	 * The shafts are smeared radially from a single anchor point, so any *other*
	 * star left in the occlusion buffer gets stretched along the axis between the
	 * two and shows up as a cone beaming out of it.
	 */
	private soloLightSource(starId: string | null) {
		for (const [id, group] of this.starLightObjects) {
			const on = id === starId;
			for (const object of group) {
				if (on) object.layers.enable(LAYER_LIGHT);
				else object.layers.disable(LAYER_LIGHT);
			}
		}
	}

	/**
	 * Sets a star light's falloff and brightness from the current settings.
	 *
	 * Intensity has to track the falloff exponent: with `decay` d, irradiance goes
	 * as intensity / distance^d, so the intensity needed to light a body at a given
	 * distance grows with d. Referencing it to a typical orbital distance keeps a
	 * system looking the same as the falloff dial is turned.
	 */
	private tuneLight(light: PointLight, star: SolarNode) {
		const decay = this.settings.lightFalloff;
		const reference = Math.max(star.systemRadius * 0.4, star.bodyRadius * 2, 1);
		light.decay = decay;
		// The 11 is measured, not guessed: it puts a lit surface at a typical orbital
		// distance around 170/255 at peak, leaving headroom before the highlights
		// roll off.
		light.intensity =
			11 * Math.pow(reference, decay) * Math.max(this.settings.starBrightness, 0.01);
	}

	/** A star's colour, taken from whichever surface variant it was given. */
	private tintFor(node: SolarNode, style: BodyStyle): number {
		if (style.kind !== "star") return node.color;
		const variants = this.textures.star?.length ?? STAR_TINTS.length;
		return STAR_TINTS[this.variantIndex(node, "star", variants) % STAR_TINTS.length];
	}

	/**
	 * Which variant of a surface class this note gets. Stable per note, so a body
	 * keeps its face across rebuilds, and shared between the map and the tint so a
	 * blue-white star doesn't end up with a gold corona.
	 */
	private variantIndex(node: SolarNode, base: string, count: number): number {
		return hashIndex(`${node.id}${base}`, Math.max(count, 1));
	}

	private variantFor(node: SolarNode, base: string): Texture | null {
		const variants = this.textures[base];
		if (!variants || variants.length === 0) return null;
		return variants[this.variantIndex(node, base, variants.length)];
	}

	/**
	 * Builds a particle cloud from a positions array and adds it to `parent`.
	 * Returns the field so the caller can register it for animation.
	 */
	private addParticles(
		parent: Object3D,
		positions: Float32Array,
		options: {
			color: number;
			size: number;
			opacity: number;
			spin: number;
			pulse?: number;
		}
	): ParticleField {
		const geometry = new BufferGeometry();
		geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
		const material = new PointsMaterial({
			map: this.dustTexture,
			color: options.color,
			size: options.size,
			sizeAttenuation: true,
			transparent: true,
			opacity: options.opacity,
			depthWrite: false,
			blending: AdditiveBlending,
		});
		const points = new Points(geometry, material);
		points.frustumCulled = false;
		parent.add(points);
		this.disposables.push(geometry, material);

		const field: ParticleField = {
			points,
			spin: options.spin,
			pulse: options.pulse ?? 0,
			baseOpacity: options.opacity,
		};
		this.particles.push(field);
		return field;
	}

	/** A shell of plasma motes around a star, so it looks like it's burning. */
	private buildCorona(star: SolarNode) {
		const body = this.bodies.get(star.id);
		if (!body) return;
		const count = Math.round(CORONA_PARTICLES * this.settings.coronaStrength);
		if (count <= 0) return;
		const positions = new Float32Array(count * 3);
		for (let i = 0; i < count; i++) {
			// Uniform direction, with the radius biased outward so the cloud reads
			// as a corona hugging the surface rather than a fog ball.
			const u = Math.random() * 2 - 1;
			const theta = Math.random() * Math.PI * 2;
			const ring = Math.sqrt(1 - u * u);
			const radius = star.bodyRadius * (1.15 + Math.pow(Math.random(), 1.6) * 1.5);
			positions[i * 3] = Math.cos(theta) * ring * radius;
			positions[i * 3 + 1] = u * radius;
			positions[i * 3 + 2] = Math.sin(theta) * ring * radius;
		}
		const field = this.addParticles(body.anchor, positions, {
			color: new Color(this.tintFor(star, body.style))
				.lerp(new Color(0xfff1c0), 0.45)
				.getHex(),
			// Fine motes: any bigger and the corona reads as a rash of blobs
			// sitting on top of the star rather than light coming off it.
			size: Math.max(0.12, star.bodyRadius * 0.1),
			opacity: 0.65,
			spin: 0.12,
			pulse: 0.35,
		});
		// The corona is part of the light source, so it feeds the shafts too.
		this.registerLightObject(star.id, field.points);
	}

	/** Dust along the asteroid belt, which is what makes a few rocks read as a belt. */
	private buildBeltDust(star: SolarNode) {
		const debris = star.children.filter((child) => child.inBelt);
		if (debris.length === 0) return;

		let inner = Infinity;
		let outer = 0;
		for (const rock of debris) {
			inner = Math.min(inner, rock.orbitRadius - rock.systemRadius);
			outer = Math.max(outer, rock.orbitRadius + rock.systemRadius);
		}
		const thickness = Math.max(...debris.map((r) => Math.abs(r.verticalOffset) + r.bodyRadius));

		const positions = new Float32Array(BELT_DUST_PARTICLES * 3);
		for (let i = 0; i < BELT_DUST_PARTICLES; i++) {
			const angle = Math.random() * Math.PI * 2;
			const radius = inner + Math.random() * (outer - inner);
			positions[i * 3] = Math.cos(angle) * radius;
			// Concentrated towards the belt plane, thinning out with height.
			positions[i * 3 + 1] = (Math.random() + Math.random() - 1) * thickness * 1.3;
			positions[i * 3 + 2] = Math.sin(angle) * radius;
		}

		// Lay the dust in the debris' own orbital plane.
		const plane = new Object3D();
		plane.rotation.order = "YXZ";
		plane.rotation.set(debris[0].inclination, debris[0].ascendingNode, 0);
		this.bodies.get(star.id)?.anchor.add(plane);

		this.addParticles(plane, positions, {
			color: 0xb9a68c,
			size: Math.max(0.14, thickness * 0.22),
			opacity: 0.42,
			// Drifts at roughly the speed the rocks themselves orbit at.
			spin: KEPLER_CONSTANT / Math.pow(Math.max((inner + outer) / 2, 1), 1.5),
		});
	}

	/** Faint haze across the primary plane, which gives the system depth. */
	private buildSystemDust() {
		const positions = new Float32Array(SYSTEM_DUST_PARTICLES * 3);
		for (let i = 0; i < SYSTEM_DUST_PARTICLES; i++) {
			const angle = Math.random() * Math.PI * 2;
			// sqrt keeps the motes evenly spread over the disc's area rather than
			// bunching them all near the star.
			const radius = Math.sqrt(Math.random()) * this.extent;
			positions[i * 3] = Math.cos(angle) * radius;
			positions[i * 3 + 1] = (Math.random() + Math.random() - 1) * this.verticalExtent * 0.7;
			positions[i * 3 + 2] = Math.sin(angle) * radius;
		}
		this.addParticles(this.root, positions, {
			color: 0x7f8dbb,
			size: Math.max(0.2, this.extent * 0.004),
			opacity: 0.3,
			spin: 0.006,
		});
	}

	private buildStarfield() {
		const radius = this.extent * 25;
		const positions = new Float32Array(STARFIELD_COUNT * 3);
		const colors = new Float32Array(STARFIELD_COUNT * 3);
		for (let i = 0; i < STARFIELD_COUNT; i++) {
			// Uniform on the sphere: cosine-distributed latitude avoids polar clumping.
			const u = Math.random() * 2 - 1;
			const theta = Math.random() * Math.PI * 2;
			const r = Math.sqrt(1 - u * u);
			positions[i * 3] = Math.cos(theta) * r * radius;
			positions[i * 3 + 1] = u * radius;
			positions[i * 3 + 2] = Math.sin(theta) * r * radius;
			// Vertex colours bypass colour management, so these are kept dim: they
			// come out brighter once the frame goes through the output pass.
			const shade = 0.22 + Math.random() * 0.5;
			// A cool/warm split makes the field look less like static.
			colors[i * 3] = shade * (0.85 + Math.random() * 0.15);
			colors[i * 3 + 1] = shade * 0.95;
			colors[i * 3 + 2] = shade;
		}
		const geometry = new BufferGeometry();
		geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
		geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
		const material = new PointsMaterial({
			size: 1.6,
			sizeAttenuation: false,
			vertexColors: true,
			transparent: true,
			opacity: 0.9,
			depthWrite: false,
			// The starfield sits outside the system; haze shouldn't erase it.
			fog: false,
		});
		this.starfield = new Points(geometry, material);
		this.starfield.frustumCulled = false;
		this.scene.add(this.starfield);
		this.disposables.push(geometry, material);
	}

	private clear() {
		this.root.clear();
		if (this.crossLines) {
			this.scene.remove(this.crossLines);
			this.crossLines = null;
		}
		if (this.starfield) {
			this.scene.remove(this.starfield);
			this.starfield = null;
		}
		for (const item of this.disposables) item.dispose();
		this.disposables = [];
		this.particles = [];
		this.starLightObjects.clear();
		this.bodies.clear();
		this.meshes = [];
		this.crossLinkPairs = [];
		this.hovered = null;
		this.selected = null;
		this.focusTween = null;
		for (const label of this.labelPool.values()) label.remove();
		this.labelPool.clear();
	}

	// -- per-frame ----------------------------------------------------------

	private tick() {
		const now = performance.now();
		const delta = Math.min(0.1, (now - this.lastTick) / 1000);
		this.lastTick = now;
		this.frame++;

		this.simTime += delta * this.settings.speed;
		for (const body of this.bodies.values()) {
			const node = body.node;
			if (node.angularSpeed !== 0) {
				body.spin.rotation.y = node.phase + node.angularSpeed * this.simTime;
			}
			body.mesh.rotation.y = node.spinSpeed * this.simTime;
			// Debris tumbles end over end instead of spinning about a fixed pole.
			if (body.style.irregular) {
				body.mesh.rotation.x = node.spinSpeed * 0.62 * this.simTime;
			}
		}

		for (const field of this.particles) {
			field.points.rotation.y = field.spin * this.simTime;
			if (field.pulse > 0) {
				const material = field.points.material as PointsMaterial;
				material.opacity =
					field.baseOpacity * (1 + field.pulse * Math.sin(this.simTime * 1.7));
			}
		}

		this.updateDominantLight(delta);
		this.updateFocus(delta);
		this.controls.update();
		// World matrices must be current before anything reads world positions.
		this.scene.updateMatrixWorld(true);

		this.followSelection();
		this.updateCrossLinks();
		if (this.pointerInside && this.pointerMoved && this.frame % HOVER_INTERVAL === 0) {
			this.pointerMoved = false;
			this.setHovered(this.pick());
		}
		this.updateLabels();
		this.renderFrame();
	}

	private renderFrame() {
		if (!this.postProcessing) {
			this.renderer.render(this.scene, this.camera);
			return;
		}
		const composer = this.ensureComposer();
		if (this.shaftPass?.enabled) this.aimLightShafts(this.shaftPass);
		composer.render();
	}

	/**
	 * Points the shaft pass at whichever lit star is nearest the camera, and fades
	 * the effect out as that star leaves the frame — shafts anchored to a light
	 * source off the edge of the screen streak across it in the wrong direction.
	 */
	private aimLightShafts(pass: LightShaftPass) {
		let best: { light: PointLight; node: SolarNode } | null = null;
		let bestDistance = Infinity;
		for (const entry of this.starLights) {
			entry.light.getWorldPosition(this.tmp);
			const distance = this.tmp.distanceToSquared(this.camera.position);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = entry;
			}
		}
		if (!best) {
			pass.fade = 0;
			this.soloLightSource(null);
			return;
		}
		this.soloLightSource(best.node.id);

		best.light.getWorldPosition(this.tmp);
		this.tmp2.copy(this.tmp).applyMatrix4(this.camera.matrixWorldInverse);
		if (this.tmp2.z > -this.camera.near) {
			pass.fade = 0;
			return;
		}
		this.tmp.project(this.camera);
		pass.light.set(this.tmp.x * 0.5 + 0.5, this.tmp.y * 0.5 + 0.5);
		// Fade out as the star approaches the frame edge and reach zero just past it.
		// Anchoring the smear on a light that is off screen makes every pixel sample
		// in nearly the same direction, which floods the whole frame with white
		// instead of producing rays.
		const offScreen = Math.max(Math.abs(this.tmp.x), Math.abs(this.tmp.y));
		pass.fade = Math.max(0, Math.min(1, (1.05 - offScreen) / 0.3));
	}

	/**
	 * Fades all but the nearest star down.
	 *
	 * Two stars lighting one body from opposite sides leaves a dark seam between two
	 * pools of light, and it can't be fixed with distance falloff: each star's
	 * intensity is normalised to the size of its own system, so a big distant star
	 * and a small nearby one arrive at similar strength. Picking a winner per frame
	 * and fading the rest gives a single clean terminator — and makes shadows read,
	 * since a second light would fill the first one's shadow straight back in.
	 */
	private updateDominantLight(delta: number) {
		if (this.starLights.length === 0) return;
		let nearest = this.starLights[0];
		if (this.starLights.length > 1 && this.settings.dominantLighting) {
			let best = Infinity;
			for (const entry of this.starLights) {
				entry.light.getWorldPosition(this.tmp);
				// Relative to the system's own size: being 100 units from a small star
				// is much deeper inside it than 100 units from a huge one.
				const scale = Math.max(entry.node.systemRadius, entry.node.bodyRadius * 6);
				const distance = this.tmp.distanceTo(this.controls.target) / scale;
				if (distance < best) {
					best = distance;
					nearest = entry;
				}
			}
		}
		// Smooth, so moving the camera between systems doesn't switch the lighting
		// with a visible jump.
		const rate = Math.min(1, delta * 3.5);
		for (const entry of this.starLights) {
			const wanted =
				!this.settings.dominantLighting || entry === nearest
					? entry.base
					: entry.base * SECONDARY_LIGHT;
			entry.light.intensity += (wanted - entry.light.intensity) * rate;
		}
	}

	private updateCrossLinks() {
		if (!this.crossLines || !this.crossLines.visible) return;
		const attribute = this.crossLines.geometry.getAttribute("position") as BufferAttribute;
		const array = attribute.array as Float32Array;
		for (let i = 0; i < this.crossLinkPairs.length; i++) {
			const [a, b] = this.crossLinkPairs[i];
			a.getWorldPosition(this.tmp);
			b.getWorldPosition(this.tmp2);
			array[i * 6] = this.tmp.x;
			array[i * 6 + 1] = this.tmp.y;
			array[i * 6 + 2] = this.tmp.z;
			array[i * 6 + 3] = this.tmp2.x;
			array[i * 6 + 4] = this.tmp2.y;
			array[i * 6 + 5] = this.tmp2.z;
		}
		attribute.needsUpdate = true;
	}

	/** Rides along with the selected body so it doesn't orbit out of frame. */
	private followSelection() {
		if (!this.selected || !this.settings.followSelection || this.focusTween) return;
		this.selected.anchor.getWorldPosition(this.tmp);
		this.tmp.sub(this.controls.target);
		if (this.tmp.lengthSq() < 1e-8) return;
		this.controls.target.add(this.tmp);
		this.camera.position.add(this.tmp);
	}

	private updateFocus(delta: number) {
		const tween = this.focusTween;
		if (!tween) return;
		tween.t = Math.min(1, tween.t + delta * 2.2);
		// Ease-out cubic: quick departure, gentle arrival.
		const k = 1 - Math.pow(1 - tween.t, 3);
		this.camera.position.lerpVectors(tween.from, tween.to, k);
		this.controls.target.lerp(tween.target, k);
		if (tween.t >= 1) this.focusTween = null;
	}

	// -- picking, hover, selection -----------------------------------------

	private pick(): BodyView | null {
		if (this.meshes.length === 0) return null;
		this.raycaster.setFromCamera(this.pointer, this.camera);
		const hits = this.raycaster.intersectObjects(this.meshes, false);
		if (hits.length === 0) return null;
		const id = hits[0].object.userData.nodeId as string | undefined;
		return id ? this.bodies.get(id) ?? null : null;
	}

	private setHovered(body: BodyView | null) {
		if (body === this.hovered) return;
		if (this.hovered?.ring) {
			this.hovered.ring.material =
				this.ringMaterials[
					Math.min(this.hovered.node.depth, this.ringMaterials.length - 1)
				];
		}
		if (this.hovered?.glow) {
			this.hovered.glow.material.opacity = this.hovered.glowOpacity;
		}
		this.hovered = body;
		if (body?.ring) body.ring.material = this.highlightRing;
		if (body?.glow) {
			body.glow.material.opacity = Math.min(1, body.glowOpacity * 1.9);
		}
		this.renderer.domElement.toggleClass("is-hovering", body !== null);

		if (this.onHover) {
			if (body) {
				body.anchor.getWorldPosition(this.tmp);
				const screen = this.toScreen(this.tmp);
				this.onHover(body.node, screen?.x ?? 0, screen?.y ?? 0);
			} else {
				this.onHover(null, 0, 0);
			}
		}
	}

	select(nodeId: string | null, focus = true) {
		const body = nodeId ? this.bodies.get(nodeId) ?? null : null;
		this.selected = body;
		for (const [id, other] of this.bodies) {
			other.mesh.renderOrder = id === nodeId ? 1 : 0;
		}
		if (body && focus) this.focusOn(body);
	}

	get selectedNode(): SolarNode | null {
		return this.selected?.node ?? null;
	}

	private focusOn(body: BodyView) {
		body.anchor.getWorldPosition(this.tmp);
		// Back off far enough to see the body and its immediate retinue.
		const distance = Math.max(
			body.node.bodyRadius * 6,
			body.node.systemRadius * 1.6,
			2
		);
		const direction = this.camera.position
			.clone()
			.sub(this.controls.target)
			.normalize();
		if (direction.lengthSq() < 1e-6) direction.set(0.4, 0.5, 1).normalize();
		this.focusTween = {
			from: this.camera.position.clone(),
			to: this.tmp.clone().add(direction.multiplyScalar(distance)),
			target: this.tmp.clone(),
			t: 0,
		};
	}

	resetCamera() {
		this.selected = null;
		const distance = this.fitDistance();
		const direction = new Vector3(0, Math.sin(VIEW_ELEVATION), Math.cos(VIEW_ELEVATION))
			.multiplyScalar(distance);
		this.focusTween = {
			from: this.camera.position.clone(),
			to: direction,
			target: new Vector3(0, 0, 0),
			t: 0,
		};
	}

	/**
	 * How far back the camera must sit for the whole system to fit on screen.
	 *
	 * Solved by bisection on "does everything fit", which is monotonic in distance:
	 * pull back and the content can only get smaller. Scaling the distance by how
	 * far out of frame things are — the obvious approach — oscillates, and worse,
	 * a point *behind* the camera divides by a negative w and lands back inside the
	 * frame, so an overshoot can look like a perfect fit from inside the system.
	 * Rejecting anything behind the near plane is what makes this reliable.
	 */
	private fitDistance(): number {
		const probe = this.probeCamera;
		probe.fov = this.camera.fov;
		probe.aspect = this.camera.aspect;
		probe.near = this.camera.near;
		probe.far = this.camera.far;
		probe.updateProjectionMatrix();

		const direction = new Vector3(0, Math.sin(VIEW_ELEVATION), Math.cos(VIEW_ELEVATION));
		const fits = (distance: number): boolean => {
			probe.position.copy(direction).multiplyScalar(distance);
			probe.lookAt(0, 0, 0);
			probe.updateMatrixWorld(true);
			for (const point of this.fitProbePoints) {
				// View space: the camera looks down -z, so anything with z above
				// -near is level with the lens or behind it.
				this.tmp.copy(point).applyMatrix4(probe.matrixWorldInverse);
				if (this.tmp.z > -probe.near) return false;
				this.tmp2.copy(point).project(probe);
				if (Math.abs(this.tmp2.x) > FIT_MARGIN) return false;
				if (Math.abs(this.tmp2.y) > FIT_MARGIN) return false;
			}
			return true;
		};

		// Expand until it fits, then close in on the tightest distance that does.
		let low = 0;
		let high = Math.max(this.extent, 1) * 2;
		for (let guard = 0; guard < 40 && !fits(high); guard++) {
			low = high;
			high *= 1.6;
		}
		for (let step = 0; step < 22; step++) {
			const mid = (low + high) / 2;
			if (fits(mid)) high = mid;
			else low = mid;
		}
		return high;
	}

	/**
	 * Collects the points the framing has to fit: samples along the orbit rings as
	 * they currently sit in the world.
	 *
	 * This is deliberately the drawn geometry rather than a closed-form bound. A
	 * cylinder around the system is a guaranteed bound but wastes half the screen
	 * on corners no body can reach, and a flattened sphere doesn't actually contain
	 * a tilted circle. Rings are what the user sees, so fitting them looks right;
	 * bodies can drift slightly past the edge as their parents swing around, which
	 * "frame everything" re-solves.
	 *
	 * Requires world matrices to be current.
	 */
	private updateFitProbe() {
		const candidates: Array<{ body: BodyView; span: number }> = [];
		for (const body of this.bodies.values()) {
			if (body.node.orbitRadius <= 0) continue;
			body.tilt.getWorldPosition(this.tmp);
			candidates.push({ body, span: this.tmp.length() + body.node.orbitRadius });
		}
		// Only the outermost rings can define the silhouette.
		candidates.sort((a, b) => b.span - a.span);
		const chosen = candidates.slice(0, 300);

		const points: Vector3[] = [];
		// Fine enough that the widest point of a ring can't hide between samples.
		const segments = 40;
		for (const { body } of chosen) {
			const radius = body.node.orbitRadius;
			for (let i = 0; i < segments; i++) {
				const angle = (i / segments) * Math.PI * 2;
				points.push(
					new Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius).applyMatrix4(
						body.tilt.matrixWorld
					)
				);
			}
		}

		// A lone star has no rings to fit, so fall back to its own size.
		if (points.length === 0) {
			const radius = Math.max(this.extent, 1);
			for (let i = 0; i < segments; i++) {
				const angle = (i / segments) * Math.PI * 2;
				points.push(new Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
			}
		}
		this.fitProbePoints = points;
	}

	// -- labels -------------------------------------------------------------

	private toScreen(world: Vector3): { x: number; y: number; z: number } | null {
		const projected = world.clone().project(this.camera);
		if (projected.z < -1 || projected.z > 1) return null;
		const rect = this.renderer.domElement.getBoundingClientRect();
		return {
			x: (projected.x * 0.5 + 0.5) * rect.width,
			y: (-projected.y * 0.5 + 0.5) * rect.height,
			z: projected.z,
		};
	}

	private updateLabels() {
		const mode = this.settings.labelMode;
		const width = this.renderer.domElement.clientWidth;
		const height = this.renderer.domElement.clientHeight;

		// Belt debris is never labelled automatically — thirty names stacked on one
		// ring is noise, and hovering still names any single rock.
		const nameable = (body: BodyView) => body.style.kind !== "asteroid";

		let candidates: BodyView[];
		if (mode === "none") {
			candidates = [];
		} else if (mode === "roots") {
			candidates = [...this.bodies.values()].filter(
				(b) => b.node.depth <= 1 && nameable(b)
			);
		} else {
			candidates = [...this.bodies.values()].filter(nameable);
		}

		// Nearest bodies win the label budget.
		if (candidates.length > this.settings.labelBudget) {
			const scored = candidates.map((body) => {
				body.anchor.getWorldPosition(this.tmp);
				return { body, distance: this.tmp.distanceToSquared(this.camera.position) };
			});
			scored.sort((a, b) => a.distance - b.distance);
			candidates = scored.slice(0, this.settings.labelBudget).map((s) => s.body);
		}
		// The body under the cursor and the selected one are always named.
		for (const extra of [this.hovered, this.selected]) {
			if (extra && !candidates.includes(extra)) candidates.push(extra);
		}

		const live = new Set<string>();
		const fadeDistance = this.camera.position.distanceTo(this.controls.target) * 4;
		// Pixels per world unit at a given depth, used to clear the body with the label.
		const halfV = Math.tan(((this.camera.fov * Math.PI) / 180) / 2);
		const pixelScale = height / 2 / Math.max(halfV, 1e-6);

		for (const body of candidates) {
			body.anchor.getWorldPosition(this.tmp);
			const screen = this.toScreen(this.tmp);
			if (!screen) continue;
			if (screen.x < -80 || screen.y < -40 || screen.x > width + 80 || screen.y > height + 40) {
				continue;
			}
			const distance = this.tmp.distanceTo(this.camera.position);
			const isFeatured = body === this.hovered || body === this.selected;
			const opacity = isFeatured
				? 1
				: Math.max(0, Math.min(1, 1.15 - distance / Math.max(fadeDistance, 1)));
			if (opacity <= 0.06) continue;

			live.add(body.node.id);
			let label = this.labelPool.get(body.node.id);
			if (!label) {
				label = this.labelLayer.createDiv({ cls: "solar-graph-label" });
				label.setText(body.node.label);
				this.labelPool.set(body.node.id, label);
			}
			label.toggleClass("is-star", body.node.parent === null);
			label.toggleClass("is-featured", isFeatured);
			label.toggleClass("is-unresolved", body.node.kind === "unresolved");
			label.style.opacity = opacity.toFixed(2);
			// Sit the label just under the body instead of on top of it.
			const offset = Math.min(90, (body.node.bodyRadius * pixelScale) / distance) + 10;
			label.style.transform = `translate(-50%, -50%) translate(${Math.round(screen.x)}px, ${Math.round(screen.y + offset)}px)`;
		}

		for (const [id, label] of this.labelPool) {
			if (!live.has(id)) {
				label.remove();
				this.labelPool.delete(id);
			}
		}
	}
}

/**
 * Volumetric light shafts.
 *
 * Renders the stars alone into a small buffer, paints everything that could block
 * them over the top in black, then smears that buffer radially away from the light
 * and adds the result to the frame. The black occluders are what carve shadows out
 * of the rays, so a planet drifting in front of its star visibly cuts the beams.
 *
 * This is the screen-space approximation rather than a true raymarch through a fog
 * volume: no shadow-map lookups, no depth integration, one extra half-resolution
 * scene render. It reads as light propagating through haze, and it runs on a
 * laptop.
 */
class LightShaftPass extends Pass {
	/** Light position in UV space, set each frame by the scene. */
	light = new Vector2(0.5, 0.5);
	strength = 0.55;
	/** Tapers the effect off as the light leaves the frame. */
	fade = 1;

	private occlusion: WebGLRenderTarget;
	private shafts: WebGLRenderTarget;
	/**
	 * Uniforms are held as typed objects rather than reached for through
	 * `material.uniforms`, which three types as `any`.
	 */
	private readonly blurUniforms = {
		tDiffuse: { value: null as Texture | null },
		lightPos: { value: new Vector2(0.5, 0.5) },
		// How far along the ray to the light each pixel gathers from. Push this up
		// and the rays reach across the whole frame as a flat wash.
		density: { value: 0.55 },
		decay: { value: 0.94 },
		// Unity gain: sum(weight · decay^i) over the samples is about 1, so the pass
		// adds light of roughly the source's own brightness rather than forty times
		// it. `strength` is the user-facing dial on top.
		weight: { value: 0.055 },
	};
	private readonly combineUniforms = {
		tDiffuse: { value: null as Texture | null },
		tShafts: { value: null as Texture | null },
		strength: { value: 0.55 },
	};
	private blurMaterial: ShaderMaterial;
	private combineMaterial: ShaderMaterial;
	private quad: FullScreenQuad;
	private black = new MeshBasicMaterial({ color: 0x000000, fog: false });

	constructor(
		private scene: Scene,
		private camera: PerspectiveCamera,
		width: number,
		height: number
	) {
		super();
		// Half resolution: the output is a heavy blur, so the detail is wasted.
		this.occlusion = new WebGLRenderTarget(Math.max(1, width >> 1), Math.max(1, height >> 1));
		this.shafts = new WebGLRenderTarget(Math.max(1, width >> 1), Math.max(1, height >> 1));

		this.blurMaterial = new ShaderMaterial({
			uniforms: this.blurUniforms,
			vertexShader: FULLSCREEN_VERTEX,
			fragmentShader: /* glsl */ `
				uniform sampler2D tDiffuse;
				uniform vec2 lightPos;
				uniform float density;
				uniform float decay;
				uniform float weight;
				varying vec2 vUv;

				const int SAMPLES = 40;

				void main() {
					// Step from this pixel towards the light, accumulating whatever the
					// occlusion buffer holds along the way and dimming as we go.
					vec2 coord = vUv;
					// Not named "step": that would shadow the built-in step() used below.
					vec2 stride = (vUv - lightPos) * (density / float(SAMPLES));
					float illumination = 1.0;
					vec3 total = vec3(0.0);
					for (int i = 0; i < SAMPLES; i++) {
						coord -= stride;
						// Samples that walk off the buffer would otherwise read the
						// clamped edge pixel over and over, painting a hard streak from
						// the border of the screen. Drop them instead.
						vec2 inside = step(vec2(0.0), coord) * step(coord, vec2(1.0));
						total +=
							texture2D(tDiffuse, coord).rgb * illumination * weight *
							inside.x * inside.y;
						illumination *= decay;
					}
					// Bounded: a light close to the frame edge can otherwise have most
					// samples land on it at once, and the sum runs away into white.
					gl_FragColor = vec4(min(total, vec3(1.2)), 1.0);
				}
			`,
		});

		this.combineMaterial = new ShaderMaterial({
			uniforms: this.combineUniforms,
			vertexShader: FULLSCREEN_VERTEX,
			fragmentShader: /* glsl */ `
				uniform sampler2D tDiffuse;
				uniform sampler2D tShafts;
				uniform float strength;
				varying vec2 vUv;

				void main() {
					vec4 scene = texture2D(tDiffuse, vUv);
					vec3 shafts = texture2D(tShafts, vUv).rgb * strength;
					gl_FragColor = vec4(scene.rgb + shafts, scene.a);
				}
			`,
		});

		this.quad = new FullScreenQuad(this.blurMaterial);
	}

	setSize(width: number, height: number) {
		this.occlusion.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
		this.shafts.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
	}

	render(
		renderer: WebGLRenderer,
		writeBuffer: WebGLRenderTarget,
		readBuffer: WebGLRenderTarget
	) {
		const silent = this.fade <= 0 || this.strength <= 0;
		if (silent && !this.renderToScreen) {
			// Nothing to add, so skip the work — but the composer swaps its read and
			// write buffers after every pass that claims to need it. Returning without
			// clearing needsSwap leaves the next pass reading a buffer this one never
			// wrote, which showed up as the whole frame going white.
			this.needsSwap = false;
			return;
		}
		this.needsSwap = true;
		if (silent) {
			// On screen and nothing to add: copy the frame through at zero strength.
			// The stale shaft buffer is harmless because it's multiplied away.
			this.combineUniforms.tDiffuse.value = readBuffer.texture;
			this.combineUniforms.tShafts.value = this.shafts.texture;
			this.combineUniforms.strength.value = 0;
			this.quad.material = this.combineMaterial;
			renderer.setRenderTarget(null);
			this.quad.render(renderer);
			return;
		}

		const previousLayers = this.camera.layers.mask;
		const previousOverride = this.scene.overrideMaterial;
		const previousAutoClear = renderer.autoClear;
		const previousTarget = renderer.getRenderTarget();
		const previousBackground = this.scene.background;

		// The lights, alone against black. The scene's own background would tint the
		// occlusion buffer and the whole frame would gain a haze.
		this.scene.background = null;
		renderer.setRenderTarget(this.occlusion);
		renderer.setClearColor(0x000000, 1);
		renderer.clear();
		this.camera.layers.set(LAYER_LIGHT);
		renderer.render(this.scene, this.camera);

		// Then everything solid, in black, over the top.
		renderer.autoClear = false;
		this.camera.layers.set(LAYER_OCCLUDE);
		this.scene.overrideMaterial = this.black;
		renderer.render(this.scene, this.camera);

		this.scene.overrideMaterial = previousOverride;
		this.scene.background = previousBackground;
		this.camera.layers.mask = previousLayers;
		renderer.autoClear = previousAutoClear;

		// Smear it away from the light.
		this.blurUniforms.tDiffuse.value = this.occlusion.texture;
		this.blurUniforms.lightPos.value.copy(this.light);
		this.quad.material = this.blurMaterial;
		renderer.setRenderTarget(this.shafts);
		renderer.clear();
		this.quad.render(renderer);

		// Add it to the frame.
		this.combineUniforms.tDiffuse.value = readBuffer.texture;
		this.combineUniforms.tShafts.value = this.shafts.texture;
		this.combineUniforms.strength.value = this.strength * this.fade;
		this.quad.material = this.combineMaterial;
		renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
		if (this.clear) renderer.clear();
		this.quad.render(renderer);

		renderer.setRenderTarget(previousTarget);
		renderer.setClearColor(BACKGROUND, 1);
	}

	dispose() {
		this.occlusion.dispose();
		this.shafts.dispose();
		this.blurMaterial.dispose();
		this.combineMaterial.dispose();
		this.black.dispose();
		this.quad.dispose();
	}
}

const FULLSCREEN_VERTEX = /* glsl */ `
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	}
`;

/** Picks one of `count` variants for a node, stably. */
function hashIndex(id: string, count: number): number {
	let h = 2166136261;
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0) % count;
}

/**
 * A lumpy rock. The displacement is a smooth function of *position*, not of
 * vertex index, because an icosahedron's geometry is non-indexed — neighbouring
 * faces have their own copies of a shared corner, and index-based noise would
 * pull those copies apart and crack the surface open.
 */
function makeIrregularGeometry(variant: number): BufferGeometry {
	const geometry = new IcosahedronGeometry(1, 1);
	const position = geometry.getAttribute("position");
	const seed = 1 + variant * 2.7;
	for (let i = 0; i < position.count; i++) {
		const x = position.getX(i);
		const y = position.getY(i);
		const z = position.getZ(i);
		const lumps =
			Math.sin(x * 2.9 + seed) * Math.cos(y * 2.3 - seed) * Math.sin(z * 3.1 + seed * 0.5);
		const scale = 0.82 + 0.3 * lumps;
		position.setXYZ(i, x * scale, y * scale, z * scale);
	}
	geometry.computeVertexNormals();
	return geometry;
}

/**
 * A flat annulus in the XZ plane with *radial* UVs, so the ring strip is read
 * outward from the planet. RingGeometry's own UVs map to a square instead, which
 * would smear the band pattern across the ring.
 */
function makeRingPlaneGeometry(
	inner: number,
	outer: number,
	segments: number
): BufferGeometry {
	const positions: number[] = [];
	const uvs: number[] = [];
	const indices: number[] = [];

	for (let i = 0; i <= segments; i++) {
		const angle = (i / segments) * Math.PI * 2;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		positions.push(cos * inner, 0, sin * inner);
		uvs.push(0, i / segments);
		positions.push(cos * outer, 0, sin * outer);
		uvs.push(1, i / segments);
	}
	for (let i = 0; i < segments; i++) {
		const a = i * 2;
		indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
	}

	const geometry = new BufferGeometry();
	geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
	geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
	geometry.setIndex(indices);
	geometry.computeVertexNormals();
	return geometry;
}

/** Soft round mote, shared by every particle cloud. */
function makeDustTexture(): CanvasTexture {
	const size = 32;
	const canvas = createEl("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d")!;
	const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	gradient.addColorStop(0, "rgba(255,255,255,1)");
	gradient.addColorStop(0.45, "rgba(255,255,255,0.35)");
	gradient.addColorStop(1, "rgba(255,255,255,0)");
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, size, size);
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace;
	return texture;
}

/** A unit circle in the XZ plane, shared by every orbit ring and scaled per body. */
function makeCircleGeometry(segments: number): BufferGeometry {
	const positions = new Float32Array(segments * 3);
	for (let i = 0; i < segments; i++) {
		const angle = (i / segments) * Math.PI * 2;
		positions[i * 3] = Math.cos(angle);
		positions[i * 3 + 1] = 0;
		positions[i * 3 + 2] = Math.sin(angle);
	}
	const geometry = new BufferGeometry();
	geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
	return geometry;
}

/**
 * A halo with a hole in it, for the light around a body.
 *
 * `bodyFraction` is how much of the sprite's radius the body itself covers. Inside
 * that the texture is empty, so nothing is painted over the surface; from the limb
 * outwards it rises quickly and then falls away smoothly. A plain centre-bright
 * gradient instead produces a distinct second bright region on top of the disc with
 * a visible edge where it stops — two areas of light that don't transition.
 */
function makeHaloTexture(bodyFraction: number): CanvasTexture {
	const size = 256;
	const canvas = createEl("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d")!;
	const centre = size / 2;
	const gradient = ctx.createRadialGradient(centre, centre, 0, centre, centre, centre);

	const limb = Math.min(Math.max(bodyFraction, 0.02), 0.9);
	gradient.addColorStop(0, "rgba(255,255,255,0)");
	// Empty right up to just inside the limb, so the body's own surface is untouched.
	gradient.addColorStop(limb * 0.94, "rgba(255,255,255,0)");
	gradient.addColorStop(Math.min(limb * 1.03, 0.98), "rgba(255,255,255,0.55)");
	// Then a quick, smooth decay — several stops, because two would show a kink,
	// and a slow one spreads enough additive light to wash out the whole frame.
	gradient.addColorStop(Math.min(limb + (1 - limb) * 0.07, 0.99), "rgba(255,255,255,0.17)");
	gradient.addColorStop(Math.min(limb + (1 - limb) * 0.18, 0.995), "rgba(255,255,255,0.05)");
	gradient.addColorStop(Math.min(limb + (1 - limb) * 0.42, 0.999), "rgba(255,255,255,0.012)");
	gradient.addColorStop(1, "rgba(255,255,255,0)");

	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, size, size);
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace;
	return texture;
}
