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
```

### O login persistente (é aqui que trava)

Um librespot que só está *descobrível* aparece no seletor do app do celular,
mas é **invisível pra API** — e é a API que o VEXIS usa. Então "tocar sem app
aberto" depende de o Pi estar **logado**, não só anunciado.

O login pede um navegador, e o Pi não tem. A saída é um túnel SSH pela porta do
OAuth — **sem ele a autorização morre na volta**, porque o Spotify manda o
navegador pra `127.0.0.1:5588`, que no PC é o PC:

```powershell
ssh -L 5588:localhost:5588 vexis@vexis.local
```

Aí, no Pi:
```bash
sudo systemctl stop raspotify
sudo librespot --name Vexis --backend alsa --system-cache /var/lib/raspotify --enable-oauth --oauth-port 5588
```
Abre o link impresso no navegador do PC e autoriza. Quando aparecer
`Authenticated as '...'`, `Ctrl+C`. Deve existir
`/var/lib/raspotify/credentials.json`.

### Três linhas do `/etc/raspotify/conf` que decidem tudo

O arquivo vem com flags **ligadas de fábrica**, e no formato dele
*variável descomentada com valor vazio = flag ligada*. Duas atrapalham:

```bash
# 1. Esta faz o librespot IGNORAR o credentials.json que você acabou de criar.
#    Sintoma: "Credentials are required if discovery and oauth login are
#    disabled" em loop, com o arquivo existindo ali do lado.
sudo sed -i 's/^LIBRESPOT_DISABLE_CREDENTIAL_CACHE=/#&/' /etc/raspotify/conf

# 2. Saída de áudio: o raspotify roda como root e não herda o seu ~/.asoundrc.
#    Com a TV no HDMI, o som vai pra TV. `aplay -l` mostra os cards;
#    card 0 costuma ser o P2 (Headphones) e card 1 o HDMI.
echo 'LIBRESPOT_DEVICE="plughw:0,0"' | sudo tee -a /etc/raspotify/conf

# 3. O librespot tem volume PRÓPRIO, separado do ALSA, e começa baixo.
#    Sem isto o painel volta mudo a cada reboot e parece quebrado.
echo 'LIBRESPOT_INITIAL_VOLUME="80"' | sudo tee -a /etc/raspotify/conf

echo 'LIBRESPOT_NAME="Vexis"' | sudo tee -a /etc/raspotify/conf
sudo systemctl restart raspotify
```

> `LIBRESPOT_QUIET=` também vem ligada: o serviço sobe **sem imprimir nada**,
> nem o `Authenticated as`. Silêncio no log não quer dizer que falhou — o que
> importa é não haver `Main process exited`.

Confere:
```bash
cd ~/jarvis && npm run jarvis "quais aparelhos do spotify estão disponíveis"
```
Tem que listar **Vexis**. (precisa Spotify **Premium**)

Com o raspotify de pé, o painel é um aparelho Spotify permanente — e o VEXIS
assume ele sozinho quando ninguém está tocando nada. O `SPOTIFY_DEVICE` no
`.env` escolhe qual aparelho ele prefere (padrão: o que tiver "vexis" no nome).

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
> **Mic USB quase nunca aceita 16 kHz** (só entrega 44.1/48). O cliente já
> resolve sozinho: tenta o dispositivo pedido, depois o `default` do ALSA, e
> por último abre na taxa nativa e reamostra. Não precisa configurar nada.
>
> Se ainda assim quiser mandar o `default` do sistema pro mic — útil pra
> `arecord` e outros programas — escreva `~/.asoundrc` **por nome, nunca por
> número**: o card do USB troca de posição a cada boot, e um painel de parede
> reinicia sozinho depois de queda de luz.
> ```
> pcm.!default {
>   type asym
>   playback.pcm "plughw:CARD=Headphones,DEV=0"
>   capture.pcm  "plughw:CARD=Device,DEV=0"
> }
> ctl.!default { type hw card Headphones }
> ```
> Os nomes saem de `aplay -l` e `arecord -l`. E confira o dono do arquivo: um
> `~/.asoundrc` criado com `sudo` fica do root e o programa nem consegue lê-lo.

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

## 9. O HUD na tela do próprio Pi (kiosk)

O `npm run hud` **serve** a página, mas o Raspberry Pi OS Lite não tem desktop
nem navegador — por isso o log diz *"Nenhum Chrome/Edge/Brave encontrado"*. O
servidor está certo; falta quem olhe. Um script resolve:

```bash
bash ~/jarvis/pi/kiosk.sh
```

Instala o mínimo (X + Chromium, sem desktop nem barra de tarefas — num Pi de
1 GB cada peça dessas é memória que falta depois), escreve o `.xinitrc` e cria
o serviço `vexis-kiosk`, que sobe no boot.

Com a tela ligada no HDMI:
```bash
sudo systemctl start vexis-kiosk
```

Por padrão abre o HUD aberto (`http://localhost:8791`). Pra abrir a versão com
conta e pareamento, passa o endereço:
```bash
bash ~/jarvis/pi/kiosk.sh http://localhost:3000/
```
Aí ele mostra o código de 6 dígitos → aprova no app → HUD na telinha.

**Não use `--incognito`**: ele apaga o pareamento a cada boot, e o painel volta
pedindo código toda vez que falta luz.

### Numa TV grande o desenho parece pequeno

É esperado: o palco de 1920x1080 foi pensado pra uma tela de 7" a um metro. Na
TV a proporção está certa, mas quem passa longe acha tudo miúdo. `?zoom=` amplia:

```bash
bash ~/jarvis/pi/kiosk.sh 'http://localhost:8791/?zoom=1.4'
sudo systemctl restart vexis-kiosk
```

Aceita de `0.5` a `3`. Acima de `1` o que passar da borda é cortado — e o que
sobra na borda é justamente o vazio que o painel tem de propósito.

### Folga de memória (1 GB)

Chromium num Pi 3 com três serviços Node do lado fica no limite. Dobrar a
memória virtual evita que o navegador seja morto no meio do dia:

```bash
sudo dphys-swapfile swapoff
sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
sudo dphys-swapfile setup && sudo dphys-swapfile swapon
```

Se ainda ficar apertado, o caminho é tirar peso em vez de otimizar o navegador:
rode o **nucleus e o cérebro num VPS** e deixe no Pi só o HUD, o kiosk e a voz.

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
- **O card do mic USB muda de número entre boots** → no `~/.asoundrc` use
  `CARD=<nome>`, não `hw:2,0`.
- **Trocar de tela no kiosk demora 90s** se o serviço não tiver
  `TimeoutStopSec` — o `startx` ignora o SIGTERM e o painel fica no console
  esperando. O `pi/kiosk.sh` já resolve; serviço escrito à mão, não.
- **raspotify ignora o `credentials.json`** por causa do
  `LIBRESPOT_DISABLE_CREDENTIAL_CACHE=` que vem ligado → comente a linha.
- **OAuth do librespot precisa de túnel na 5588**, senão a autorização volta
  pro seu PC e se perde.
- **Pi OS Lite não tem navegador** → o HUD serve a página mas nada aparece na
  tela do Pi até rodar o `pi/kiosk.sh` (passo 9).
- **entity_id do Home Assistant é críptico** (ex: `climate.150633..._climate`),
  não o nome amigável → a skill lista antes; se errar, confira o ID real no HA.
