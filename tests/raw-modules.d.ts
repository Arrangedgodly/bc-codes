// Vite `?raw` imports (used to load CSV fixtures as exact strings in tests).
// The SvelteKit-generated tsconfig does not reference vite/client, so declare
// the module shape here; tests/**/*.ts is included by .svelte-kit/tsconfig.json.
declare module '*?raw' {
	const content: string;
	export default content;
}
