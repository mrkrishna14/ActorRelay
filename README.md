# ActorRelay

An agentic control layer for simulated process plants. Equipment agents negotiate operating changes, cite evidence, reject unsafe proposals, and share what they learn across plants.

## Plan and ownership
- [Implementation plan](PLAN.MD)
- [Technical contract and working rules](CLAUDE.MD)
- [Person 1: durable actors and agents](TASK1.MD)
- [Person 2: simulation](TASK2.MD)
- [Person 3: dashboard and integration](TASK3.MD)

## Demo
Propose a pump increase, see connected equipment block it with evidence, negotiate a safer target, observe the result, and apply shared knowledge in the second plant.

## Frontend

The frontend lives in `web/` and opens directly into the simulated plant, with no account, tokens, connection wizard, or service setup. It follows the approved monochrome 2D and 3D designs, with light/dark themes, adjustable panels, animated flow, and equipment-agent context in both views, chat, and the state inspector.

```sh
bun install --cwd web
bun run web:dev
```

Open `http://127.0.0.1:3000`. Build with `bun run web:build`; the deployable static files are in `web/out/`. Run `bun run web:check` and `bun run web:test` for validation. Agent activity, Relay harness sessions, votes, and observations are browser-only sample data; the app makes no external backend calls. The unused Relay SDK adapter remains available for later integration. See [frontend handoff](web/HANDOFF.md) for controls and service boundaries.

## Existing development setup

This workspace currently includes a Terse counter starter, a local actor server, an interactive WebSocket client, and project-scoped Agent Relay tools for Codex and Claude Code. These verify the infrastructure; the ActorRelay plant described above is not implemented yet.

Requires Bun 1.4.2+, Node.js 22+, and Terse CLI. This setup uses Bun 1.4.4, Terse CLI / SDK 0.14.9, and Agent Relay 15.0.1-next.0.

## Agent Relay

```sh
bun run relay:init
bun run relay:status
bun run relay:agents
```

The initializer starts a Relaycast server on this machine at `http://127.0.0.1:8787` and pins this repository to the `factoryio` workspace. Agent tools connect through the project MCP configuration in `.mcp.json` (Claude Code) and `.codex/config.toml` (Codex). Open a new agent session in this folder to load the tools; approve the project server when prompted. Codex loads project MCP settings for trusted projects. See the [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Relay's local workspace credentials and state live in `.agentworkforce/relay/` and are ignored by Git. Each teammate runs the initializer on their own machine; the default local server connects agents on the same machine. For a shared workspace across machines, follow [Agent Relay's team setup](https://agentrelay.com/docs/getting-started).

Use `bun run relay --help` for the full CLI. The MCP tools include agent discovery, messages, and inbox access. Send messages when the user asks for agent communication.

`relay:agents` queries the local workspace. `relay:status` also reports the optional process broker and cloud login; those can show `stopped` and `not logged in` while this local MCP setup is working.

## Run locally

From this folder, start the server:

```sh
bun run dev
```

In a second terminal, generate the client and start it:

```sh
bun run generate
bun run start
```

Use `+` to increment, `-` to decrement, and `q` to quit. Start another client on the same counter ID to see updates in both terminals:

```sh
bun run start --id counter
```

The actor endpoint is `http://127.0.0.1:7100/v1/projects/local/actors`. State is saved in `actor/.terse/local/` and survives server restarts. The dev script selects this directory because Terse excludes `.terse/` from cloud source uploads. Each counter ID has its own value. The local runtime works without cloud credentials.

Edit `actor/src/actors.ts` to add actors or methods, then regenerate the client. Check both projects with `bun run check` while the generated client exists.

## Install dependencies again

```sh
bun run setup
```

For another machine, install the CLI with `bunx terse-cli@0.14.9 install --yes --non-interactive`.

## Terse Cloud

The CLI is signed in to the **YC Hack** organization, and `actor/terse.config.json` links this starter to the **yc-hack** project. On another machine, sign in with `terse auth login`. Check your account with `terse auth status`.

Deploy the actor with:

```sh
bun run deploy
```

The counter is deployed at `https://api.useterse.ai/cmvwqjass00nsjy2a0ttpr297/actors`. This is an authenticated actor API; open the Terse dashboard to view the project.

Cloud connection settings are saved in the ignored `client/.env.cloud`, using the signed-in CLI's key for this development client. On another machine, copy `client/.env.cloud.example` to `client/.env.cloud` and fill in an API key from the Terse dashboard. Keep the real environment file private.

```sh
bun run start:cloud
```

Use `bun run generate:cloud` to regenerate types from the hosted actor contract. Use `bun run generate` against the local server afterward to restore local defaults. Both clients use the same contract; `start:cloud` explicitly selects the hosted endpoint, while `start` uses local defaults.

[Terse quickstart](https://docs.useterse.ai/quickstart) · [CLI reference](https://docs.useterse.ai/reference/cli)
