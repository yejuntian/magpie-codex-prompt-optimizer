import { startServer } from "../src/server.js";

const app = await startServer();
const address = app.server.address();
const port = typeof address === "object" && address ? address.port : app.port;
console.log(`Magpie Codex Prompt Optimizer bridge: http://127.0.0.1:${port}`);
