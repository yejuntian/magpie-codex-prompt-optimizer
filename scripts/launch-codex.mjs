import { launchCodexWithCdp } from "../src/launcher.js";

const endpoint = process.env.CPO_CDP_ENDPOINT || "http://127.0.0.1:9333";
const result = await launchCodexWithCdp(endpoint);
console.log(JSON.stringify(result, null, 2));
