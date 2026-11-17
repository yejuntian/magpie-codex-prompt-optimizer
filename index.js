import { startServer, stopServer } from "./src/server.js";
import { persistCodexLaunchEnvironment } from "./src/launcher.js";

let servicePromise = null;
let service = null;

export const PageService = async (_input, options = {}) => {
  if (!servicePromise) {
    servicePromise = startServer({
      host: "127.0.0.1",
      port: Number(options.servicePort) || undefined,
    }).then(async (app) => {
      service = app;
      try {
        await persistCodexLaunchEnvironment(app.settings.cdpEndpoint);
        return app;
      } catch (error) {
        await stopServer(app);
        service = null;
        throw error;
      }
    }).catch((error) => {
      servicePromise = null;
      throw error;
    });
  }
  await servicePromise;
  return {
    async dispose() {
      if (!service) return;
      await stopServer(service);
      service = null;
      servicePromise = null;
    },
  };
};
