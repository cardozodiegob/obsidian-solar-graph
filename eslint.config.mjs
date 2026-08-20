// Mirrors the checks the Obsidian plugin directory runs on submission, so problems
// show up here rather than in a review. `npm run lint`.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
	{
		// Build output, dependencies, and the DevTools-protocol harness, which is
		// plain node scripts rather than plugin code.
		ignores: ["main.js", "node_modules/**", "test/build/**", "test/*.js", "test/*.mjs"],
	},
	js.configs.recommended,
	// Type-aware rules: this is what surfaces the unsafe-any family.
	...tseslint.configs.recommendedTypeChecked,
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		// Build and lint configs are plain ESM outside the TypeScript project, so the
		// type-aware rules have nothing to work from.
		files: ["**/*.mjs"],
		extends: [tseslint.configs.disableTypeChecked],
	},
	{
		// test/ is a node harness whose whole job is printing to the console, and it
		// never ships, so Obsidian's plugin rules don't apply to it. Note this can't
		// be done by re-scoping the recommended config: it also carries a JSON parser
		// for package.json, which would then be applied to TypeScript.
		files: ["test/**/*.ts"],
		rules: Object.fromEntries(
			Object.keys(obsidianmd.rules ?? {}).map((rule) => [`obsidianmd/${rule}`, "off"])
		),
	}
);
