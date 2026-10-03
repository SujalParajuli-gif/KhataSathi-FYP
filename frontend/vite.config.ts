import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, transformWithEsbuild, type Plugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const developmentSupport: Plugin = {
  name: "khatasathi-development-support",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        request.url?.split("?", 1)[0] ===
          "/.well-known/appspecific/com.chrome.devtools.json"
      ) {
        response.statusCode = 204;
        response.setHeader("Cache-Control", "no-store");
        response.end();
        return;
      }
      next();
    });
  },
  async transform(code, id) {
    const file = id.split("?", 1)[0].replace(/\\/g, "/");
    if (
      !/\/app\/(routes\/_app\.products|components\/blocks\/products\/ProductsModals)\.tsx$/.test(file)
    ) {
      return;
    }
    // Compact generated JSX before React Refresh reaches Babel's size limit.
    return transformWithEsbuild(code, file, {
      loader: "js",
      minifyWhitespace: true,
      sourcemap: true,
    });
  },
};

export default defineConfig({
  plugins: [
    tailwindcss(),
    // Route export processing expands JSX again; compact just before refresh.
    ...reactRouter().flatMap((plugin) =>
      plugin.name === "react-router:react-refresh-babel"
        ? [developmentSupport, plugin]
        : [plugin],
    ),
    tsconfigPaths(),
  ],
});
