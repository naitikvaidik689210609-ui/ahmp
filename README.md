# AHMP Smart Installer update

This package contains an updated `install.sh` for the `ahmp` repository.

## What it checks
- Ubuntu/Debian + apt availability
- Base packages: curl, wget, git, CA certificates, gnupg, lsb-release, sqlite3, build-essential, Python 3, make, g++, rsync, tar and OpenSSL
- Node.js >= 22.12.0 and npm (automatically installs Node.js 22 LTS when missing/too old)
- Docker and Incus (attempts installation; these are treated as optional integrations if their upstream repositories are unavailable)
- NPM install/build failures are reported with a saved log at `/opt/fbbahi-panel/install-npm.log`

## Publish
Replace the existing `install.sh` in `naitikvaidik689210609-ui/ahmp` with this file and commit it to the `main` branch.

Then run:
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/naitikvaidik689210609-ui/ahmp/main/install.sh)
```

The installer still requires root and supports Ubuntu/Debian with apt. Back up your panel database before choosing Reinstall.
