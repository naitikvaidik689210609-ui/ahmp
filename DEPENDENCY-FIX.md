# Dependency resolution fix

The original project pinned `esbuild` to `^0.25.0`, while the resolved Vite 8 release
requires the optional peer `esbuild` range `^0.27.0 || ^0.28.0`. This caused npm
`ERESOLVE` during VPS installation.

The package manifest now uses `esbuild: ^0.28.0`. The stale Bun lockfile was removed
so it cannot reintroduce the old `esbuild@0.25.x` resolution. npm will resolve a
compatible dependency tree from `package.json`.

## Install / rebuild

From the project directory:

```bash
rm -rf node_modules package-lock.json
npm cache verify
npm install
npm run build
```

For an existing VPS install, run the commands from the panel directory, then restart
the service:

```bash
cd /opt/fbbahi-panel
rm -rf node_modules package-lock.json
npm install
npm run build
systemctl restart fbbahi-panel
systemctl status fbbahi-panel --no-pager
```

If your installer uses a different install directory or systemd service name, use
the values configured in your `install.sh`.

Do not use `--force` or `--legacy-peer-deps` for this issue; the manifest now
requests a compatible esbuild version.
