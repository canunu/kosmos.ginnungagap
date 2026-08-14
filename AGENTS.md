# Working in kosmos.ginnungagap

Read `README.md` first. Its Development section already covers the tools, setup,
commands, what is tested where, and why each check blocks rather than warns. This
file adds only what is specific to operating here as an agent.

## Commands

Run them through the prefix, because the directory above this one is not a
repository:

```
npm --prefix kosmos.ginnungagap test            # unit suite
npm --prefix kosmos.ginnungagap run lint        # shell and formatting
npm --prefix kosmos.ginnungagap run build       # resolves dist/compose.yaml
npm --prefix kosmos.ginnungagap run test:docker # creates a container and inspects it
```

`npm test` needs the Docker CLI but not the daemon, so it runs sandboxed. **`npm
run test:docker` needs the daemon**, which the sandbox cannot reach, so it requires
an unsandboxed command. It is safe to run: it uses a stand-in image under a
separate project name and tears down after itself, so a real `ginnungagap` on the
same machine is untouched.

## compose.yaml is the source; dist/ is the artefact

`config/deployment.json` and `compose.yaml` change together. A variable set in one
and unused in the other fails the build in both directions, deliberately, and the
unit suite asserts that parity — so it will catch a half-finished change before
Docker does.

`npm run build` fails on an unset `yggdrasil.image`. That is the `${VAR:?}` guard
working as designed, not a fault in your change. Distinguish it from a real
failure when reporting.

## The unit suite holds a cross-repository invariant

The assertion that the port is published to `127.0.0.1` only is not style. The
nginx configuration in `kosmos.yggdrasil` sets `set_real_ip_from 0.0.0.0/0` and
trusts a PROXY protocol header from any source, which is safe _only_ because
nothing off-host can open that connection. Publishing on `0.0.0.0` would turn that
trust into a client address spoofing vulnerability, from a change made here.

That test is the only place the two repositories are held together. Do not relax it
to make something pass.

## Runtime limits belong here, not in the image

A Dockerfile builds an image; cgroup limits belong to whoever runs it. So
`deploy.resources.limits` in `compose.yaml` is the only place they can be
asserted. Note that the memory limit has to stay well clear of the `tmpfs` size on
`/tmp`, because tmpfs pages are charged to the same cgroup.
