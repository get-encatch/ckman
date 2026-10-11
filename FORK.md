# get-encatch/ckman

This is the get-encatch fork of [housepower/ckman](https://github.com/housepower/ckman).
It keeps ckman's Go backend and replaces its Vue 2 UI with our own React UI.
We do not send changes upstream; anyone is free to use this fork under the
original Apache-2.0 licence (see `LICENSE`).

## What differs from upstream

| | upstream | this fork |
|---|---|---|
| Backend | Go (`controller/`, `service/`, …) | same code, plus our changes |
| UI | `frontend/` submodule → housepower/ckman-fe (Vue 2) | `web/` — React + shadcn/ui on Base UI, Vite, TypeScript |
| `make frontend` | builds the submodule | builds `web/` into `static/dist/` |

The Go binary embeds `static/dist/` exactly as upstream does, so `make build`
still produces one binary with the UI inside. `Dockerfile.build` (the old Node 14
build image) is untouched and cannot build `web/`; use Node 22+.

## Branches

| Branch | Purpose |
|---|---|
| `main` | Mirror of `housepower/ckman` `main`. Never commit here. |
| `encatch/main` | Default branch: upstream + our changes. Changes land via PR (merge commits). |
| `feat/*`, `fix/*` | Work branches off `encatch/main`. |
| `sync/upstream-*` | Created by `scripts/sync-upstream.sh` to bring in upstream changes. |

## Taking upstream changes

```bash
scripts/sync-upstream.sh
```

It fast-forwards `main` to upstream, merges upstream into a new
`sync/upstream-*` branch off `encatch/main`, drops upstream's changes to the
`frontend/` submodule (we don't use it), and pushes the branch. Open a PR into
`encatch/main`. If anything else conflicts, the script stops and lists the
files to resolve by hand.

To keep those conflicts rare:

- Put new features in new files where possible.
- Keep edits to upstream files small; don't reformat or rename upstream code.
- Upstream's UI changes need no action, but new backend features may need a
  matching screen in `web/`.

## Deploying to a VM

There is no CI pipeline; deploy straight from a checkout:

```bash
scripts/deploy-vm.sh root@<vm-ip> -i ~/.ssh/key.pem
```

It builds `web/` and the Go binary in Docker containers (Node 22, Go 1.24),
copies them to the VM and installs the same layout as upstream's deb/rpm
package: `/usr/local/bin/ckman`, config in `/etc/ckman/conf/`, logs in
`/var/log/ckman/`, and the `ckman` systemd service running as user `ckman`.
Config files are copied only on the first deploy, so edits made on the VM
survive later deploys.

Before the first deploy to an internet-facing VM:

- ckman listens on port **8808 on all interfaces** (the `server.port`
  setting; there is no bind-address option) over plain HTTP. Block 8808 in the
  VM's firewall and reach it through an SSH tunnel or a reverse proxy with TLS.
- The built-in admin user `ckman` starts with a default password that is
  public in the source code. Change it right after the first login.

## Working on the UI

```bash
cd web
npm install
npm run dev        # http://localhost:5173, proxies /api to a ckman on :8808
                   # (CKMAN_URL=http://host:8808 npm run dev for another one)
npm run build      # type-check + production build into web/dist
npm run lint
```

Stack: React 19, TypeScript, Vite, Tailwind 4, shadcn/ui on Base UI,
TanStack Router (file routes in `src/routes/`, `routeTree.gen.ts` is generated
by the Vite plugin and committed), TanStack Query, TanStack Table v9
(`components/app/data-table.tsx`), react-hook-form + zod, Recharts,
CodeMirror.

Layout:

| Path | What |
|---|---|
| `src/api/client.ts` | fetch wrapper: envelope, token, login, big-integer-safe JSON |
| `src/api/queries.ts` | clusters, nodes, deploy, settings, tasks, packages, users |
| `src/api/observability.ts` | tables, partitions, replication, sessions, query console, metrics, Keeper |
| `src/api/data-manage.ts` | backup/restore, rebalance |
| `src/routes/_app/clusters/$cluster/*` | one file per cluster tab |
| `src/components/app/` | app components (tables, dialogs, sheets, charts) |

API notes (the full field-by-field notes live in the PR that added the UI):

- Every response is HTTP 200 with `{retCode, retMsg, entity}`. Anything but
  `"0000"` is an error, including ClickHouse error codes such as `"0062"`.
  `request()` in `src/api/client.ts` handles this and signs out on 5020-5022.
- Auth: `POST /api/login` with the MD5 hex of the password, then send the
  returned token in a `token` header. Tokens are bound to the client IP and
  live in ckman's memory, so a ckman restart signs everyone out. User
  management endpoints take plain-text passwords (the server hashes them).
- `Accept-Language: en` gets English messages.
- Several endpoints return objects keyed by name rather than arrays, and
  `null` instead of `[]`; the query functions normalise both.
- `POST /deploy/ck` and `POST /ck/config/:cluster` decode **Go field names**
  (`Cluster`, `Shards[].Replicas[].Ip`, ...); every other body uses the json
  tags. Settings saves must send the whole object from `GET /ck/config`.
- Long operations (deploy, upgrade, add/remove node, settings, destroy,
  rebalance) return a task id; the UI opens `/tasks/<id>` and polls until the
  task-level `Status` is final (node lists can switch hosts mid-deploy).
- `docs/swagger.yaml` is incomplete and mostly declares responses as
  `string`, so the API types in `src/api/` are written by hand.
