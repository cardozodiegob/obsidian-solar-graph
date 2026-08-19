// Exercised in the running app via test/inspect.mjs. Drives the view the way a
// user would — pointer over a body, click it, flip to folder mode — and reports
// what happened. Kept as a file so the expression stays readable.
(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const leaf = window.app.workspace.getLeavesOfType("solar-graph-view")[0];
	if (!leaf) return "no solar graph view open";
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


	await settle();

	// Freeze the orbits so a body stays under the cursor between events.
	view.paused = true;
	scene.setSettings(view.effectiveSettings());
	await sleep(200);

	const screenOf = (id) => {
		const body = scene.bodies.get(id);
		if (!body) return null;
		const world = body.anchor.getWorldPosition(body.anchor.position.clone());
		const point = scene.toScreen(world);
		if (!point) return null;
		const rect = canvas.getBoundingClientRect();
		return { clientX: rect.left + point.x, clientY: rect.top + point.y };
	};

	const target = "Tools MOC.md";
	const at = screenOf(target);
	report.targetOnScreen = !!at;
	if (!at) return JSON.stringify(report);

	const fire = (type, extra = {}) =>
		canvas.dispatchEvent(
			new PointerEvent(type, {
				clientX: at.clientX,
				clientY: at.clientY,
				bubbles: true,
				cancelable: true,
				...extra,
			})
		);

	// --- hover -------------------------------------------------------------
	// Tick straight away rather than sleeping first: hover is consumed on the next
	// frame after the move, and a sleep gives the camera and orbits a chance to
	// drift out from under the cursor.
	fire("pointermove");
	if (document.hidden) for (let i = 0; i < 6; i++) scene.tick();
	else await sleep(400);
	report.hoverTooltip = document.querySelector(".solar-graph-tooltip.is-visible")
		? document.querySelector(".solar-graph-tooltip-title").innerText +
			" | " +
			document.querySelector(".solar-graph-tooltip-meta").innerText
		: null;
	report.hoverCursorClass = canvas.classList.contains("is-hovering");

	// --- click opens the note ---------------------------------------------
	const before = window.app.workspace.getActiveFile()?.path ?? null;
	fire("pointerdown");
	await sleep(60);
	fire("pointerup");
	await pump(700);
	report.activeFileBefore = before;
	report.activeFileAfter = window.app.workspace.getActiveFile()?.path ?? null;
	report.selected = scene.selectedNode?.id ?? null;

	// --- a drag must NOT be treated as a click ---------------------------
	const dragFrom = screenOf("Ideas MOC.md");
	if (dragFrom) {
		const opened = window.app.workspace.getActiveFile()?.path ?? null;
		canvas.dispatchEvent(
			new PointerEvent("pointerdown", { ...dragFrom, bubbles: true, cancelable: true })
		);
		canvas.dispatchEvent(
			new PointerEvent("pointerup", {
				clientX: dragFrom.clientX + 40,
				clientY: dragFrom.clientY + 25,
				bubbles: true,
				cancelable: true,
			})
		);
		await pump(400);
		report.dragDidNotOpen =
			(window.app.workspace.getActiveFile()?.path ?? null) === opened;
	}

	// --- folder mode ------------------------------------------------------
	const folderButton = [...document.querySelectorAll(".solar-graph-segmented button")].find(
		(b) => b.innerText.trim() === "Folders"
	);
	folderButton.click();
	await pump(1200);
	report.folderStatus = document.querySelector(".solar-graph-status")?.innerText;
	report.folderBodies = scene.bodies.size;
	report.folderStarLabel = scene.bodies.get("folder:/")?.node.label ?? null;

	return JSON.stringify(report, null, 1);
})();
