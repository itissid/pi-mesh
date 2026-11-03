// Fail closed until the operator supplies the IP actually assigned to tailscale0.
// Neither the token nor message contents are printed by this entrypoint.
import { readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";

const fail = (reason) => {
  console.error(`pi-mesh broker: ${reason}`);
  process.exit(1);
};
const ip = process.env.MESH_TAILSCALE_IPV4;
if (!ip || isIP(ip) !== 4) fail("supply an assigned Tailscale IPv4 in MESH_TAILSCALE_IPV4");
if (!networkInterfaces().tailscale0?.some((address) => address.family === "IPv4" && address.address === ip)) {
  fail("MESH_TAILSCALE_IPV4 is not assigned to tailscale0");
}

const state = "/var/lib/pi-mesh";
try {
  const stateInfo = statSync(state);
  const runtimeInfo = statSync("/run/pi-mesh");
  const configInfo = statSync(`${state}/config.json`);
  if (!runtimeInfo.isDirectory() || runtimeInfo.uid !== 1000 || (runtimeInfo.mode & 0o077) !== 0) {
    fail("runtime directory must be private and owned by uid 1000");
  }
  if (!stateInfo.isDirectory() || stateInfo.uid !== 1000 || (stateInfo.mode & 0o077) !== 0) {
    fail("state directory must be private and owned by uid 1000");
  }
  if (!configInfo.isFile() || configInfo.uid !== 1000 || (configInfo.mode & 0o077) !== 0) {
    fail("config.json must be private and owned by uid 1000");
  }
  const config = JSON.parse(readFileSync(`${state}/config.json`, "utf8"));
  if (typeof config.brokerToken !== "string" || !config.brokerToken.trim()) {
    fail("config.json must contain a nonempty brokerToken");
  }
} catch {
  fail("cannot read private runtime/state/config.json");
}

// Override any listen value in config.json. The broker still opens its Unix
// socket alongside this TCP listener; no wildcard or Docker port mapping.
process.env.MESH_LISTEN = `tcp://${ip}:8712`;
const { main } = await import("./dist/src/broker/broker.js");
await main();
