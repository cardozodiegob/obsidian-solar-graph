#!/usr/bin/env bash
# Regenerates the raw texture plates with Stability AI on Bedrock.
# Run from this directory:  bash generate.sh
# Then normalise them into the shipped maps:  python process.py
#
# Each body class has several variants, picked per note by a hash of its path, so
# a vault full of ice moons doesn't look like a vault full of one ice moon. Files
# are named <class>-<n>.png and already-generated ones are skipped, so this is
# safe to re-run and cheap to extend: add a gen line and run it again.
set -u

# Path to a local helper that can call Stability AI on Amazon Bedrock. This is
# only needed to *regenerate* the maps — the ones in this repo are already built,
# and nothing here runs as part of the plugin build.
SKILL="${BEDROCK_IMAGE_SKILL:-$HOME/.claude/skills/bedrock-image}"
if [ ! -f "$SKILL/scripts/bedrock_image.py" ]; then
	echo "No image generator at $SKILL — set BEDROCK_IMAGE_SKILL to your own." >&2
	echo "Any text-to-image tool works; the prompts below are the useful part." >&2
	exit 1
fi
OUT="$(cd "$(dirname "$0")" && pwd)/raw"
mkdir -p "$OUT"
# Python is a Windows binary: it can't open Git Bash's /c/... paths, and the
# shell only rewrites those for some arguments. Hand it a real Windows path.
OUT_WIN="$(cygpath -m "$OUT")"

# Surfaces are lit by the scene, so the plates must be flat albedo: no baked
# shadows, no terminator, no vignette, and no planet silhouette.
FLAT="flat even illumination, no shadows, no terminator, no vignette, fills the entire frame edge to edge"
NEG="planet sphere, circle, globe, black background, black bars, letterbox, stars, outer space, shadow, dark edges, vignette, text, watermark, border"
# The generators love to draw a *photo of a planet* — a curved limb, an oval
# projection, black corners — all of which wrap onto a sphere badly.
FLATMAP="drawn as a flat rectangular cylindrical map projection filling the entire frame edge to edge, uniform detail across the whole rectangle, $FLAT"
NEG_MAP="$NEG, globe, planet limb, horizon, curvature, oval, ellipse, black corners, photo of a planet from space"
NEG_GROUND="$NEG_MAP, landscape photograph, ground level, horizon, sky, perspective, vanishing point, rocks in foreground"

gen() {
	local name="$1" ratio="$2" prompt="$3" neg="$4"
	if [ -f "$OUT/$name.png" ]; then
		echo "skip $name"
		return
	fi
	echo "=== $name"
	python "$SKILL/scripts/bedrock_image.py" generate "$prompt" \
		--negative-prompt "$neg" -o "$OUT_WIN/$name.png" -m ultra --aspect-ratio "$ratio" 2>&1 | tail -2
}

# --- stars ------------------------------------------------------------------
# Naming a spacecraft and a real body is what produces a genuine surface map;
# the letterboxing that comes with it is cropped by process.py.
gen star-1 21:9 \
	"seamless tileable texture of a star photosphere, granulation convection cells, bright molten orange and yellow plasma, darker sunspot patches, filament detail, extreme closeup of the sun surface, $FLAT" \
	"$NEG"
# "red giant" gets a whole sun with black corners, so star-3 keeps star-1's exact
# framing and changes only the colour words.
NEG_STAR="$NEG, starfield, night sky, nebula, galaxy, lens flare, whole sun, solar disc, circle, sphere, corona ring, silhouette"
#
# star-2 is deliberately NOT generated. Four attempts at a blue-white photosphere
# all came back as a starburst in a nebula — "hot blue-white star", "blazing white
# and pale cyan plasma", "molten metal macro", every negative prompt going. The
# model has an unshakeable attractor there. process.py derives star-2 from star-1
# instead, remapping luminance through a hot-blue ramp: same granulation, new
# colour. Don't re-add a gen line for it without checking the result.
gen star-3 21:9 \
	"seamless tileable texture of a star photosphere, granulation convection cells, deep crimson and burnt orange plasma, large dark spot regions, glowing filaments, extreme closeup of the sun surface, $FLAT" \
	"$NEG_STAR"

# --- gas giants -------------------------------------------------------------
gen gas-warm-1 21:9 \
	"seamless tileable equirectangular texture map of a Jupiter-like gas giant atmosphere, horizontal cloud bands, ochre cream rust and pale gold stripes, turbulent swirls and oval storm vortices, high detail NASA spacecraft imagery, $FLAT" \
	"$NEG"
gen gas-warm-2 21:9 \
	"seamless tileable equirectangular texture map of a stormy brown gas giant atmosphere, dense horizontal bands of chocolate umber and tan, many small white storm ovals, heavy turbulence and shear, high detail NASA Juno spacecraft imagery, $FLAT" \
	"$NEG"
gen gas-warm-3 21:9 \
	"seamless tileable equirectangular texture map of a Saturn-like pale gas giant atmosphere, soft horizontal bands of butter yellow cream and light amber, gentle low contrast striping, faint polar hexagon, high detail Cassini spacecraft imagery, $FLAT" \
	"$NEG"

# --- ice giants -------------------------------------------------------------
gen gas-cool-1 21:9 \
	"seamless tileable equirectangular texture map of a Neptune-like ice giant atmosphere, parallel horizontal cloud bands in deep azure teal and pale blue, thin white cirrus streaks stretched along the bands, one dark storm oval, high detail NASA Voyager spacecraft imagery, $FLAT" \
	"$NEG"
gen gas-cool-2 21:9 \
	"seamless tileable equirectangular texture map of a violet ice giant atmosphere, horizontal bands of indigo lavender and pale periwinkle, wispy white methane clouds stretched along the bands, high detail spacecraft imagery, $FLAT" \
	"$NEG"

# --- terrestrial worlds -----------------------------------------------------
# Anything mentioning continents returns literal Earth, however it is phrased, so
# these are deliberately non-Earth: Martian, volcanic, and arid.
gen terrestrial-1 21:9 \
	"seamless equirectangular map of a Mars-like desert planet, rust orange and ochre plains, vast branching canyon systems, dark basalt patches, dusty craters, faint wisps of dust storm, high detail orbital imagery, $FLATMAP" \
	"$NEG_MAP, Earth, oceans, blue water, green vegetation, continents, coastlines"
# Say "terrain seen from overhead", never "planet", "world" or "map" — those pull
# the model straight to a picture of Earth no matter what the negatives say.
NEG_TERRAIN="$NEG_GROUND, Earth, world map, continents, coastlines, oceans, blue water, green vegetation, country borders"
gen terrestrial-2 21:9 \
	"seamless texture of black volcanic basalt terrain seen from directly overhead, cracked crust threaded with a branching network of glowing orange lava fissures, ash grey cones, sulphur yellow mineral crusts, orthographic top-down aerial photograph, uniform across the whole frame, $FLAT" \
	"$NEG_TERRAIN"
gen terrestrial-3 21:9 \
	"seamless texture of arid desert terrain seen from directly overhead, pale tan and khaki sand with long parallel dune ridges, scattered dark rocky outcrops, shallow wide basins, orthographic top-down aerial photograph, uniform across the whole frame, $FLAT" \
	"$NEG_TERRAIN"

# --- rocky worlds -----------------------------------------------------------
gen rocky-1 21:9 \
	"seamless equirectangular map of a cratered airless moon seen from directly overhead, uniform grey regolith with hundreds of overlapping impact craters of varied sizes evenly covering the entire frame, bright ejecta rays, orthographic top-down orbital photograph, $FLATMAP" \
	"$NEG_GROUND, oceans, vegetation"
gen rocky-2 21:9 \
	"seamless equirectangular map of a dark basalt airless world seen from directly overhead, charcoal and slate grey plains, dense small craters, long straight fracture rilles, patches of bright fresh ejecta, orthographic top-down orbital photograph, $FLATMAP" \
	"$NEG_GROUND, oceans, vegetation"
gen rocky-3 21:9 \
	"seamless texture of rusty grey cratered regolith seen from directly overhead, iron oxide stained dust in warm grey and brick tones, dense overlapping impact craters of many sizes, bright rayed ejecta, orthographic top-down aerial photograph, uniform across the whole frame, $FLAT" \
	"$NEG_TERRAIN"

# --- icy worlds -------------------------------------------------------------
gen ice-1 21:9 \
	"seamless equirectangular map of a frozen moon surface, unbroken pale blue-white ice sheet covered edge to edge in a dense network of long dark linear fractures and ridges, rust-brown mineral staining along the cracks, $FLATMAP" \
	"$NEG_GROUND, Earth, continents, oceans, coastlines, landmasses, world map"
gen ice-2 21:9 \
	"seamless equirectangular map of a smooth glacial moon surface, bright white and pale cyan ice plains, long parallel pressure ridges and grooved terrain, a few small fresh impact craters with bright rays, $FLATMAP" \
	"$NEG_GROUND, Earth, continents, oceans, coastlines, rocks, dirt"
gen ice-3 21:9 \
	"seamless texture of dirty ice terrain seen from directly overhead, grey-blue ice mottled with dark carbon dust and ochre tholin staining, chaotic broken blocks, deep fractures, orthographic top-down aerial photograph, uniform across the whole frame with no seams or bands, $FLAT" \
	"$NEG_TERRAIN, split image, two halves, horizontal seam, collage"

# --- asteroids --------------------------------------------------------------
gen asteroid-1 21:9 \
	"seamless tileable texture of dark carbonaceous asteroid rock, charcoal grey pitted surface, dense small craters, fine dust and gravel, rough regolith closeup, $FLAT" \
	"$NEG"
gen asteroid-2 21:9 \
	"seamless tileable texture of pale metallic asteroid rock, light grey nickel-iron surface with angular fractured facets, shallow pits, scattered fine rubble and dust, rough regolith closeup, $FLAT" \
	"$NEG"

# --- rings ------------------------------------------------------------------
# Not sphere maps: these are read radially, so the bands must be vertical stripes
# that can be averaged down the rows into a clean radial profile.
gen rings-1 21:9 \
	"a flat graphic cross-section of Saturn's ring system as vertical stripes, alternating bands of bright cream white and pale beige ice separated by narrow dark gaps, fine dense radial banding, straight vertical edges, uniform from top to bottom, pure black at the far left and far right ends" \
	"planet, sphere, curve, ellipse, perspective, horizontal bands, diagonal, stars, text, watermark"
gen rings-2 21:9 \
	"a flat graphic cross-section of a wide dusty planetary ring system as vertical stripes, warm tan and grey ice bands of varying width, one broad dark division gap in the middle, sparse faint outer band, straight vertical edges, uniform from top to bottom, pure black at the far left and far right ends" \
	"planet, sphere, curve, ellipse, perspective, horizontal bands, diagonal, stars, text, watermark"

echo "=== done"
ls "$OUT"
