import { loadSettings, mergeSettings } from "../src/config.js";
import { PromptOptimizerController } from "../src/controller.js";

const endpoint = process.env.CPO_CDP_ENDPOINT || "http://127.0.0.1:9333";
const settings = mergeSettings(await loadSettings(), { cdpEndpoint: endpoint });
const controller = new PromptOptimizerController(settings);
try {
  const status = await controller.attach(endpoint);
  console.log(JSON.stringify(status, null, 2));
} finally {
  controller.detach();
}
