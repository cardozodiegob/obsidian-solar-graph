/**
 * Image imports resolve to data URLs: esbuild is configured with the `dataurl`
 * loader for these extensions, so the bytes end up inside main.js.
 */
declare module "*.jpg" {
	const dataUrl: string;
	export default dataUrl;
}

declare module "*.png" {
	const dataUrl: string;
	export default dataUrl;
}
