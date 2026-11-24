#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# FB BAHI Panel — Ubuntu (22.04/24.04) & Debian VPS Remote Installer & Manager
# Supports: bash <(curl -fsSL https://raw.githubusercontent.com/naitikvaidik689210609-ui/ahmp/main/install.sh)
# ==============================================================================

REPO_URL="https://github.com/naitikvaidik689210609-ui/ahmp.git"
BRANCH="main"
TARBALL_URL="https://codeload.github.com/naitikvaidik689210609-ui/ahmp/tar.gz/refs/heads/${BRANCH}"

INSTALL_DIR="/opt/fbbahi-panel"
TMP_SRC_DIR="/tmp/ahmp-panel-src"
TMP_TARBALL="/tmp/ahmp-panel-src.tar.gz"
SERVICE_NAME="fbbahi-panel.service"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}"
BACKUP_DIR="/var/backups/fbbahi-panel"
PANEL_PORT="6767"

PURPLE="\033[1;35m"
CYAN="\033[1;36m"
GREEN="\033[1;32m"
YELLOW="\033[1;33m"
RED="\033[1;31m"
RESET="\033[0m"

if [[ "${EUID}" -ne 0 ]]; then
  echo -e "${RED}[Error] This installer must be run as root. Try: sudo bash <(curl -fsSL https://raw.githubusercontent.com/naitikvaidik689210609-ui/ahmp/main/install.sh)${RESET}"
  exit 1
fi

cleanup_staging() {
  rm -rf "${TMP_SRC_DIR}" "${TMP_TARBALL}" 2>/dev/null || true
}
trap cleanup_staging EXIT INT TERM

print_banner() {
  clear || true
  echo -e "${PURPLE}"
  cat <<'EOF'
 ███████╗██████╗     ██████╗  █████╗ ██╗  ██╗██╗
 ██╔════╝██╔══██╗    ██╔══██╗██╔══██╗██║  ██║██║
 █████╗  ██████╔╝    ██████╔╝███████║███████║██║
 ██╔══╝  ██╔══██╗    ██╔══██╗██╔══██║██╔══██║██║
 ██║     ██████╔╝    ██████╔╝██║  ██║██║  ██║██║
 ╚═╝     ╚═════╝     ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝
EOF
  echo -e "${CYAN}  Self-Hosted Game Server & Cloud VM Control Panel${RESET}"
  echo -e "${PURPLE}  =================================================${RESET}\n"
}

# ----------------------------------------------------------------------------
# Smart Dependency Checker
# Required runtime: Node.js >=22.12.0 (Vite 8 / OpenAI / better-sqlite3)
# Missing system packages are installed automatically where supported.
# Docker and Incus are optional integrations: installation failures are shown
# clearly but do not prevent the web panel itself from being installed.
# ----------------------------------------------------------------------------
command_exists() { command -v "$1" >/dev/null 2>&1; }

version_at_least() {
  # Returns success when $1 >= $2 (semantic versions, e.g. 22.12.0).
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

show_check() {
  local label="$1" status="$2" detail="${3:-}"
  if [[ "$status" == "ok" ]]; then
    echo -e "  ${GREEN}[OK]${RESET} ${label}${detail:+ — ${detail}}"
  elif [[ "$status" == "missing" ]]; then
    echo -e "  ${YELLOW}[MISSING]${RESET} ${label}${detail:+ — ${detail}}"
  else
    echo -e "  ${RED}[FIX NEEDED]${RESET} ${label}${detail:+ — ${detail}}"
  fi
}

ensure_fetch_tools() {
  local missing=()
  local cmd
  for cmd in git curl tar rsync openssl; do
    command_exists "$cmd" || missing+=("$cmd")
  done
  if ((${#missing[@]})); then
    echo -e "${YELLOW}[Checker] Missing fetch tools: ${missing[*]}. Installing...${RESET}"
    apt-get install -y git curl wget ca-certificates gnupg lsb-release tar rsync openssl
  fi
}

ensure_node_runtime() {
  local current="" major=0
  if command_exists node; then
    current="$(node -p 'process.versions.node' 2>/dev/null || true)"
  fi

  if [[ -n "$current" ]] && version_at_least "$current" "22.12.0"; then
    show_check "Node.js >=22.12.0" ok "v${current}"
  else
    show_check "Node.js >=22.12.0" fix "${current:-not installed}; installing Node.js 22 LTS"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi

  if ! command_exists node; then
    echo -e "${RED}[Dependency Error] Node.js installation did not provide the 'node' command.${RESET}"
    return 1
  fi
  current="$(node -p 'process.versions.node' 2>/dev/null || true)"
  if ! version_at_least "$current" "22.12.0"; then
    echo -e "${RED}[Dependency Error] Node.js v${current:-unknown} is still too old. Required: >=22.12.0.${RESET}"
    return 1
  fi
  show_check "Node.js runtime" ok "v${current}"

  if command_exists npm; then
    show_check "NPM" ok "v$(npm --version 2>/dev/null || echo unknown)"
  else
    echo -e "${YELLOW}[Checker] NPM is missing; reinstalling Node.js package...${RESET}"
    apt-get install -y nodejs
  fi
  if ! command_exists npm; then
    echo -e "${RED}[Dependency Error] NPM is still unavailable after Node.js installation.${RESET}"
    return 1
  fi
}

ensure_docker() {
  if command_exists docker; then
    show_check "Docker" ok "$(docker --version 2>/dev/null | head -n1)"
  else
    show_check "Docker" missing "installing Docker Engine"
    if curl -fsSL https://get.docker.com | sh; then
      systemctl enable --now docker || true
      command_exists docker && show_check "Docker" ok "installed" || echo -e "${YELLOW}[Optional] Docker command is unavailable; container features may not work.${RESET}"
    else
      echo -e "${YELLOW}[Optional] Docker installation failed. Panel web UI can still be installed; Docker features will remain unavailable.${RESET}"
    fi
  fi
  if command_exists docker; then systemctl enable --now docker 2>/dev/null || true; fi
}

ensure_incus() {
  if command_exists incus; then
    show_check "Incus" ok "installed"
    systemctl enable --now incus 2>/dev/null || true
    return 0
  fi

  show_check "Incus" missing "installing Incus integration"
  if apt-cache show incus >/dev/null 2>&1; then
    if apt-get install -y incus; then :; else
      echo -e "${YELLOW}[Optional] Incus installation failed; VM/container integration may be unavailable.${RESET}"
      return 0
    fi
  else
    mkdir -p /etc/apt/keyrings
    if curl -fsSL https://pkgs.zabbly.com/key.asc -o /etc/apt/keyrings/zabbly.asc; then
      local codename
      codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-}")"
      if [[ -n "$codename" ]]; then
        echo "deb [signed-by=/etc/apt/keyrings/zabbly.asc] https://pkgs.zabbly.com/incus/stable ${codename} main" > /etc/apt/sources.list.d/zabbly-incus-stable.list
        apt-get update -y || true
        apt-get install -y incus || echo -e "${YELLOW}[Optional] Incus could not be installed; VM integration may be unavailable.${RESET}"
      else
        echo -e "${YELLOW}[Optional] Could not detect Debian/Ubuntu codename for Incus repository.${RESET}"
      fi
    else
      echo -e "${YELLOW}[Optional] Could not download Incus repository key; skipping Incus.${RESET}"
    fi
  fi
  if command_exists incus; then
    systemctl enable --now incus 2>/dev/null || true
    incus admin init --auto 2>/dev/null || true
    show_check "Incus" ok "installed"
  fi
}

check_and_install_dependencies() {
  echo -e "\n${PURPLE}========== SMART DEPENDENCY CHECKER ==========${RESET}"
  if ! command_exists apt-get; then
    echo -e "${RED}[Unsupported OS] This installer currently supports Ubuntu/Debian systems with apt.${RESET}"
    return 1
  fi
  if [[ -r /etc/os-release ]]; then
    . /etc/os-release
    case "${ID:-} ${ID_LIKE:-}" in
      *ubuntu*|*debian*) echo -e "${GREEN}[OK]${RESET} Operating system: ${PRETTY_NAME:-Ubuntu/Debian}" ;;
      *) echo -e "${YELLOW}[Warning] OS is not explicitly supported. Continuing because apt is available.${RESET}" ;;
    esac
  fi

  echo -e "${CYAN}[Checker] Refreshing package lists...${RESET}"
  if ! apt-get update -y; then
    echo -e "${RED}[Dependency Error] apt package index update failed. Check VPS internet/DNS and apt sources, then retry.${RESET}"
    return 1
  fi

  local packages=(curl wget git ca-certificates gnupg lsb-release sqlite3 build-essential python3 make g++ rsync tar openssl)
  local missing_packages=()
  local package
  for package in "${packages[@]}"; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
      show_check "$package" ok
    else
      show_check "$package" missing
      missing_packages+=("$package")
    fi
  done

  if ((${#missing_packages[@]})); then
    echo -e "${CYAN}[Checker] Installing missing system packages: ${missing_packages[*]}${RESET}"
    if ! apt-get install -y "${missing_packages[@]}"; then
      echo -e "${RED}[Dependency Error] Could not install required packages: ${missing_packages[*]}. See apt output above.${RESET}"
      return 1
    fi
  else
    echo -e "${GREEN}[Checker] All base system packages are already installed.${RESET}"
  fi

  ensure_node_runtime || return 1
  ensure_docker
  ensure_incus
  echo -e "${GREEN}[Checker] Dependency scan complete.${RESET}\n"
}

install_system_packages() {
  check_and_install_dependencies
}

fetch_github_source() {
  ensure_fetch_tools
  echo -e "${CYAN}[Fetch] Downloading FB BAHI Panel (${BRANCH}) from GitHub...${RESET}"

  local fetched=0
  if [[ -d "${TMP_SRC_DIR}/.git" ]]; then
    if git -C "${TMP_SRC_DIR}" remote get-url origin 2>/dev/null | grep -qF "${REPO_URL}"; then
      if git -C "${TMP_SRC_DIR}" fetch --depth 1 origin "${BRANCH}" && \
         git -C "${TMP_SRC_DIR}" checkout -f "${BRANCH}" && \
         git -C "${TMP_SRC_DIR}" reset --hard "origin/${BRANCH}"; then
        fetched=1
      fi
    fi
  fi

  if [[ "${fetched}" -eq 0 ]]; then
    rm -rf "${TMP_SRC_DIR}"
    if git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${TMP_SRC_DIR}"; then
      fetched=1
    else
      echo -e "${YELLOW}[Fetch] git clone failed; trying GitHub tarball fallback...${RESET}"
      rm -rf "${TMP_SRC_DIR}" "${TMP_TARBALL}"
      mkdir -p "${TMP_SRC_DIR}"
      if curl -fsSL "${TARBALL_URL}" -o "${TMP_TARBALL}" && \
         tar -xzf "${TMP_TARBALL}" --strip-components=1 -C "${TMP_SRC_DIR}"; then
        fetched=1
      fi
      rm -f "${TMP_TARBALL}"
    fi
  fi

  if [[ "${fetched}" -ne 1 ]]; then
    echo -e "${RED}[Error] Failed to download FB BAHI Panel source from ${REPO_URL} (${BRANCH}).${RESET}"
    cleanup_staging
    return 1
  fi

  if [[ ! -f "${TMP_SRC_DIR}/package.json" ]]; then
    echo -e "${RED}[Error] Downloaded source is missing package.json (${TMP_SRC_DIR}/package.json).${RESET}"
    cleanup_staging
    return 1
  fi

  if [[ ! -f "${TMP_SRC_DIR}/server.js" ]]; then
    if [[ -f "${TMP_SRC_DIR}/server.ts" ]]; then
      echo -e "${YELLOW}[Notice] server.js not prebuilt in repository; will compile from server.ts during deployment.${RESET}"
    else
      echo -e "${RED}[Error] Downloaded source is missing server.js (${TMP_SRC_DIR}/server.js).${RESET}"
      cleanup_staging
      return 1
    fi
  fi

  echo -e "${GREEN}[OK] Verified source repository in ${TMP_SRC_DIR}.${RESET}"
}

deploy_application_files() {
  fetch_github_source
  ensure_node_runtime

  echo -e "${CYAN}[5/5] Deploying panel files to ${INSTALL_DIR}...${RESET}"
  mkdir -p \
    "${INSTALL_DIR}" \
    "${INSTALL_DIR}/data/servers/mc" \
    "${INSTALL_DIR}/data/servers/vm-backups" \
    "${INSTALL_DIR}/uploads/backgrounds" \
    "${INSTALL_DIR}/backups"

  rsync -a --delete \
    --exclude 'node_modules' \
    --exclude 'data' \
    --exclude 'uploads' \
    --exclude 'backups' \
    --exclude 'database.sqlite*' \
    --exclude '*.db*' \
    --exclude '.env' \
    --exclude '.git' \
    "${TMP_SRC_DIR}/" "${INSTALL_DIR}/"

  if [[ ! -f "${INSTALL_DIR}/package.json" ]]; then
    echo -e "${RED}[Error] ${INSTALL_DIR}/package.json is missing after sync. Aborting.${RESET}"
    cleanup_staging
    return 1
  fi

  if [[ ! -f "${INSTALL_DIR}/.env" ]]; then
    local jwt_secret
    jwt_secret="$(openssl rand -hex 32)"
    cat > "${INSTALL_DIR}/.env" <<EOF
NODE_ENV=production
PORT=${PANEL_PORT}
DB_PATH=${INSTALL_DIR}/data/panel.db
DATA_DIR=${INSTALL_DIR}/data/servers
DOCKER_SOCKET=/var/run/docker.sock
JWT_SECRET=${jwt_secret}
EOF
    chmod 600 "${INSTALL_DIR}/.env"
  else
    if grep -q '^PORT=' "${INSTALL_DIR}/.env"; then
      sed -i "s/^PORT=.*/PORT=${PANEL_PORT}/" "${INSTALL_DIR}/.env"
    else
      echo "PORT=${PANEL_PORT}" >> "${INSTALL_DIR}/.env"
    fi
  fi

  cd "${INSTALL_DIR}"
  local npm_log="${INSTALL_DIR}/install-npm.log"
  if [[ -f "${INSTALL_DIR}/server.js" && -f "${INSTALL_DIR}/dist/index.html" ]]; then
    echo -e "${CYAN}[NPM] Installing production dependencies (--omit=dev)...${RESET}"
    if ! npm install --omit=dev --no-audit --no-fund 2>&1 | tee "${npm_log}"; then
      echo -e "${RED}[Install Error] NPM dependency installation failed.${RESET}"
      echo -e "${YELLOW}Log saved at: ${npm_log}${RESET}"
      echo -e "${YELLOW}Check network/DNS, npm registry access and package compatibility, then retry Update.${RESET}"
      return 1
    fi
  else
    echo -e "${CYAN}[Build] Installing dependencies and compiling the panel...${RESET}"
    if ! npm install --no-audit --no-fund 2>&1 | tee "${npm_log}"; then
      echo -e "${RED}[Install Error] NPM dependency installation failed.${RESET}"
      echo -e "${YELLOW}Log saved at: ${npm_log}${RESET}"
      return 1
    fi
    if ! npm run build 2>&1 | tee -a "${npm_log}"; then
      echo -e "${RED}[Build Error] Panel build failed. Full output: ${npm_log}${RESET}"
      echo -e "${YELLOW}The installer checked system dependencies first. Review the final 60 log lines:${RESET}"
      tail -n 60 "${npm_log}" || true
      return 1
    fi
  fi

  if [[ ! -f "${INSTALL_DIR}/server.js" ]]; then
    echo -e "${RED}[Error] ${INSTALL_DIR}/server.js missing after deployment.${RESET}"
    cleanup_staging
    return 1
  fi

  cleanup_staging
}

configure_firewall_port() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    echo -e "${CYAN}[Firewall] Allowing port ${PANEL_PORT}/tcp in UFW...${RESET}"
    ufw allow "${PANEL_PORT}/tcp" >/dev/null 2>&1 || true
  fi
}

detect_public_ip() {
  local pub_ip=""
  pub_ip="$(curl -4 -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
  if [[ -z "${pub_ip}" ]]; then
    pub_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  echo "${pub_ip:-127.0.0.1}"
}

verify_panel_live() {
  local live=0
  local i
  for i in $(seq 1 15); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${PANEL_PORT}/api/auth/status" >/dev/null 2>&1; then
      live=1
      break
    fi
    sleep 1
  done

  local public_ip
  public_ip="$(detect_public_ip)"

  if [[ "${live}" -eq 1 ]]; then
    echo -e "\n${GREEN}[LIVE] FB BAHI Panel is listening on port ${PANEL_PORT}!${RESET}"
    echo -e "${GREEN}       Open: http://${public_ip}:${PANEL_PORT}${RESET}"
  else
    echo -e "\n${YELLOW}[Warning] Service started, but port ${PANEL_PORT} did not respond within 15s.${RESET}"
    echo -e "${YELLOW}          Check logs with: journalctl -u ${SERVICE_NAME} -n 50 --no-pager${RESET}"
    echo -e "${CYAN}          Expected URL: http://${public_ip}:${PANEL_PORT}${RESET}"
  fi
}

write_systemd_service() {
  cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=FB BAHI Panel - Game Server & Cloud VM Control Panel
After=network.target docker.service incus.service
Wants=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
Environment=PORT=${PANEL_PORT}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=/usr/bin/node ${INSTALL_DIR}/server.js
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

  configure_firewall_port
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}"
  verify_panel_live
}

create_admin_interactive() {
  if [[ ! -f "${INSTALL_DIR}/create-admin.js" ]]; then
    echo -e "${RED}[Error] Panel is not installed in ${INSTALL_DIR} (missing create-admin.js).${RESET}"
    return 1
  fi

  echo -e "\n${CYAN}--- Create / Update Owner/Admin User ---${RESET}"
  read -rp "Username: " admin_user
  read -rp "Email: " admin_email
  read -rsp "Password (hidden, min 8 chars): " admin_pass
  echo ""

  if [[ -z "${admin_user}" || -z "${admin_email}" || -z "${admin_pass}" ]]; then
    echo -e "${RED}[Error] All fields are required.${RESET}"
    return 1
  fi

  cd "${INSTALL_DIR}"
  if [[ -f "${INSTALL_DIR}/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "${INSTALL_DIR}/.env"
    set +a
  fi
  DB_PATH="${DB_PATH:-${INSTALL_DIR}/data/panel.db}" node "${INSTALL_DIR}/create-admin.js" "${admin_user}" "${admin_email}" "${admin_pass}"
  echo -e "${GREEN}[OK] Admin user saved.${RESET}"
}

action_install() {
  install_system_packages
  deploy_application_files
  write_systemd_service
  read -rp "Create the first Owner/Admin user now? [Y/n]: " create_now
  if [[ ! "${create_now}" =~ ^[Nn]$ ]]; then
    create_admin_interactive || true
  fi
}

action_reinstall() {
  echo -e "${YELLOW}[Reinstall] Stopping ${SERVICE_NAME}...${RESET}"
  systemctl stop "${SERVICE_NAME}" 2>/dev/null || true

  if [[ -f "${INSTALL_DIR}/data/panel.db" || -f "${INSTALL_DIR}/database.sqlite" ]]; then
    read -rp "Back up existing SQLite database before reinstalling? [Y/n]: " do_backup
    if [[ ! "${do_backup}" =~ ^[Nn]$ ]]; then
      mkdir -p "${BACKUP_DIR}"
      local stamp
      stamp="$(date +%Y%m%d-%H%M%S)"
      if [[ -f "${INSTALL_DIR}/data/panel.db" ]]; then
        cp -a "${INSTALL_DIR}/data/panel.db" "${BACKUP_DIR}/panel-${stamp}.db"
        echo -e "${GREEN}[OK] Database backed up to ${BACKUP_DIR}/panel-${stamp}.db${RESET}"
      fi
      if [[ -f "${INSTALL_DIR}/database.sqlite" ]]; then
        cp -a "${INSTALL_DIR}/database.sqlite" "${BACKUP_DIR}/database-${stamp}.sqlite"
        echo -e "${GREEN}[OK] Legacy database backed up to ${BACKUP_DIR}/database-${stamp}.sqlite${RESET}"
      fi
    fi
  fi

  check_and_install_dependencies
  deploy_application_files
  write_systemd_service
  echo -e "${GREEN}[Success] FB BAHI Panel reinstalled and restarted.${RESET}"
}

action_uninstall() {
  read -rp "Are you sure you want to completely uninstall FB BAHI Panel? [y/N]: " confirm
  if [[ ! "${confirm}" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Uninstall cancelled.${RESET}"
    return 0
  fi

  systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
  systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
  rm -f "${SERVICE_FILE}"
  systemctl daemon-reload
  rm -rf "${INSTALL_DIR}"
  cleanup_staging
  echo -e "${GREEN}[Success] FB BAHI Panel and systemd service removed cleanly.${RESET}"
}

action_update() {
  if [[ ! -d "${INSTALL_DIR}" ]]; then
    echo -e "${RED}[Error] Panel is not installed in ${INSTALL_DIR}.${RESET}"
    return 1
  fi

  echo -e "${CYAN}[Update] Fetching latest updates from GitHub (${BRANCH}) while preserving DB & .env...${RESET}"
  check_and_install_dependencies
  deploy_application_files
  write_systemd_service
  echo -e "${GREEN}[Success] FB BAHI Panel updated and restarted.${RESET}"
}

if [[ ! -t 0 ]] && [[ -r /dev/tty ]]; then
  exec < /dev/tty
fi

while true; do
  print_banner
  echo -e "  ${CYAN}[1]${RESET} Install panel"
  echo -e "  ${CYAN}[2]${RESET} Reinstall panel"
  echo -e "  ${CYAN}[3]${RESET} Uninstall panel"
  echo -e "  ${CYAN}[4]${RESET} Update panel"
  echo -e "  ${CYAN}[5]${RESET} Create owner/admin user"
  echo -e "  ${CYAN}[6]${RESET} Exit"
  echo ""
  read -rp "  Select [1 - 6]-> " choice

  case "${choice}" in
    1) action_install ;;
    2) action_reinstall ;;
    3) action_uninstall ;;
    4) action_update ;;
    5) create_admin_interactive ;;
    6)
      echo -e "${PURPLE}Goodbye from FB BAHI Panel!${RESET}"
      exit 0
      ;;
    *)
      echo -e "${RED}Invalid option. Please choose 1-6.${RESET}"
      ;;
  esac

  echo ""
  read -rp "Press Enter to return to menu..." _pause
done
