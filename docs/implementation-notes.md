# Implementation notes

Background on the parts that were not obvious to get right. None of this is needed
to use the plugin — see the [README](../README.md) for that.

## Turning a vault into orbits

A link graph has cycles and notes with several parents. Orbits can't: a body has
exactly one thing it goes around. So link mode builds a **spanning tree** — a
breadth-first walk out from a root note, where each note's parent is whichever note
reached it first. Every link the tree can't express is drawn as a faint chord
instead, so nothing is silently hidden.

Folder mode gets the tree for free, and every link becomes a chord.

## Nesting, rather than positioning

Each body is a chain of three objects: a tilt group holding its orbital plane, a
pivot that rotates over time, and an anchor sitting at the orbital radius. A
child's chain is parented to its parent's anchor.

The whole system therefore animates by setting **one angle per body**. A planet
swinging around its star carries its moons along automatically, because they hang
off its transform. There is no per-frame position maths.

Orbital speed follows Kepler's third law (`ω ∝ r^-1.5`), so inner moons whip round
while outer systems drift.

## Why bodies never collide

Sibling subsystems are packed into **disjoint annuli**. Each note knows the radius
of its *entire* subsystem, computed bottom-up, and siblings are given ring radii far
enough apart that those subsystem spheres cannot intersect — at any phase, at any
tilt. It's a guarantee from the packing, not a collision test.

Two details that cost real debugging:

- **Co-orbital bodies must be coplanar.** A note with many children puts several on
  one shared ring rather than sprawling outward. Giving each of them its own random
  tilt looked better but broke everything: two circles of equal radius in different
  planes intersect at two points, so bodies periodically passed through each other.
  Bodies sharing a ring now share its plane.
- **Angular spacing needs the chord, not the arc.** For `k` bodies spaced evenly on
  a ring, neighbours are `2r·sin(π/k)` apart. Approximating that with arc length
  under-shoots, and crowded rings touch.

Belt debris is scattered vertically off its ring, which is what makes a belt read as
a belt. That displacement counts towards the room each rock claims, because lifting
a body off its ring changes its distance from the star and would otherwise eat into
the clearance between neighbouring orbits.

`test/smoke.ts` asserts all of it, including a brute-force check that no two bodies
intersect at several sampled moments in simulated time.

## Framing the camera

Fitting the system on screen went through three attempts. A bounding **cylinder** is
a correct bound but wastes half the screen on corners no body can reach. A flattened
**sphere** is tighter but unsound — a tilted circle doesn't fit inside one. The
working version fits the **orbit rings themselves**, sampled in world space, which is
both tight and exactly the geometry a user sees.

The distance is found by bisection on "does everything fit", which is monotonic.
Scaling the distance by how far out of frame things are — the obvious approach —
oscillates, and worse: a point *behind* the camera divides by a negative `w` and
lands back inside the frame, so overshooting looks like a perfect fit from inside
the system. Rejecting anything behind the near plane is what makes it reliable.

## Lighting, shadows and eclipses

Each star's light is **local**: it falls off with distance and stops beyond its own
system's reach.

**Nothing self-illuminates.** Giving every body a faint emissive copy of its own
surface map makes night sides readable, but a body that glows on its own cannot be
eclipsed — the shadow lands and the surface lights itself back up. Measured on a
forced alignment (a moon parked exactly on the line from the star through its
planet), self-illumination contributed about 70 brightness units out of 107 while
the star's direct light contributed 29. The shadow was working perfectly and
removing a quarter of the light, which is invisible. Without the emissive map the
same eclipse takes the moon from 170 down to 34.

The corollary is that ambient light is the only fill, which is why **Shadow depth**
is the setting that decides whether eclipses read at all.

**Two stars lighting one body** leaves a dark seam where the two pools of light
meet. Distance falloff can't fix it, because each star's intensity is scaled to the
size of its own system: a large distant star and a small nearby one arrive at
similar strength — measured at 6.8 against 5.5 on a moon inside a nested star's
system. `Light.layers` in three.js doesn't help either; it filters lights against
the *camera*, not per object, so a light cannot be restricted to one subsystem
(confirmed by putting a light on a layer no object uses and watching the scene stay
lit). **Nearest star dominates** therefore picks a winner each frame and fades the
others to 12%, crossfading so moving between systems doesn't switch the lighting
with a jump. That takes the same measurement to 10.

`test/eclipse.js` sets up the forced alignment and reports the pixel to measure, so
"do eclipses work" is a measurement rather than an opinion.

## Light shafts

The shafts are a screen-space approximation, not a raymarch through a fog volume.
The star is rendered alone into a half-resolution buffer, everything solid is painted
over it in black, and that buffer is smeared radially away from the light. The black
occluders are what carve shadows out of the rays. No shadow-map lookups, no depth
integration, one extra render — and it reads as light travelling through haze.

Three things it needs to not fall apart:

- Samples that walk off the buffer read the clamped edge pixel repeatedly, painting a
  hard streak in from the border. They're dropped instead.
- The accumulation is bounded, and the effect fades out before the light reaches the
  frame edge. Anchored on an off-screen light, every pixel samples in nearly the same
  direction and the frame floods white.
- Only one star is drawn into the buffer per frame. Any other star left in it gets
  stretched along the axis between the two and appears as a cone beaming out of it.

On "caustics": genuine caustics are light focused by refraction through water or
glass, and there's nothing here to refract through. What this does instead is light
*scattering* — shafts, haze and bloom.

## Surfaces

The 21 maps in `textures/` were generated with Stability AI models, then cropped and
resized by `textures/process.py`. They're embedded in `main.js` as data URLs at build
time, because Obsidian's installer only downloads `main.js`, `manifest.json` and
`styles.css` from a release — a textures folder alongside them would never reach a
user's machine. Halving them keeps the bundle near 1.2 MB.

Two things about a sphere map: it wants an **equirectangular** 2:1 layout, where the
top and bottom rows are the poles, and any black row at the edge of a plate becomes
a black smear at the pole, so borders are cropped away. The ring maps are different
— they're read radially, so they're generated as vertical stripes, averaged down the
rows into a clean profile, and their brightness becomes transparency so the gaps
between bands are real gaps.

Two prompting lessons, both written into `textures/generate.sh`:

- Anything mentioning continents, oceans or "a planet map" returns **literal Earth**,
  however it's phrased and whatever the negative prompt says. Asking for "terrain seen
  from directly overhead" instead reliably gives a surface.
- A blue-white *star* returns a nebula every time. `star-2` is therefore derived from
  `star-1` by remapping luminance through a hot-blue ramp, which keeps the granulation
  and changes only the colour.

The star's halo has a hole cut in it matching the body. A plain centre-bright gradient
puts its brightest pixels over the surface, which reads as a second light source
pasted on the disc with a seam where it ends. The disc is also held below full white,
or the whole surface passes the bloom threshold and the granulation disappears into a
flat blob.

## Settings, rendered two ways

Obsidian 1.13 added a declarative settings API: a tab returns `getSettingDefinitions()`
and Obsidian renders the controls itself, which is also what puts them in the settings
search index. Older versions know only `display()`, where the tab builds the controls
by hand.

No version check is needed to support both, and this is worth knowing because it looks
like it would be: `display()` is documented as *not called when `getSettingDefinitions`
returns a non-empty array*. Obsidian picks. Implementing both is the whole compatibility
story, and `minAppVersion` can stay where it is, because defining the method isn't
calling a newer API.

What does need care is that both paths describe the same 31 settings. They're generated
from one table (`SETTING_GROUPS`), so they can't drift: the declarative path maps it to
Obsidian's shape, and `display()` walks it building `Setting` objects.

The other integration point is writes. Obsidian's default `setControlValue` writes to
`plugin.settings` and persists, which isn't enough here: an open view has to react, and
how much work a change implies varies from a repaint to a re-layout to re-reading the
vault. So `setControlValue` is overridden to route through the plugin's own
`saveSettings(key)`, exactly as the imperative path does.

## Verifying rendering in a running Obsidian

`npm test` covers the tree building and the layout maths, but not rendering. For that,
start Obsidian with a debug port and drive it over the Chrome DevTools Protocol:

```bash
# close Obsidian first (Windows path shown)
"$LOCALAPPDATA/Programs/obsidian/Obsidian.exe" --remote-debugging-port=9222 \
  "obsidian://open?vault=<url-encoded vault name>"

node test/inspect.mjs "window.app.plugins.plugins['solar-graph'] != null"
node test/inspect.mjs test/interaction.js shot.png   # hover, click, folder switch
node test/inspect.mjs test/verify.js shot.png        # re-centring, flat mode, keys
node test/inspect.mjs test/demo-graph.js shot.png    # every body type at once
node test/inspect.mjs test/closeup.js shot.png       # park the camera on one body
node test/inspect.mjs test/eclipse.js shot.png       # forced eclipse, with coordinates
```

`inspect.mjs` takes an expression or a `.js` file, prints the result plus anything the
page logged, and can save a screenshot. Reload the plugin after a rebuild with
`node test/inspect.mjs "window.app.commands.executeCommandById('app:reload')"`.

`demo-graph.js` is the useful one for visuals: a vault with no unlinked notes and
nothing with five children shows none of the giants, rings or the belt, so rather than
writing throwaway notes it swaps the metadata cache for a synthetic vault in memory
and leaves the disk untouched. Reload to restore.

Because TypeScript's `private` is compile-time only and esbuild doesn't rename
properties, these scripts can reach into `leaf.view.scene` to read camera state or
project a body to screen coordinates.

Things that will waste your time otherwise:

- A **hidden or covered** window gets no animation frames at all, so anything measuring
  frame rate reads zero and screen positions divide by a zero-sized canvas. Screenshots
  are captured with `fromSurface: false` and the scripts call `scene.tick()` by hand when
  `document.hidden` — without both, every capture is a stale frame and repeated
  measurements come back suspiciously identical.
- Synthetic `PointerEvent`s make OrbitControls throw on `setPointerCapture`, because no
  real pointer has that id. Harmless.
- `Log.enable` replays the page's existing log buffer, so a stale error can look new.
  Check the line numbers.
- Shader errors appear in the page log rather than breaking the build. Worth checking
  after touching the shaft pass. GLSL has no reserved-word protection either: naming a
  variable `step` silently shadows the built-in `step()`.
