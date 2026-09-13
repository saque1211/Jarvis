#!/usr/bin/env bash
#
# Poe o HUD na TELA do proprio Raspberry.
#
# O `npm run hud` ja SERVE a pagina — o que falta no Raspberry Pi OS Lite e
# alguem pra OLHAR: Lite nao tem desktop nem navegador. Por isso o log diz
# "Nenhum Chrome/Edge/Brave encontrado". Este script instala o minimo pra
# desenhar numa tela HDMI e nada alem disso.
#
# Minimo de proposito: sem gerenciador de janelas, sem barra de tarefas, sem
# ambiente de desktop. Num Pi 3 de 1 GB, cada peca dessas e memoria que o
# Chromium vai querer depois. X + Chromium em modo quiosque e so isso.
#
#   bash ~/jarvis/pi/kiosk.sh
#
# Depois: `sudo systemctl start vexis-kiosk` (ou so reiniciar).

set -euo pipefail

USUARIO="${SUDO_USER:-$USER}"
CASA="$(getent passwd "$USUARIO" | cut -d: -f6)"
ENDERECO="${1:-http://localhost:8791}"

echo "== HUD na tela do Pi =="
echo "   usuario: $USUARIO"
echo "   pagina:  $ENDERECO"
echo

# --- 1. O minimo pra ter tela -------------------------------------------------
# xserver-xorg + xinit: a tela. x11-xserver-utils: o `xset` que desliga o
# protetor de tela. unclutter: some com o ponteiro do mouse, que num painel de
# parede so atrapalha.
echo "-- instalando (demora alguns minutos no Pi 3)"
sudo apt update
sudo apt install -y --no-install-recommends \
  xserver-xorg xinit x11-xserver-utils unclutter

# O pacote do Chromium mudou de nome entre as versoes do Raspberry Pi OS.
if apt-cache show chromium >/dev/null 2>&1; then
  NAVEGADOR_PKG=chromium
else
  NAVEGADOR_PKG=chromium-browser
fi
sudo apt install -y --no-install-recommends "$NAVEGADOR_PKG"
NAVEGADOR="$(command -v chromium || command -v chromium-browser)"
echo "-- navegador: $NAVEGADOR"

# --- 2. O que roda quando a tela sobe -----------------------------------------
# As flags nao sao enfeite: cada uma tira uma coisa que aparece na tela de
# parede e nao deveria (barra de "restaurar paginas", dialogo de erro, aviso de
# atualizacao) ou economiza memoria num aparelho de 1 GB.
#
# `Translate` alem de `TranslateUI`: sem os dois o Chromium abre a faixa
# "Portuguese / English" por cima do painel — a pagina e em portugues, mas o
# idioma do sistema esta em ingles e ele oferece traduzir. `--lang=pt-BR`
# resolve a causa; a flag resolve o sintoma. Vao os dois.
cat > "$CASA/.xinitrc" <<EOF
#!/bin/sh
# Painel de parede nao dorme.
xset s off
xset -dpms
xset s noblank

# Ponteiro some sozinho.
unclutter -idle 0.1 -root &

exec $NAVEGADOR \\
  --kiosk "$ENDERECO" \\
  --noerrdialogs \\
  --disable-infobars \\
  --disable-session-crashed-bubble \\
  --disable-features=Translate,TranslateUI \\
  --lang=pt-BR \\
  --no-first-run \\
  --check-for-update-interval=31536000 \\
  --autoplay-policy=no-user-gesture-required \\
  --disable-pinch \\
  --overscroll-history-navigation=0
EOF
chmod +x "$CASA/.xinitrc"
chown "$USUARIO" "$CASA/.xinitrc"

# Sem isso o X so deixa o root iniciar sessao pelo systemd.
sudo tee /etc/X11/Xwrapper.config > /dev/null <<'EOF'
allowed_users=anybody
needs_root_rights=yes
EOF

# --- 3. Sobe junto com a maquina ----------------------------------------------
# Depende do jarvis-hud: sem a pagina no ar o Chromium abriria numa tela de
# erro. `Restart=always` porque um painel de parede que morreu e um painel
# apagado — ninguem esta la pra reiniciar na mao.
sudo tee /etc/systemd/system/vexis-kiosk.service > /dev/null <<EOF
[Unit]
Description=VEXIS HUD na tela (quiosque)
After=jarvis-hud.service systemd-user-sessions.service
Wants=jarvis-hud.service

[Service]
User=$USUARIO
PAMName=login
TTYPath=/dev/tty1
StandardInput=tty
StandardOutput=journal
StandardError=journal
UtmpIdentifier=tty1
Environment=XDG_RUNTIME_DIR=/run/user/%U
ExecStart=/usr/bin/startx -- -nocursor
Restart=always
RestartSec=5
# O startx nao morre no SIGTERM. Sem isto o systemd espera os 90s padrao antes
# de matar a forca — e durante esse minuto e meio a tela volta pro console,
# acumulando mensagem de kernel. Quem esta olhando o painel ve o VEXIS sumir e
# aparecer texto de terminal, e conclui que travou.
TimeoutStopSec=10
KillMode=mixed

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable vexis-kiosk

echo
echo "Pronto. Com a tela ligada no HDMI:"
echo "   sudo systemctl start vexis-kiosk"
echo
echo "Sobe sozinho no boot daqui pra frente."
echo "Pra parar de vez:  sudo systemctl disable --now vexis-kiosk"
