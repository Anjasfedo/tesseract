import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Pure client-side SPA: no SSR, no Nitro server. `vite build` emits
// static files (index.html + assets) that can be hosted anywhere.
const config = defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [
		devtools(),
		TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
		tailwindcss(),
		viteReact(),
	],
});

export default config;
