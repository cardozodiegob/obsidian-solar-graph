// Parks the camera close to one body so a screenshot can show surface detail,
// rings and shadows. Set the target and zoom by editing TARGET / ZOOM below, or
// via window.__solarCloseup = { id, zoom } before running.
//
//   node test/inspect.mjs test/closeup.js shot.png
(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const options = window.__solarCloseup ?? {};
	const id = options.id ?? "Beta.md";
	const zoom = options.zoom ?? 5;

	const leaf = window.app.workspace.getLeavesOfType("solar-graph-view")[0];
	if (!leaf) return "no solar graph view open";
	const view = leaf.view;
	const scene = view.scene;
	const body = scene.bodies.get(id);
	if (!body) return `no body ${id} (have ${[...scene.bodies.keys()].slice(0, 8).join(", ")}…)`;

	// Freeze so the body doesn't drift out of frame between here and the capture.
	view.paused = true;
	scene.setSettings(view.effectiveSettings());
	scene.select(null);
	await sleep(120);

	const Vec = body.anchor.position.constructor;
	const point = body.anchor.getWorldPosition(new Vec());
	// Off to one side and slightly above, so the lit limb and the terminator are
	// both visible rather than looking straight down the light's axis.
	const offset = new Vec(0.55, 0.35, 1).normalize().multiplyScalar(body.node.bodyRadius * zoom);
	scene.focusTween = null;
	scene.camera.position.copy(point).add(offset);
	scene.controls.target.copy(point);
	await sleep(700);
	// A covered window gets no animation frames, so nothing would be redrawn and
	// the capture would show a stale frame. Drive the loop by hand instead.
	if (document.hidden) for (let i = 0; i < 4; i++) scene.tick();

	return JSON.stringify({
		id,
		kind: body.style.kind,
		rings: !!body.rings,
		castsShadow: body.mesh.castShadow,
		receivesShadow: body.mesh.receiveShadow,
		bodyRadius: +body.node.bodyRadius.toFixed(2),
		cameraDistance: +scene.camera.position.distanceTo(point).toFixed(1),
		shadowLights: scene.starLights.filter((s) => s.light.castShadow).length,
	});
})();
