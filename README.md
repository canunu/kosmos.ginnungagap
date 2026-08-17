# ginnungagap

The Compose project that holds what runs directly in Docker Desktop on Kosmos.

Today it holds one service, `yggdrasil`, the application edge. It exists as a named grouping rather than a bare `docker run` so that whatever comes next joins something that already has a name, a network, a deploy path and a startup path, instead of acquiring its own.

**The registry is deliberately not here**, though it briefly was. It sits below this project rather than beside the edge — the cluster pulls from it too — and it has to be running before anything here can start, which one project cannot express because Compose resolves every image before creating any container. It has a project of its own, in [kosmos.draupnir](../kosmos.draupnir).

`ginnungagap` is a Norse name because it groups containers, and deliberately not a realm name, because those are reserved for Kubernetes namespaces. The reasoning is in [Conventions](../kosmos.bootstrap/docs/02_Conventions.md), and what every other name used here refers to is in [Component Inventory](../kosmos.bootstrap/docs/05_Inventory.md).

## Where it sits

```mermaid
graph TD
    CLIENT["LAN and WAN clients"]
    HERMES["hermes - HAProxy on the host, 80 and 443"]

    NODES["cluster nodes - containerd"]

    subgraph GAP["ginnungagap - this repository"]
        YGG["ginnungagap-yggdrasil-1 - image from kosmos.yggdrasil"]
    end

    GATEWAY["the Istio ingress gateway - 192.168.50.100"]
    DRAUPNIR["draupnir - its own project, on loopback 5000"]

    CLIENT -->|"TCP 443"| HERMES
    HERMES -->|"loopback 8443, PROXY protocol v2"| YGG
    YGG -->|"HTTPS, internal name in Host"| GATEWAY
    DRAUPNIR -.->|"the edge's image is pulled from here"| YGG
```

The dotted edge is the only surprising one: the edge's own image comes from a registry on the same host. That is not circular, and why is covered in [Bootstrapping](#bootstrapping).

## Responsibilities

| Does                                                     | Does not                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| declare how `yggdrasil` is run: mounts, port, privileges | build the image or hold its configuration, which is [kosmos.yggdrasil](../kosmos.yggdrasil) |
| pin the exact image versions deployed, with history      | decide what the images contain                                                              |
| name the project and its network                         | appear in any DNS name, because it names a grouping                                         |
| build a resolved compose file and copy it to Kosmos      | bring itself up at login, which `atlas` does                                                |
| hold the only writable mount the edge has                | run the registry, which has a project of its own in [kosmos.draupnir](../kosmos.draupnir)   |

## Layout

```
compose.yaml              the source: one service, one network
config/deployment.json    what varies, and the deployment record
dist/compose.yaml         the built artifact, untracked, what Kosmos runs
scripts/build-compose.mjs the build
scripts/lib/              the configuration to environment mapping
tests/unit/               the project's invariants; no daemon needed
tests/docker/             what the daemon actually applied
```

`compose.yaml` carries its reasoning inline rather than repeating it here, so that the reason for a setting sits next to the setting.

## The build

`compose.yaml` is the source, not the artifact. `npm run build` resolves it against `config/deployment.json` and writes `dist/compose.yaml`, and that resolved file is what is deployed and what Kosmos runs.

The transform is **`docker compose config` itself**, not a templating library. Compose already interpolates `${VAR}`, validates the schema, and emits canonical YAML, so there is no substitution code here to get wrong and no second opinion about what a valid project is. `compose.yaml` stays a valid compose file that can be run directly during development.

Two consequences, both accepted:

- **The artifact has no comments.** Compose reparses and reserialises, so the reasoning does not survive into `dist/`. The artifact is not where it is read.
- **An unset value fails on your machine, not on Kosmos.** `compose.yaml` uses the `${VAR:?}` form, so a missing image is a build failure during deploy rather than a container that will not start after a reboot.

`dist/` is not tracked. It is deterministic from two tracked inputs, so committing it would add churn without adding information.

### Configuration

`config/deployment.json` holds what varies. A service's settings become Compose variables mechanically, so `yggdrasil.logRetentionDays` is `YGGDRASIL_LOG_RETENTION_DAYS`:

```json
{
  "yggdrasil": {
    "image": "amalthea.hades.kosmos.internal:5000/yggdrasil:<git-sha>",
    "logRetentionDays": 30,
    "cpuLimit": "2",
    "memoryLimit": "1g"
  }
}
```

Adding a setting is an edit here and in `compose.yaml`. The build fails if either is missing the other, in both directions: a variable the configuration does not set, and a setting the compose file never uses. The second is the quieter mistake and the one that leaves dead configuration behind.

It is tracked, and that is the point. `git log -p -- config/deployment.json` is the deployment history, and a rollback is the previous value.

## The decisions worth knowing

An index, not the arguments. Each line says what was chosen and enough to recognise why; the reasoning lives once, either in the comment beside the setting in `compose.yaml` or in the platform documentation those comments point at. If you find the same argument in two of those places, one of them is wrong and it is probably this one.

| Choice                                            | Reason                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pull_policy: missing` on the edge                | makes first bootstrap and steady state the same file, with no first-run branch                                        |
| immutable git SHA tags, never `latest`            | rollback is one line, and it is what makes `pull_policy: missing` safe                                                |
| configuration tracked, artifact not               | the pinned tag is the deployment record and wants history; the built file is derivable and would only add churn       |
| published to `127.0.0.1` only                     | the listener trusts a PROXY header from any source, which is only safe if nothing off-host can open the connection    |
| `read_only`, `cap_drop: ALL`, `no-new-privileges` | nothing writes outside the log mount and `/tmp`, so the container has no route to more than it started with           |
| `tmpfs` on `/tmp`, in long form                   | the image relocates the pid file and all five temp paths there so the root can be read only, and the size matters     |
| `stop_signal: SIGQUIT`                            | nginx's graceful shutdown. The default `SIGTERM` is its fast one and drops connections mid-deploy, which clients see  |
| network named `ginnungagap`                       | with one network, the project and the network are the same boundary                                                   |
| `restart: on-failure`                             | `atlas` is the sole start authority; a daemon-initiated start would bypass its resource and readiness checks          |
| certificates mounted, never copied in             | a private key in an image is a private key in the registry and in every layer cache that pulled it                    |
| runtime limits in Compose, not the Dockerfile     | a Dockerfile builds an image; cgroup limits belong to whoever runs it, so this is the only place they can be asserted |

## Bootstrapping

The edge's image comes from a registry on the same host, which looks circular and is not. The sequence that resolves it — build the first image on Kosmos, push it, let the local store carry the first run — is a host procedure and lives in [Bootstrapping](../kosmos.bootstrap/docs/bare_metal/05_GinnungagapSetup.md#bootstrapping-the-first-image).

What this repository contributes is one setting: **`pull_policy: missing`**, which resolves locally on the first run and pulls once `brokk` is building instead. One file, both cases, no first-run branch.

> **The registry has to be up first**, because on a cold image store `docker compose up -d` will try to pull the edge's image. It is a separate project precisely so that ordering is something `atlas` sequences rather than something this file has to caution about.

## Runtime prerequisites

The container fails clearly rather than mysteriously when one of these is missing, but it does fail.

| Requirement                                                            | Why                                                                                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Docker Desktop running                                                 | there is no daemon otherwise, and it is a GUI application that has to be set to start at login                                     |
| `/Users/typhon/certs/canunu.me/canunu.me.fullchain.pem` and its `.key` | mounted as files. A missing source becomes a directory, and nginx then reports an unreadable certificate rather than an absent one |
| `/Users/typhon/certs/kosmos-local-ca/kosmos-local-ca.crt`              | the authority that internal upstreams are verified against                                                                         |
| `/Users/typhon/var/kosmos/yggdrasil` exists and is writable by uid 101 | the entrypoint checks both and exits with an explanation. The most likely first run failure                                        |
| `yggdrasil.image` set in `config/deployment.json`                      | the build refuses to produce an artifact, with an explanation, while it is empty                                                   |
| the images present locally or pullable                                 | see [Bootstrapping](#bootstrapping)                                                                                                |
| the registry running, if the edge's image is not already local         | it is a separate project; `atlas` starts it first. See [kosmos.draupnir](../kosmos.draupnir)                                       |
| `hermes` running                                                       | not needed to start, but nothing reaches the edge without it, since 8443 is loopback only                                          |

## Bringing it up

On Kosmos, from the deployed directory:

1. `cd ~/ginnungagap`
2. `docker compose up -d`
3. `docker compose ps`

Expected result:

- one container, `ginnungagap-yggdrasil-1`, `running` and shortly afterwards `healthy`
- `docker network ls` lists `ginnungagap`

The health status comes from the image's own check against its container-local status listener, so `healthy` proves nginx is answering rather than merely that the process started.

## Deploying a new version

1. Build and push the new image, or let `brokk` do it
2. Set the new reference in `config/deployment.json`
3. Commit, so the deployment record moves with the change
4. `npm run deploy`
5. On Kosmos: `docker compose up -d`

Step 4 lints, runs the invariant suite, builds the artifact, and only then copies it. A compose file that fails its own tests cannot reach Kosmos, which is the reason deploying is an npm script rather than a shell one.

Compose recreates the container because the image reference changed, and does nothing if it did not. Rolling back is the same sequence with the previous value.

The public certificate rotates independently of all of this. Replacing the two files on the host and restarting the container is the whole procedure: nothing is rebuilt and no image reference changes.

## Development

### Tools

| Tool                        | Role                                                                     |
| --------------------------- | ------------------------------------------------------------------------ |
| Node, pinned in `mise.toml` | tooling only. Nothing here runs Node at deploy time or on Kosmos         |
| `node:test`                 | the test runner, built in, so the suites run with nothing installed      |
| commitlint and husky        | conventional commits, enforced on `commit-msg`                           |
| lint-staged and prettier    | formatting on `pre-commit`                                               |
| shellcheck                  | the git hooks, which are shell and easy to break. Required, not optional |

### Setup

1. `mise install`
2. `npm install`

`npm install` runs `prepare`, which installs the git hooks. There is no separate step.

### Commands

| Command               | Does                                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| `npm run build`       | resolves `compose.yaml` into `dist/compose.yaml`                            |
| `npm test`            | the invariant suite. Needs the Docker CLI, not the daemon                   |
| `npm run test:docker` | creates a container with a stand-in image and inspects it. Needs the daemon |
| `npm run lint`        | shell and formatting                                                        |
| `npm run format`      | applies formatting                                                          |
| `npm run deploy`      | lint, test, build, then copy to Kosmos                                      |

### What is tested, and where

The unit suite runs against `docker compose config`, which is client side, so it works with Docker Desktop stopped and takes about a second. It asserts the project's invariants rather than its style, and most of them exist because something else depends on them.

The sharpest is the loopback binding. `kosmos.yggdrasil`'s nginx sets `set_real_ip_from 0.0.0.0/0` and trusts the PROXY protocol header from any source, which is safe only because nothing off-host can open that connection. Publishing on `0.0.0.0` would turn that trust into a client address spoofing vulnerability, silently, from a change in this repository. That test is the only place the two repositories are held together.

The docker suite asserts a different claim: that the daemon applied what Compose described. It uses `docker compose create` under a separate project name, so nothing has to start, no working image is needed, and a real `ginnungagap` on the same machine is never disturbed.

It deliberately does not build or exercise the `yggdrasil` image. That is covered by the docker suite in `kosmos.yggdrasil`. This repository tests the runtime contract around the image; that one tests the image.

### Git hooks

- `commit-msg`: conventional commit validation, scopes in `commitlint.config.mjs`
- `pre-commit`: lint-staged
- `pre-push`: the unit suite, then the docker suite

Tests run on push rather than on commit. A series of commits then costs one test run instead of one each, and the commit hook stays quick enough that nobody reaches for `--no-verify` to get past it.

Push is also the only gate that sees everything going out. A push can carry commits made with `--no-verify`, rebased in from elsewhere, or written on a machine where the hooks were never installed, so nothing earlier is a guarantee about what is actually being pushed.

The docker suite runs only on push, and **it does not block one when the daemon is unreachable**. That is an environment condition rather than a defect, and failing on it would teach the habit of `--no-verify`, which also switches off the commit message hook — a worse outcome than an unverified runtime suite. It warns loudly instead, because the alternative to a noisy skip is a silent one.

### Nothing else is advisory

Every other check fails rather than warns. A check that does not block is a check that accumulates violations until nobody reads its output any more.

| Check      | How it is made to fail                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| prettier   | `--check` already exits non-zero on any unformatted file. Its `[warn]` prefix is a log label, not a soft outcome                                                                              |
| commitlint | `--strict` in the hook, which promotes warnings to failures. Without it, level 1 rules exit 0, and `@commitlint/config-conventional` ships several of its own at that level                   |
| shellcheck | a missing shellcheck fails the lint rather than skipping it. It is a declared tool here, so its absence is a broken environment, and skipping would mean the hooks quietly stop being checked |

The docker suite above is the single exception, and only because an unreachable daemon says nothing about the change being pushed. It reports why it could not run, since "not running" and "not permitted to connect" send you to look in different places.

## Verification

1. `npm run build` writes `dist/compose.yaml` with the image reference resolved
2. `curl --haproxy-protocol -sI --resolve canunu.me:8443:127.0.0.1 https://canunu.me:8443/ping` reaches the edge directly
3. `curl -sI https://canunu.me/ping` reaches it through `hermes`
4. `ls -l /Users/typhon/var/kosmos/yggdrasil/` shows `yggdrasil.error.log` and a dated access log

The PROXY protocol flag in step 2 is not optional. Once the listener requires the header, a plain `curl` against the published port cannot complete a request, so its failure would mean nothing.

## Not covered here

- how the image is built, configured or tested: [kosmos.yggdrasil](../kosmos.yggdrasil)
- what the names mean and why: [Conventions](../kosmos.bootstrap/docs/02_Conventions.md)
- installing Docker Desktop and Compose, the `/etc/hosts` entry, and the first push: the Kosmos setup documents in [kosmos.bootstrap](../kosmos.bootstrap)
- bringing this up at login: `atlas`, in [kosmos.bootstrap](../kosmos.bootstrap)
- the host side of first bootstrap, including the directories this expects: [Ginnungagap Setup](../kosmos.bootstrap/docs/bare_metal/05_GinnungagapSetup.md)
