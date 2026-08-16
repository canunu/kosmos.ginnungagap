# Working in kosmos.ginnungagap

`README.md` is the reference. Its Development section has the tools, the commands,
what is tested where, and why each check blocks rather than warns; `The build`
covers the source-to-artefact split. Nothing below repeats those — this file is only
what changes when an agent is the one working.

## Invoking commands

The directory above this one is not a repository, so commands need the prefix:
`npm --prefix kosmos.ginnungagap <script>`, `git -C kosmos.ginnungagap <command>`.

`npm test` needs the Docker CLI but not the daemon, so it runs sandboxed. **`npm
run test:docker` needs the daemon**, which the sandbox cannot reach, so it requires
an unsandboxed command. It is safe to run: it uses a stand-in image under a
separate project name and tears down after itself, so a real `ginnungagap` on the
same machine is untouched.

## Two failures that are not defects

`npm run build` fails on an unset `yggdrasil.image`. That is the `${VAR:?}` guard
working as designed. Distinguish it from a real failure when reporting.

A variable set in `config/deployment.json` and unused in `compose.yaml`, or the
reverse, fails the build in both directions on purpose. It means a half-finished
change, not a broken build.

## Edits that look harmless and are not

**Comments in `compose.yaml` never reach Kosmos.** `docker compose config` reparses
and reserialises, so `dist/compose.yaml` carries none of them. That makes the
comments here the only copy of their reasoning — there is no annotated artefact
downstream to fall back on — and it means a comment edit cannot change what is
deployed. Trim them for duplication or staleness, not for size.

One comment is load bearing beyond its text: the mention of `${HOME}` in the
certificate mount block is the only live justification for `stripComments` in
`scripts/lib/deployment.mjs`, whose docstring cites it. Reword it and that
docstring becomes false.

**The loopback binding is a cross-repository invariant.** `kosmos.yggdrasil`'s
nginx sets `set_real_ip_from 0.0.0.0/0` and trusts a PROXY protocol header from any
source, which is safe _only_ because nothing off-host can open that connection.
Publishing on `0.0.0.0` would turn that trust into client address spoofing, from a
change made here. The unit suite asserting `127.0.0.1` is the only place the two
repositories are held together; do not relax it to make something pass.

Setting `container_name` would break `tests/docker/runtime.test.js`, which
hard-codes the generated `ginnungagap-yggdrasil-1`.
