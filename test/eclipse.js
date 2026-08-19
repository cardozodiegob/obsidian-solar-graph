// Forces a perfect eclipse and reports where to look, so a screenshot can be
// measured rather than eyeballed.
//
// A synthetic vault of Sun → Planet → Moon is swapped in, the moon's orbit is
// flattened and its phase set so it sits exactly on the line from the star
// through the planet, and the camera is placed to the side so both are visible.
// The moon should be dark. Run it twice, with shadows on and off, and compare the
// brightness at the returned coordinates:
//
//   node test/inspect.mjs "window.__solarEclipse={shadows:'off'}"
//   node test/inspect.mjs test/eclipse.js off.png
//   node test/inspect.mjs "window.__solarEclipse={shadows:'medium'}"
//   node test/inspect.mjs test/eclipse.js on.png
(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const options = window.__solarEclipse ?? {};
	const leaf = window.app.workspace.getLeavesOfType("solar-graph-view")[0];
	if (!leaf) return "no solar graph view open";
	const view = leaf.view;
	const cache = window.app.metadataCache;
	const vault = window.app.vault;

	// --- a three-body vault ------------------------------------------------
	const resolved = { "Sun.md": { "Planet.md": 1 }, "Planet.md": { "Moon.md": 1 }, "Moon.md": {} };
	const files = ["Sun.md", "Planet.md", "Moon.md"];
	if (!window.__solarDemoBackup) {
		window.__solarDemoBackup = {
			resolvedLinks: cache.resolvedLinks,
			unresolvedLinks: cache.unresolvedLinks,
			getMarkdownFiles: vault.getMarkdownFiles,
		};
	}
	cache.resolvedLinks = resolved;
	cache.unresolvedLinks = {};
	vault.getMarkdownFiles = () => files.map((path) => ({ path, extension: "md" }));

	const settings = view.plugin.settings;
	settings.hierarchy = "links";
	// Only the root should be a star, or the planet ignites and lights its own moon.
	settings.starSubtreeSize = 1;
	if (options.shadows) settings.shadowQuality = options.shadows;
	view.rootOverride = "Sun.md";
	view.rebuild();
	await sleep(1200);

	const scene = view.scene;
	const sun = scene.bodies.get("Sun.md");
	const planet = scene.bodies.get("Planet.md");
	const moon = scene.bodies.get("Moon.md");
	if (!sun || !planet || !moon) return "bodies missing";

	// --- force the alignment ----------------------------------------------
	// The planet's anchor sits at +X from the star, so within the planet's frame
	// "directly away from the star" is also +X. A flat, unrotated orbit with phase
	// 0 puts the moon exactly there: straight down the shadow's axis.
	moon.node.inclination = 0;
	moon.node.ascendingNode = 0;
	moon.node.phase = 0;
	moon.node.angularSpeed = 0;
	moon.node.verticalOffset = 0;
	moon.tilt.rotation.set(0, 0, 0);
	moon.spin.rotation.set(0, 0, 0);
	moon.anchor.position.set(moon.node.orbitRadius, 0, 0);
	planet.node.angularSpeed = 0;
	view.paused = true;
	scene.setSettings(view.effectiveSettings());

	// Optional overrides, to work out what is filling an eclipsed surface back in.
	if (options.ambient !== undefined) scene.ambient.intensity = options.ambient;
	if (options.emissive !== undefined) {
		for (const [, body] of scene.bodies) {
			const material = body.mesh.material;
			if ("emissiveIntensity" in material) material.emissiveIntensity = options.emissive;
		}
	}
	await sleep(150);
	scene.scene.updateMatrixWorld(true);

	// --- camera: off to the side, looking at the moon ----------------------
	const Vec = moon.anchor.position.constructor;
	const moonPoint = moon.anchor.getWorldPosition(new Vec());
	const sunPoint = sun.anchor.getWorldPosition(new Vec());
	const planetPoint = planet.anchor.getWorldPosition(new Vec());
	// Perpendicular to the star→moon axis, so the shadowed face is side-on.
	const axis = moonPoint.clone().sub(sunPoint).normalize();
	const side = new Vec(0, 1, 0).cross(axis).normalize();
	const distance = moon.node.orbitRadius * 2.6;
	scene.focusTween = null;
	scene.select(null);
	scene.camera.position
		.copy(moonPoint)
		.add(side.multiplyScalar(distance))
		.add(new Vec(0, distance * 0.32, 0));
	scene.controls.target.copy(moonPoint);
	await sleep(600);
	scene.scene.updateMatrixWorld(true);
	// A covered window gets no animation frames, so nothing would be redrawn and
	// the capture would show a stale frame. Drive the loop by hand instead.
	if (document.hidden) for (let i = 0; i < 4; i++) scene.tick();

	const rect = scene.renderer.domElement.getBoundingClientRect();
	const at = scene.toScreen(moonPoint);
	const planetAt = scene.toScreen(planetPoint);

	// How much of the umbra the moon actually sits inside, for reference: a point
	// light casts an expanding cone, so the shadow is wider than the planet.
	const sunToPlanet = planetPoint.distanceTo(sunPoint);
	const sunToMoon = moonPoint.distanceTo(sunPoint);
	const umbraRadius = (planet.node.bodyRadius * sunToMoon) / sunToPlanet;

	return JSON.stringify({
		shadowQuality: settings.shadowQuality,
		shadowLights: scene.starLights.filter((s) => s.light.castShadow).length,
		moonReceives: moon.mesh.receiveShadow,
		planetCasts: planet.mesh.castShadow,
		moonRadius: +moon.node.bodyRadius.toFixed(2),
		planetRadius: +planet.node.bodyRadius.toFixed(2),
		umbraRadiusAtMoon: +umbraRadius.toFixed(2),
		fullyInShadow: umbraRadius > moon.node.bodyRadius,
		// Device pixels, which is what the screenshot is in.
		devicePixelRatio: window.devicePixelRatio,
		moonPixel: at ? [Math.round(at.x + rect.left), Math.round(at.y + rect.top)] : null,
		planetPixel: planetAt
			? [Math.round(planetAt.x + rect.left), Math.round(planetAt.y + rect.top)]
			: null,
		moonPixelRadius: at
			? Math.round(
					(moon.node.bodyRadius / scene.camera.position.distanceTo(moonPoint)) *
						(rect.height / (2 * Math.tan(((scene.camera.fov * Math.PI) / 180) / 2)))
				)
			: null,
	});
})();
