// Final pass in the running app: link mode, alt-click re-rooting, settings that
// force a re-layout, keyboard shortcuts, and a frame-rate sample.
//
// Note: synthetic PointerEvents make OrbitControls throw on setPointerCapture,
// because no real pointer with that id exists. That's an artifact of driving the
// canvas from script and doesn't happen with real input.
(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const leaf = window.app.workspace.getLeavesOfType("solar-graph-view")[0];
	const view = leaf.view;
	const scene = view.scene;
	const canvas = document.querySelector(".solar-graph-canvas");
	const report = {};

	// A covered window gets no animation frames, so hover picking, labels and the
	// camera would never update and every reading would be stale. Drive the loop by
	// hand when that's the case.
	const pump = async (ms = 300) => {
		await sleep(ms);
		if (document.hidden) for (let i = 0; i < 5; i++) scene.tick();
	};

	// The camera may still be flying to its framing position. Pumping frames would
	// then move it between working out where a body is on screen and clicking there,
	// so let the tween finish first.
	const settle = async () => {
		for (let i = 0; i < 80; i++) {
			if (!scene.focusTween) break;
			if (document.hidden) scene.tick();
			else await sleep(25);
		}
		if (document.hidden) for (let i = 0; i < 3; i++) scene.tick();
	};


	const screenOf = (id) => {
		const body = scene.bodies.get(id);
		if (!body) return null;
		const world = body.anchor.getWorldPosition(body.anchor.position.clone());
		const point = scene.toScreen(world);
		if (!point) return null;
		const rect = canvas.getBoundingClientRect();
		return { clientX: rect.left + point.x, clientY: rect.top + point.y };
	};

	await settle();

	// Back to link mode.
	[...document.querySelectorAll(".solar-graph-segmented button")]
		.find((b) => b.innerText.trim() === "Links")
		.click();
	await sleep(1200);
	report.linkStatus = document.querySelector(".solar-graph-status")?.innerText;

	// Frame rate over one second of real animation. Only meaningful with the window
	// actually on screen: a hidden or covered one is given no frames at all.
	view.paused = false;
	scene.setSettings(view.effectiveSettings());
	const before = scene.frame;
	await sleep(1000);
	report.fps = document.hidden ? "not measured — window hidden" : scene.frame - before;

	// Alt-click re-roots the system on that note. The target has to be one that is
	// actually clickable from here: at some phases a body sits behind the star, and
	// the ray then hits the star instead — correct behaviour, useless as a fixture.
	view.paused = true;
	scene.setSettings(view.effectiveSettings());
	await settle();
	const pickable = () => {
		for (const id of scene.bodies.keys()) {
			const body = scene.bodies.get(id);
			if (body.node.parent === null || body.style.kind === "ghost") continue;
			const spot = screenOf(id);
			if (!spot) continue;
			canvas.dispatchEvent(new PointerEvent("pointermove", { ...spot, bubbles: true }));
			if (scene.pick()?.node.id === id) return { id, spot };
		}
		return null;
	};
	const target = pickable();
	report.altClickTarget = target?.id ?? null;
	if (target) {
		const { spot } = target;
		canvas.dispatchEvent(new PointerEvent("pointerdown", { ...spot, bubbles: true }));
		await sleep(50);
		canvas.dispatchEvent(
			new PointerEvent("pointerup", { ...spot, altKey: true, bubbles: true })
		);
		await pump(1200);
		report.rerootedStatus = document.querySelector(".solar-graph-status")?.innerText;
		report.rerootedOnTarget = scene.bodies.get(target.id)?.node.parent === null;
	}

	// Synthetic pointer events are unreliable while the window is covered — the
	// press/release pair can be dropped, and the click is then rejected as a drag.
	// Exercise the handler directly as well, so this reports something either way.
	if (!report.rerootedOnTarget) {
		const node = scene.bodies.get("Home.md")?.node;
		if (node) {
			view.handleSelect(node, { altKey: true });
			await pump(1200);
			report.rerootViaHandler = scene.bodies.get("Home.md")?.node.parent === null;
			report.rerootedStatus = document.querySelector(".solar-graph-status")?.innerText;
		}
	}
	// Put the root back so the rest of the run starts from the default.
	view.rootOverride = null;
	view.rebuild();
	await pump(900);

	// A flat system: inclination 0 must not break packing or framing.
	view.plugin.settings.inclinationSpread = 0;
	await view.plugin.saveSettings("inclinationSpread");
	await pump(900);
	report.flatVerticalExtent = +scene.verticalExtent.toFixed(2);

	// The promise is "frame everything puts everything in view", so test that:
	// freeze the orbits, deselect (a selected body keeps the camera locked to it),
	// reframe, and let the tween land before measuring.
	view.paused = true;
	scene.setSettings(view.effectiveSettings());
	scene.select(null);
	scene.resetCamera();
	await pump(1400);

	const slack = 0.02;
	report.flatBodiesFramed = [...scene.bodies.keys()].filter((id) => {
		const s = screenOf(id);
		if (!s) return false;
		const rect = canvas.getBoundingClientRect();
		const padX = rect.width * slack;
		const padY = rect.height * slack;
		return (
			s.clientX >= rect.left - padX &&
			s.clientX <= rect.right + padX &&
			s.clientY >= rect.top - padY &&
			s.clientY <= rect.bottom + padY
		);
	}).length;
	report.flatTotalBodies = scene.bodies.size;

	// Restore the tilt and confirm the reset key reframes.
	view.plugin.settings.inclinationSpread = 16;
	await view.plugin.saveSettings("inclinationSpread");
	await sleep(900);

	const stage = document.querySelector(".solar-graph-stage");
	stage.focus();
	stage.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	await pump(120);
	report.escapeCleared = scene.selectedNode === null;
	stage.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
	await sleep(100);
	report.resetStartedTween = !!scene.focusTween;
	stage.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
	await sleep(100);
	report.spaceToggledPause = view.paused;

	// Leave it running, in link mode, unpaused.
	view.paused = false;
	scene.setSettings(view.effectiveSettings());
	await pump(1500);
	report.finalStatus = document.querySelector(".solar-graph-status")?.innerText;
	report.finalLabels = document.querySelectorAll(".solar-graph-label").length;

	return JSON.stringify(report, null, 1);
})();
