# JARVIS na nuvem — servidor + Raspberry Pi

Guia pra sair do JARVIS-no-Windows pro JARVIS-em-todo-lugar.

## A arquitetura, e por que ela é assim

```
  Pi Zero 2 W              ☁ VPS                    PC Windows
  ───────────────          ─────────────────        ──────────────
  grava o áudio      →     Whisper (Groq)           (etapa 2)
  toca a resposta    ←     router + LLM             agente conectado
                           Piper (voz)              as 69 tools de máquina
                           memória, estado
                                 ↑
                            App do celular
```

**Por que o Pi não pensa:** ele tem 512 MB de RAM. O modelo `small` do whisper
ocupa 488 MB só pra carregar, e o `tiny` que caberia erra demais em português.
Sintetizar voz nele leva segundos; no servidor leva milissegundos. Então o Pi
grava e toca — só isso, e é o que ele faz bem.

**O que isso custa:** o áudio passa a sair de casa. Na versão Windows ele nunca
saía. Em troca, a transcrição fica melhor do que a que rodava local.

**O que fica de fora por enquanto:** 69 das 99 tools controlam o PC (abrir apps,
ler GPU, arquivos, screenshots). O servidor carrega só as 30 que rodam em
qualquer lugar. As outras voltam quando o agente do PC existir — e o registro já
sabe separar as duas famílias (`platform: 'win32'` na skill).

## 1. O servidor (VPS)

Qualquer VPS de 1 GB serve. Oracle Free Tier é gratuito pra sempre; Hetzner sai
~€4/mês.

```bash
# Node 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

git clone <seu-repo> /opt/jarvis && cd /opt/jarvis
npm install --omit=dev
```

Voz do servidor. Duas opções — o ElevenLabs é pago e melhor, o Piper é grátis
e local. Configurando os dois, o Piper vira a rede de segurança pra quando a
cota do mês acabar:

```
ELEVENLABS_API_KEY=sua-chave
ELEVENLABS_VOICE_ID=id-da-voz     # npm run voices:eleven
```

E/ou o Piper (grátis, roda no próprio VPS):

```bash
sudo mkdir -p /opt/piper && cd /opt/piper
# binário Linux do Piper + a mesma voz que você já usa no Windows
sudo curl -LO https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
sudo tar xzf piper_linux_x86_64.tar.gz
sudo curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx
sudo curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx.json
```

`/opt/jarvis/.env`:

```
JARVIS_CLOUD_TOKEN=       # gere um forte; é o único portão do servidor
ANTHROPIC_API_KEY=
GROQ_API_KEY=             # gratuito, só pro Whisper
LLM_PROVIDER=anthropic
JARVIS_MODEL=claude-haiku-4-5
PIPER_BIN=/opt/piper/piper/piper
PIPER_VOICE=/opt/piper/pt_BR-faber-medium.onnx
```

```bash
npm run cloud     # confere tudo e diz o que falta antes de subir
```

Como serviço, em `/etc/systemd/system/jarvis.service`:

```ini
[Unit]
Description=JARVIS
After=network.target

[Service]
WorkingDirectory=/opt/jarvis
ExecStart=/usr/bin/npm run cloud
Restart=always
User=jarvis

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now jarvis
curl http://localhost:8080/saude
```

**HTTPS:** ponha um Caddy na frente (`jarvis.seudominio.com { reverse_proxy
localhost:8080 }`) ou use um Cloudflare Tunnel. O token viaja em texto puro sem
TLS, e ele é a chave de tudo.

## 2. O Raspberry Pi

Pi Zero 2 W + um microfone USB + uma caixinha (P2 ou USB).

```bash
sudo apt install -y python3-pyaudio alsa-utils python3-requests
sudo mkdir -p /opt/jarvis-pi
sudo cp jarvis-pi.py /opt/jarvis-pi/
```

`/etc/jarvis.env`:

```
JARVIS_CLOUD_URL=https://jarvis.seudominio.com
JARVIS_CLOUD_TOKEN=o-mesmo-token-do-servidor
JARVIS_BOTAO_GPIO=17          # opcional; sem isso, Enter no terminal dispara
```

Teste antes de virar serviço:

```bash
python3 /opt/jarvis-pi/jarvis-pi.py
```

Aperte Enter, fale, solte. Deve aparecer `[voce]`, `[jarvis]` e sair som.

Como serviço, em `/etc/systemd/system/jarvis-pi.service`:

```ini
[Unit]
Description=JARVIS Pi
After=network-online.target sound.target

[Service]
ExecStart=/usr/bin/python3 /opt/jarvis-pi/jarvis-pi.py
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

**Botão em vez de wake word, de propósito.** Porcupine roda no Pi, mas escutar
o tempo todo consome CPU numa placa que tem pouca, e um botão nunca dispara
sozinho com a TV ligada. Wake word é fácil de acrescentar depois.

## Problemas comuns

| sintoma | causa |
|---|---|
| `401` em tudo | token diferente entre `/etc/jarvis.env` e o `.env` do servidor |
| responde texto, não sai som | nenhuma voz configurada — confira `ELEVENLABS_*` ou `PIPER_VOICE` |
| som só no Pi não sai, mas o servidor diz que falou | falta `mpg123` no Pi (o ElevenLabs manda MP3): `sudo apt install mpg123` |
| `nao captei fala` sempre | microfone errado; veja com `arecord -l` e ajuste o `default` no `.asoundrc` |
| corta no meio da frase | aumente `SILENCIO_MS` no `jarvis-pi.py` |
| demora muito | veja se o VPS está longe de você; a viagem do áudio domina a latência |
