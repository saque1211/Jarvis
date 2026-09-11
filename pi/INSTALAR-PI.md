# Instalar o VEXIS no Raspberry Pi

Checklist de ponta a ponta pra subir o VEXIS num Raspberry Pi (testado no
caminho pro 3 B+, 1 GB). Foi montado com o que funcionou na prática — os
tropeços já estão contornados aqui.

**Ideia geral:** o Pi é leve. A transcrição (Whisper) roda no **Groq** (nuvem,
de graça), não no Pi. O Pi só ouve a palavra "vexis" (openWakeWord, leve),
grava, manda pro cérebro e toca a resposta. Cabe em 1 GB.

---

## 0. O que você precisa

- Raspberry Pi + **cartão microSD** (8 GB+). **Pendrive não presta** pra boot no
  3 B+ — muitos não bootam. microSD boota de primeira.
- Fonte de **5V / 2,5A** (2A liga, mas 2,5A dá folga pro USB)
- Mic **USB**
- (Depois) tela de 7" pra o HUD — não precisa agora, a voz é toda por SSH

---

## 1. Gravar o cartão (Raspberry Pi Imager, no PC)

1. Abre o **Raspberry Pi Imager** (raspberrypi.com/software)
2. **Dispositivo:** Raspberry Pi 3
3. **SO:** "Raspberry Pi OS (other)" → **Raspberry Pi OS Lite (64-bit)**
4. **Armazenamento:** o microSD
5. **Editar configurações** (a engrenagem, ANTES de gravar):
   - **Geral:** hostname `vexis` · usuário `vexis` + senha (ANOTA) · Wi-Fi
     (SSID + senha + país **BR**) · fuso `America/Sao_Paulo`
   - **Serviços:** **Ativar SSH** → autenticação por palavra-passe
   - Raspberry Pi Connect: **off** (economiza RAM)
6. **Gravar** (deixa VERIFICAR no fim)

## 2. Ligar e entrar por SSH

1. Põe o microSD, pluga o mic, **pluga a fonte** (liga sozinho, sem botão)
2. LEDs: **vermelho fixo** = energia · **verde piscando** = bootando
3. Espera ~1-2 min. No PC (PowerShell):
   ```powershell
   ssh vexis@vexis.local
   ```
   (se `vexis.local` não achar, pega o IP no painel do roteador e usa ele)

## 3. Sistema + Node + projeto

```bash
sudo apt update && sudo apt upgrade -y
# Node 20+ (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git alsa-utils mpg123 espeak-ng \
  python3-pyaudio python3-venv python3-pip build-essential

cd ~
git clone https://github.com/saque1211/jarvis.git
cd jarvis
npm install
```

## 4. As chaves (.env)

Cria o `.env` (copia o do PC/VM, ou preenche à mão). O mínimo pra voz:

```bash
nano ~/jarvis/.env
```
```
# Cérebro (LLM). Groq aposentou o modelo velho — use Anthropic:
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Transcrição na nuvem (obrigatória, é de graça): console.groq.com/keys
GROQ_API_KEY=gsk_...

# Nome que aparece na fala/HUD
JARVIS_NOME=VEXIS

# Cérebro de voz (porta 8080) — token e endereço
JARVIS_CLOUD_TOKEN=<gere: openssl rand -base64 24 | tr -d '/+='>
JARVIS_CLOUD_URL=http://localhost:8080

# Voz: espeak-ng é o fallback automático (já instalado). Pra voz bonita:
# ELEVENLABS_API_KEY=...
# ELEVENLABS_VOICE_ID=...   (veja: npm run voices:eleven)

# Casa inteligente (opcional) — porta do Home Assistant é a que ele usa
# HOME_ASSISTANT_URL=http://IP_DO_HA
# HOME_ASSISTANT_TOKEN=...   (perfil → Tokens de Acesso de Longa Duração)
```

Gera o token do cérebro:
```bash
grep -q "^JARVIS_CLOUD_TOKEN=" .env || printf '\nJARVIS_CLOUD_TOKEN=%s\n' "$(openssl rand -base64 24 | tr -d '/+=')" >> .env
```

## 5. Serviços que ficam sempre no ar

Três processos: **nucleus** (contas/pareamento, :3000), **cérebro** (voz, :8080)
e **HUD** (:8791). Viram systemd pra subir no boot e sobreviver a reinício.

```bash
for S in nucleus cloud hud; do
  CMD="npm run $S"
  sudo tee /etc/systemd/system/jarvis-$S.service > /dev/null <<EOF
[Unit]
Description=Jarvis $S
After=network.target

[Service]
User=vexis
WorkingDirectory=/home/vexis/jarvis
ExecStart=/bin/bash -lc '$CMD'
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
done
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis-nucleus jarvis-cloud jarvis-hud
sleep 6
for S in nucleus cloud hud; do echo "$S: $(sudo systemctl is-active jarvis-$S)"; done
curl -s http://localhost:8080/saude; echo
```

`/saude` deve dar `{"ok":true,"tts":true}`. Os três `active`.

> Alternativa: rodar nucleus+cérebro num **VPS** e deixar só o HUD+voz no Pi.
> Aí aponta `JARVIS_NUCLEUS_URL`/`JARVIS_CLOUD_URL` pro endereço do VPS.

## 6. Spotify (raspotify)

```bash
curl -sSL https://dtcooper.github.io/raspotify/install.sh | sudo sh
echo 'LIBRESPOT_NAME="Vexis"' | sudo tee -a /etc/raspotify/conf
sudo systemctl restart raspotify
```
Login persistente (uma vez, pra tocar sem app aberto):
```bash
sudo systemctl stop raspotify
sudo librespot --name Vexis --backend alsa --system-cache /var/lib/raspotify --enable-oauth --oauth-port 5588
# abre a URL que ele imprime, autoriza; Ctrl+C quando salvar credentials.json
sudo systemctl start raspotify
```
(precisa Spotify **Premium**)

## 7. Voz: openWakeWord ("vexis")

```bash
python3 -m venv --system-site-packages ~/vexis-venv
~/vexis-venv/bin/pip install --upgrade pip
~/vexis-venv/bin/pip install requests
# openwakeword 0.6.0 exige tflite (sem wheel no ARM); usamos onnx, então --no-deps:
~/vexis-venv/bin/pip install --no-deps "openwakeword==0.6.0"
~/vexis-venv/bin/pip install onnxruntime numpy scipy tqdm scikit-learn
# baixa os modelos-base do openWakeWord:
~/vexis-venv/bin/python -c "import openwakeword.utils; openwakeword.utils.download_models()"
```

Acha o índice do mic:
```bash
~/vexis-venv/bin/python ~/jarvis/pi/jarvis-pi.py --mics
```
> Se o mic USB não capturar direto (só entrega 44.1/48kHz), cria um
> `~/.asoundrc` mandando o default pra ele via plug (troca o `1` pelo card do
> `arecord -l`):
> ```
> pcm.!default { type asym capture.pcm "plughw:1,0" playback.pcm "plughw:0,0" }
> ```

Roda o cliente (troca `<IDX>` pelo índice do mic; ou tira o `JARVIS_MIC` se usar
o asoundrc):
```bash
JARVIS_MIC=<IDX> JARVIS_NUCLEUS_URL=http://localhost:3000 \
JARVIS_CLOUD_URL=http://localhost:8080 JARVIS_TRIGGER=escuta WAKE_LIMIAR=0.4 \
~/vexis-venv/bin/python ~/jarvis/pi/jarvis-pi.py
```
Ele **fala um código de 6 dígitos** → no app (`http://IP_DO_PI:3000/app`) →
Ajustes → Parear painel → digita o código. Ele salva o token e passa a ouvir.

Fala **"vexis, como está o tempo"**. Debug do wake: `WAKE_DEBUG=1` mostra
`nivel` (mic) e `pontuacao` (0-1). Calibra o `WAKE_LIMIAR`:
- não acorda → baixa (0.4 → 0.3)
- acorda sozinho → sobe (0.4 → 0.5)

Quando estiver bom, vira serviço:
```bash
sudo tee /etc/systemd/system/vexis-voz.service > /dev/null <<'EOF'
[Unit]
Description=Vexis voz (openWakeWord)
After=network.target jarvis-cloud.service

[Service]
User=vexis
Environment=JARVIS_MIC=<IDX>
Environment=JARVIS_NUCLEUS_URL=http://localhost:3000
Environment=JARVIS_CLOUD_URL=http://localhost:8080
Environment=JARVIS_TRIGGER=escuta
Environment=WAKE_LIMIAR=0.4
ExecStart=/home/vexis/vexis-venv/bin/python /home/vexis/jarvis/pi/jarvis-pi.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now vexis-voz
```

## 8. Casa inteligente (opcional)

No **app → Ajustes → Casa inteligente**: cola o endereço do Home Assistant (a
porta que ele usa; nem sempre é 8123) e o token → "Testar e salvar". Depois:
"vexis, desliga o ar do quarto".

## 9. Quando a tela de 7" chegar: o HUD em kiosk

```bash
sudo apt install -y --no-install-recommends xserver-xorg xinit openbox chromium x11-xserver-utils
# autologin no tty1
sudo mkdir -p /etc/systemd/system/getty@tty1.service.d
sudo tee /etc/systemd/system/getty@tty1.service.d/autologin.conf > /dev/null <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin vexis --noclear %I $TERM
EOF
cat > ~/.bash_profile <<'EOF'
if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then exec startx; fi
EOF
cat > ~/.xinitrc <<'EOF'
#!/bin/sh
xset -dpms; xset s off; xset s noblank
openbox-session &
exec chromium --kiosk --noerrdialogs --disable-infobars \
  --disable-gpu --disable-dev-shm-usage \
  --check-for-update-interval=31536000 http://localhost:3000/
EOF
chmod +x ~/.xinitrc
sudo reboot
```
Liga → mostra o código de pareamento → aprova no app → HUD na telinha.
(NÃO use `--incognito`: ele apaga o pareamento a cada boot.)

---

## Armadilhas que já pegaram (pra não repetir)

- **Pendrive não boota** no 3 B+ → use microSD.
- **`Add-Content` do PowerShell cola linha no .env** → edite com `nano`, e rode
  `npm run env:check`.
- **Groq aposenta modelos** → se der "modelo não existe", troque `JARVIS_MODEL`
  ou use `LLM_PROVIDER=anthropic`.
- **openWakeWord 0.6.0 pede tflite (sem wheel ARM)** → `pip install --no-deps` +
  instale as deps na mão (passo 7).
- **Mic USB só entrega 44.1/48kHz** → `~/.asoundrc` com `plughw` (resample).
- **entity_id do Home Assistant é críptico** (ex: `climate.150633..._climate`),
  não o nome amigável → a skill lista antes; se errar, confira o ID real no HA.
