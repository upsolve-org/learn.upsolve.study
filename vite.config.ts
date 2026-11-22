import { defineConfig } from "vite-plus";

export default defineConfig({
	fmt: {
		useTabs: true,
		ignorePatterns: [
			".next/**",
			"node_modules/**",
			"data/**",
			"dist/**",
			"core-plugins/**",
			"plugins/*/dist/**",
			"plugins/*/.sdk/**",
			"public/plugin-authoring/**",
			"next-env.d.ts",
			"package-lock.json",
			"plugins/*/package-lock.json",
		],
	},
	lint: {
		ignorePatterns: [
			".next/**",
			"node_modules/**",
			"data/**",
			"dist/**",
			"core-plugins/**",
			"plugins/**",
			"public/plugin-authoring/**",
			"next-env.d.ts",
			"scripts/**",
			"tests/**",
		],
		options: { typeAware: false },
	},
});
