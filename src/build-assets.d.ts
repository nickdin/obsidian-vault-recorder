// Files that `esbuild.config.mjs` writes into `build/` and then imports as text
// or as base64 into the bundles. `tsc` only needs to know their shape.

declare module "*.txt" {
	const text: string;
	export default text;
}

declare module "*.gz" {
	/** The file's bytes, base64-encoded. */
	const base64: string;
	export default base64;
}
