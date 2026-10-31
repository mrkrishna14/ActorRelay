// Glue on 7200: connects the simulator, the actors, the agents and the dashboard. Run it in WSL through run-wsl.sh.
import { TerseActors } from "./actors";
import { Glue } from "./app";
import { HttpBridge } from "./bridge";
import { loadConfig } from "./config";
import { RelayParticipant } from "./relay";

const config = loadConfig();
let glue: Glue | null = null;
const relay = new RelayParticipant({
  url: config.relayUrl,
  systemName: config.systemName,
  keyFile: config.relayKeyFile,
  tokenFile: config.relayTokenFile,
  onInbound: async (message) => glue?.onRelayMessage(message),
});
glue = new Glue({ actors: new TerseActors(config.terseUrl), bridge: new HttpBridge(config.bridgeUrl), relay, config });

const server = Bun.serve({ hostname: config.host, port: config.port, idleTimeout: 60, fetch: glue.handle });
relay.start();
glue.start();
console.log(`glue on http://${config.host}:${server.port}, actors ${config.terseUrl}, simulator ${config.bridgeUrl}, relay ${config.relayUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    glue?.stop();
    relay.stop();
    server.stop(true);
    process.exit(0);
  });
}
