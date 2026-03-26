import { createServer } from "vite";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const server = await createServer({
  configFile: resolve(__dirname, "vite.config.ts"),
  root: __dirname,
  server: { port: 5173, host: true },
});

await server.listen();
server.printUrls();
