# Private Docker broker with a dedicated Tailscale node

One published mesh broker, not a Pi worker or an approval relay. Pi sessions remain outside these containers. No mesh extension, protocol, or broker implementation changes are required.

## Reference-host deployment status

The first real sidecar enrollment on 2026-11-03 failed before registration. Isolated actual-open/firewall probes established that this host also needs `NET_RAW` for iptables, and that a root-running sidecar without DAC-bypass capabilities cannot read a UID1000-owned mode0600 enrollment file. Operator-approved minimum fix: sidecar NET_ADMIN+NET_RAW and **root-owned0600 enrollment key only**, without DAC_OVERRIDE or DAC_READ_SEARCH. This fix was applied and the existing one-time key enrolled successfully. Broker state/runtime remain UID/GID1000. Both services passed actual startup, Unix/TCP token-authenticated request/reply, and identity-preserving restart checks. The operator subsequently approved autostart: the reference deployment now uses `MESH_RESTART=unless-stopped` on both containers, applied without recreating/restarting them. Fresh deployments still default to `no` until separately approved. Mac/end-to-end Tailscale messaging remains untested. Do not infer whole-service compatibility from the earlier NET_ADMIN-only TUN probe.

Compose's warning about a NAS secret path missing in the Docker client's filesystem was misleading: inspection showed the key correctly mounted read-only. Do not switch mount mechanisms to address that warning alone. Keep automatic restart disabled during diagnosis.

## Security and storage

- `tailscale`: kernel mode (`TS_USERSPACE=false`), `/dev/net/tun`, only `NET_ADMIN` and `NET_RAW`, dedicated network namespace and persistent node state. Explicitly advertises `tag:pi-mesh-broker`; disables Tailscale SSH, DNS changes and route acceptance. No Serve, Funnel, subnet-router or exit-node role.
- `broker`: shares that namespace, runs as UID/GID 1000 with a read-only rootfs, no capabilities and no new privileges. TCP binds only to the supplied IPv4 actually assigned on `tailscale0`, port **8712**. No host port publishing, host networking, wildcard or LAN bind.
- Local devbox clients use the same broker's Unix socket `/run/pi-mesh/broker.sock`, via a private shared workspace bind. Unix access relies on filesystem ownership/modes; remote TCP retains mesh shared-token authentication. Tailscale encrypts remote transport; mesh application TLS is not configured here.
- All participants/token holders are trusted infrastructure, not mutually isolated identities. Existing force/remote-control restrictions and local Pi approvals must not be widened.
- Host runtime directories must be owned by UID/GID 1000 with no group/other access. `state/config.json` must be a regular mode-0600 file containing a nonempty `brokerToken`. The deployment entrypoint rejects insecure permissions or missing/unassigned IPs without logging secret values.
- `MESH_RESTART=no` initially. Enable `unless-stopped` only after explicit approval; it restarts crashed services and starts them after Docker restart, except services deliberately stopped by the operator.

The sample pins official image digests available on the reference NAS. Verify architecture/availability elsewhere; do not silently substitute mutable tags.

## Host paths versus Docker-client paths

Docker bind sources are interpreted by the **Docker daemon**, not the shell running the client. On the reference devbox:

| Purpose | NAS / Docker daemon path | Devbox client path |
| --- | --- | --- |
| Private runtime root | `/mnt/ServiceAndDataPool/projects/.pi-mesh` | `/home/dev/workspace/.pi-mesh` |
| Canonical checkout | `/mnt/ServiceAndDataPool/projects/pi-mesh` | `/home/dev/workspace/pi-mesh` |

Set `MESH_HOST_ROOT` **inside `deploy.env`** to the NAS path. Use the devbox path to read/write that same file with the Docker client. For the commands below, run in devbox:

```bash
export MESH_LOCAL_ROOT=/home/dev/workspace/.pi-mesh
export MESH_COMPOSE_FILE=/home/dev/workspace/pi-mesh/deploy/docker/compose.yaml
mesh_compose() {
  sudo docker compose --env-file "$MESH_LOCAL_ROOT/deploy.env" -f "$MESH_COMPOSE_FILE" "$@"
}
```

On the NAS itself, use its corresponding local paths. On macOS use `docker compose` without `sudo`. Never use legacy `docker-compose`.

Keep all runtime files outside the checkout:

```text
.pi-mesh/                     mode 0700
  deploy.env                  mode 0600; image refs, paths and assigned IP, no token
  runtime/                    mode 0700; broker socket/lock/PID
  state/                      mode 0700
    config.json               mode 0600; { "brokerToken": "<securely generated>" }
  tailscale-authkey           root-owned mode0600; enrollment key, never committed/logged
```

Tailscale node identity uses the separate Compose named volume `pi-mesh_tailscale_state`. Never borrow another service's identity or state volume.

## Approval and preparation

Before starting either service, review the **complete current tailnet policy** and approve the change. A narrow grant does not override existing broad allows. `autogroup:self` excludes separately tagged nodes, so verify the enrolled node actually has the broker tag before starting the broker; an untagged enrollment may inherit broader user-owned-device access.

Use a specific approved source device IPv4 `/32` to `tag:pi-mesh-broker`, `tcp:8712`, plus positive/negative policy tests. Decide IPv6 separately. Create an enrollment key authorized for this tag. Transfer credentials using masked tooling or secure files, not chat, shell arguments/history, debug traces or committed files.

Create the private directories as UID/GID 1000, copy `.env.example` to `$MESH_LOCAL_ROOT/deploy.env`, and prepare the mode-0600 secret files securely. Keep broker `state/config.json` UID1000-owned; make only `tailscale-authkey` root-owned so the root-running sidecar can read it without DAC-bypass capabilities. Do not put the broker token in `deploy.env`; containerboot receives `TS_AUTHKEY=file:/run/secrets/tailscale_authkey`, not the key value in environment or command arguments. Confirm these files exist before Compose startup.

```bash
mesh_compose config --quiet
mesh_compose build broker
```

The multi-stage build runs `npm ci --ignore-scripts` and `npm run build`. Runtime contains only `dist/`, package metadata and the deployment guard, with no `node_modules` or runtime package dependencies. Repository-root `.dockerignore` allowlists inputs for legacy Docker and BuildKit, excluding `.git`, host dependencies, runtime files and credentials.

On 2026-11-03, upstream's locked development tree reported four high-severity audit findings (`@opencode-ai/plugin`, `effect`, `toml`, `zod`). No upgrades or automatic fixes were applied; those packages are absent from the broker runtime. Review separately before using optional non-Pi adapters. This is not a complete container vulnerability scan.

## Stage 1: enroll only the dedicated sidecar

With restart still disabled and the broker IP still blank:

```bash
mesh_compose up -d tailscale
mesh_compose ps
mesh_compose exec -T tailscale tailscale ip -4
```

Complete any tailnet device approval, verify the actual node tag, and record the assigned IPv4. A blank broker IP is allowed while starting only `tailscale`, but the broker guard refuses to start with it. Set `MESH_TAILSCALE_IPV4` in the private `deploy.env` to the observed address.

## Stage 2: start one broker, still without autostart

```bash
mesh_compose up -d --no-build broker
mesh_compose ps
mesh_compose logs --tail=100 broker
```

Configure devbox clients with explicit paths, before loading the extension:

```bash
export MESH_RUNTIME_DIR=/home/dev/workspace/.pi-mesh/runtime
export MESH_BROKER_URL=unix:///home/dev/workspace/.pi-mesh/runtime/broker.sock
export MESH_NO_AUTO_BROKER=1
# Set an explicit private MESH_STATE_DIR for each intended identity/session.
```

Client state is separate from the broker's `state/`; do not point clients at the broker's credential directory. Agree a shared room for devbox/Mac sessions. Shell exports affect child processes only, not existing Pi/Web parents. Configure every intended launcher before globally loading the extension; do not restart existing launchers or reload live sessions without approval. Never use `pimesh broker start` to compete with this supervised broker.

Mac Pi uses `tcp://<observed-tailnet-IPv4>:8712`, the securely transferred token, and `MESH_NO_AUTO_BROKER=1`. Prefer the explicit IPv4 when the grant only permits IPv4. Mac setup and end-to-end testing are separate steps; local approvals stay with the interactive Mac worker.

## Stage 3: verify, then separately approve autostart

Verify extension loading, local Unix request/reply, token rejection, effective Tailscale allow/deny boundaries, and a correlated Mac reply. Delivered, read and answered are distinct. Approval is required before changing `MESH_RESTART` to `unless-stopped`:

```bash
mesh_compose up -d --no-build
```

## Status, logs, stop, restart and rollback

```bash
mesh_compose ps
mesh_compose logs --tail=100 broker tailscale
mesh_compose stop broker
mesh_compose up -d --no-build broker
mesh_compose restart broker
mesh_compose stop                   # stop both; retain state
mesh_compose down                   # remove this project's containers/network; retain state
```

If the sidecar is **recreated** rather than restarted, recreate the broker too so it joins the new namespace. Its persistent node state should retain the assigned identity/IP; reverify before starting the broker.

For rollback, stop/down only this Compose project, remove only its extension link/client launch configuration, and revoke only its new node/enrollment credential if desired. Preserve the private runtime root and named Tailscale volume unless deletion is explicitly authorized. Do not use `down -v`, volume pruning, tailnet logout or credential rotation against unrelated services.

To rotate a broker token, stop broker/clients, securely replace only `brokerToken` in `config.json` while preserving ownership/mode, redistribute by the approved secure channel, and restart. Preserve the Tailscale state for ordinary restart/rotation; deleting it enrolls a different node.
