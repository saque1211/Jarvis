#!/usr/bin/env bash
#
# Instala o servidor de voz do JARVIS no VPS: liga o servico systemd (porta
# 8080) e, se voce pedir, baixa o Piper como voz gratis de reserva.
#
# A voz principal e o ElevenLabs (as chaves vao no /opt/jarvis/.env). O Piper
# so entra quando a cota do mes do ElevenLabs acaba — pra o Pi nunca ficar mudo.
#
# Rode NO SERVIDOR, depois de ter criado o /opt/jarvis/.env com as chaves:
#   sudo bash /opt/jarvis/deploy/setup-voz.sh              # so ElevenLabs
#   sudo bash /opt/jarvis/deploy/setup-voz.sh --piper      # + Piper de reserva
#
set -e

RAIZ=/opt/jarvis
PIPER_DIR=/opt/piper
PIPER_VER=2023.11.14-2
VOZ_BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium

echo "== 1. Conferindo o .env =="
if [ ! -f "$RAIZ/.env" ]; then
  echo "  FALTA $RAIZ/.env — crie antes com as chaves (veja o passo a passo)."
  exit 1
fi
for chave in GROQ_API_KEY ANTHROPIC_API_KEY JARVIS_CLOUD_TOKEN; do
  grep -q "^$chave=" "$RAIZ/.env" || echo "  AVISO: falta $chave no .env."
done
if ! grep -q "^ELEVENLABS_API_KEY=" "$RAIZ/.env" && [ "$1" != "--piper" ]; then
  echo "  AVISO: sem ELEVENLABS_API_KEY e sem --piper, o servidor responde so texto (sem voz)."
fi

if [ "$1" = "--piper" ]; then
  echo "== 2. Baixando o Piper (voz gratis de reserva) =="
  mkdir -p "$PIPER_DIR"; cd "$PIPER_DIR"
  if [ ! -x "$PIPER_DIR/piper/piper" ]; then
    curl -fsSL -o piper.tar.gz \
      "https://github.com/rhasspy/piper/releases/download/${PIPER_VER}/piper_linux_x86_64.tar.gz"
    tar xzf piper.tar.gz && rm -f piper.tar.gz
    echo "  Piper instalado."
  else
    echo "  Piper ja estava instalado."
  fi
  if [ ! -f "$PIPER_DIR/pt_BR-faber-medium.onnx" ]; then
    curl -fsSL -o "$PIPER_DIR/pt_BR-faber-medium.onnx" "$VOZ_BASE/pt_BR-faber-medium.onnx"
    curl -fsSL -o "$PIPER_DIR/pt_BR-faber-medium.onnx.json" "$VOZ_BASE/pt_BR-faber-medium.onnx.json"
    echo "  Voz baixada."
  fi
  grep -q "^PIPER_BIN=" "$RAIZ/.env" || echo "PIPER_BIN=$PIPER_DIR/piper/piper" >> "$RAIZ/.env"
  grep -q "^PIPER_VOICE=" "$RAIZ/.env" || echo "PIPER_VOICE=$PIPER_DIR/pt_BR-faber-medium.onnx" >> "$RAIZ/.env"
fi

echo "== 3. Instalando o servico systemd =="
cp "$RAIZ/deploy/jarvis-voz.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now jarvis-voz

sleep 2
echo "== 4. Teste de saude =="
if curl -fsS http://localhost:8080/saude; then
  echo ""
  echo "  Voz no ar na porta 8080."
else
  echo ""
  echo "  Nao respondeu. Veja o porque com:"
  echo "    journalctl -u jarvis-voz -n 30 --no-pager"
fi
