#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# FB BAHI Panel — Ubuntu (22.04/24.04) & Debian VPS Remote Installer & Manager
# Supports: bash <(curl -fsSL https://raw.githubusercontent.com/naitikvaidik689210609-ui/FB-panel/main/install.sh)
# ==============================================================================

REPO_URL="https://github.com/naitikvaidik689210609-ui/ahmp.git"
BRANCH="main"
TARBALL_URL="https://codeload.github.com/naitikvaidik689210609-ui/ahmp/tar.gz/refs/heads/${BRANCH}"

INSTALL_DIR="/opt/fbbahi-panel"
TMP_SRC_DIR="/tmp/fb-panel-src"
TMP_TARBALL="/tmp/fb-panel-src.tar.gz"
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
  echo -e "${RED}[Error] This installer must be run as root. Try: sudo bash <(curl -fsSL https://raw.githubusercontent.com/naitikvaidik689210609-ui/FB-panel/main/install.sh)${RESET}"
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

ensure_fetch_tools() {
  local need_apt=0
  local cmd
  for cmd in git curl tar rsync openssl; do
    if ! command -v "${cmd}" >/dev/null 2>&1; then
      need_apt=1
      break
    fi
  done

  if [[ "${need_apt}" -eq 1 ]]; then
    echo -e "${CYAN}[Prep] Installing required fetch tools (git, curl, tar, rsync, openssl)...${RESET}"
    apt-get update -y
    apt-get install -y curl wget git ca-certificates gnupg lsb-release tar rsync openssl
  fi
}

ensure_node_runtime() {
  if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 18 ]]; then
    echo -e "${CYAN}[Runtime] Installing Node.js 20.x LTS...${RESET}"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    echo -e "${GREEN}[OK] Node.js $(node -v) already installed.${RESET}"
  fi
}

install_system_packages() {
  echo -e "${CYAN}[1/5] Updating apt packages and installing prerequisites...${RESET}"
  apt-get update -y
  apt-get install -y curl wget git ca-certificates gnupg lsb-release sqlite3 build-essential python3 make g++ rsync tar openssl

  echo -e "${CYAN}[2/5] Checking Node.js runtime...${RESET}"
  ensure_node_runtime

  if ! command -v docker >/dev/null 2>&1; then
    echo -e "${CYAN}[3/5] Installing Docker Engine...${RESET}"
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
  else
    echo -e "${GREEN}[OK] Docker already installed.${RESET}"
    systemctl enable --now docker || true
  fi

  if ! command -v incus >/dev/null 2>&1; then
    echo -e "${CYAN}[4/5] Installing Incus (LXC & KVM Manager)...${RESET}"
    if apt-cache show incus >/dev/null 2>&1; then
      apt-get install -y incus
    else
      mkdir -p /etc/apt/keyrings
      curl -fsSL https://pkgs.zabbly.com/key.asc -o /etc/apt/keyrings/zabbly.asc
      local codename
      codename="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
      echo "deb [signed-by=/etc/apt/keyrings/zabbly.asc] https://pkgs.zabbly.com/incus/stable ${codename} main" > /etc/apt/sources.list.d/zabbly-incus-stable.list
      apt-get update -y
      apt-get install -y incus
    fi
    systemctl enable --now incus || true
    incus admin init --auto || true
  else
    echo -e "${GREEN}[OK] Incus already installed.${RESET}"
    systemctl enable --now incus || true
  fi
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
  if [[ -f "${INSTALL_DIR}/server.js" && -f "${INSTALL_DIR}/dist/index.html" ]]; then
    echo -e "${CYAN}[NPM] Installing production dependencies (--omit=dev)...${RESET}"
    npm install --omit=dev --no-audit --no-fund
  else
    echo -e "${CYAN}[Build] Prebuilt dist/server.js not found; installing build dependencies and compiling...${RESET}"
    npm install --no-audit --no-fund
    npm run build
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

  apt-get update -y
  apt-get install -y curl wget git ca-certificates sqlite3 build-essential python3 make g++ rsync tar openssl
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
