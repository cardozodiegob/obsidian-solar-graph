/**
 * The surface maps, embedded in the bundle at build time.
 *
 * Obsidian's installer downloads only main.js, manifest.json and styles.css from
 * a release — a textures folder next to them would never arrive on a user's
 * machine. So esbuild inlines each map as a data URL (see the `loader` entry in
 * esbuild.config.mjs) and they travel inside main.js.
 *
 * These are the halved copies from textures/dist, built by textures/process.py.
 * Regenerate them with `npm run textures` after changing anything in textures/.
 */
import asteroid1 from "../textures/dist/asteroid-1.jpg";
import asteroid2 from "../textures/dist/asteroid-2.jpg";
import gasCool1 from "../textures/dist/gas-cool-1.jpg";
import gasCool2 from "../textures/dist/gas-cool-2.jpg";
import gasWarm1 from "../textures/dist/gas-warm-1.jpg";
import gasWarm2 from "../textures/dist/gas-warm-2.jpg";
import gasWarm3 from "../textures/dist/gas-warm-3.jpg";
import ice1 from "../textures/dist/ice-1.jpg";
import ice2 from "../textures/dist/ice-2.jpg";
import ice3 from "../textures/dist/ice-3.jpg";
import rings1 from "../textures/dist/rings-1.png";
import rings2 from "../textures/dist/rings-2.png";
import rocky1 from "../textures/dist/rocky-1.jpg";
import rocky2 from "../textures/dist/rocky-2.jpg";
import rocky3 from "../textures/dist/rocky-3.jpg";
import star1 from "../textures/dist/star-1.jpg";
import star2 from "../textures/dist/star-2.jpg";
import star3 from "../textures/dist/star-3.jpg";
import terrestrial1 from "../textures/dist/terrestrial-1.jpg";
import terrestrial2 from "../textures/dist/terrestrial-2.jpg";
import terrestrial3 from "../textures/dist/terrestrial-3.jpg";

/**
 * Variants per body class, keyed the way classify.ts names them. A note picks one
 * by a hash of its path, so siblings don't all wear the same face.
 */
export const TEXTURE_SOURCES: Record<string, string[]> = {
	star: [star1, star2, star3],
	"gas-warm": [gasWarm1, gasWarm2, gasWarm3],
	"gas-cool": [gasCool1, gasCool2],
	terrestrial: [terrestrial1, terrestrial2, terrestrial3],
	rocky: [rocky1, rocky2, rocky3],
	ice: [ice1, ice2, ice3],
	asteroid: [asteroid1, asteroid2],
	rings: [rings1, rings2],
};
