# Setup — passo a passo

Do zero até falar com a máquina. Tempo real: ~30 minutos, sendo 20 esperando
download de modelo.

---

## Pré-requisitos

- **Windows 11** (o `src/platform/win32.js` assume isso)
- **Node 20+** — https://nodejs.org
- Um microfone que funcione

---

## Etapa 1 — Cérebro (5 min)

Sem isso nada roteia.

```bash
npm install
copy .env.example .env
```

Pegue a chave em https://console.anthropic.com e edite o `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

**Teste:**

```bash
npm run jarvis "quanto de RAM tá livre?"
```

Se ele respondeu com números reais da sua máquina, o cérebro e a camada
Windows estão de pé.

> **Modelo.** O padrão é `claude-sonnet-5`, que responde rápido o suficiente
> pra conversa falada. Se preferir raciocínio mais pesado em comandos
> complexos, troque `JARVIS_MODEL=claude-opus-5` — custa latência.

---

## Etapa 2 — Memória (2 min)

Já funciona sozinha. O vault é criado no primeiro comando.

```
vault/
  daily/    um .md por dia, tudo que aconteceu
  notes/    anotações avulsas
  tasks/    tasks.json, reminders.json
  logs/
```

**Teste:**

```bash
npm run jarvis "lembra que eu uso Quest 3S com Virtual Desktop"
npm run jarvis "o que você sabe sobre meu setup de VR?"
```

Se o segundo comando achou o primeiro, a memória está ligada.

Quer o vault em outro lugar (OneDrive, pasta do Obsidian)? `VAULT_PATH` no `.env`.

---

## Etapa 3 — Voz (15 min, sendo 10 de download)

### 3a. Wake word

Conta grátis em https://console.picovoice.ai → copie o **AccessKey**.

```
PICOVOICE_ACCESS_KEY=...
```

```bash
npm install @picovoice/porcupine-node @picovoice/pvrecorder-node
```

A keyword `"jarvis"` já vem embutida. Não precisa treinar nada.

### 3b. Transcrição local

**Opção A — mais fácil:**

```bash
pip install -U openai-whisper
```

**Opção B — mais rápida (recomendada):**

Baixe o [whisper.cpp](https://github.com/ggml-org/whisper.cpp/releases),
ponha o `whisper-cli.exe` no PATH, e baixe um modelo:

- [`ggml-small.bin`](https://huggingface.co/ggerganov/whisper.cpp/tree/main) — melhor custo-benefício pra português

```
STT_COMMAND=whisper-cli -m C:/models/ggml-small.bin -f {file} -l pt -nt --no-prints
```

### 3c. Voz de resposta

Não precisa fazer nada — o Windows já tem SAPI com voz pt-BR.

Quer melhor? [Piper](https://github.com/rhasspy/piper):

```
TTS_COMMAND=piper --model C:/piper/pt_BR-faber-medium.onnx --output_file {out}
```

### 3d. Ligue

```bash
npm run listen
```

Diga **"jarvis"**, espere o `wake word detectada`, e fale.

> Não detectou? Veja [`.skills/voice.md`](.skills/voice.md) — tem seção de
> problemas comuns (sensibilidade, microfone errado, corte no meio da frase).

---

## Etapa 4 — Integrações (opcional)

Ligue só o que você usa.

### Spotify

1. https://developer.spotify.com/dashboard → **Create app**
2. Em **Redirect URIs**, cadastre exatamente: `http://127.0.0.1:8888/callback`
3. Copie Client ID (e Secret) pro `.env`
4. ```bash
   npm run auth:spotify
   ```

Abre o navegador, você autoriza, pronto. O refresh é automático pra sempre.

**Teste:** `npm run jarvis "toca lo-fi no spotify"`

### GitHub

Token clássico com escopo `repo` + `workflow` em
https://github.com/settings/tokens

```
GITHUB_TOKEN=ghp_...
GITHUB_DEFAULT_REPO=saque1211/Jarvis
```

**Teste:** `npm run jarvis "como tá o CI do meu repo?"`

### Discord

Config do canal → Integrações → Webhooks → copiar URL

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

### Casa inteligente

Via Home Assistant (fala com quase todo hardware, então integramos um
protocolo em vez de quinze marcas):

```
HOME_ASSISTANT_URL=http://192.168.0.10:8123
HOME_ASSISTANT_TOKEN=...
```

Token em: seu perfil no HA → Security → Long-lived access tokens.

### Busca web

https://brave.com/search/api — 2000 consultas/mês grátis.

```
BRAVE_API_KEY=...
```

Sem isso a busca cai no DuckDuckGo, que só responde bem pergunta factual.

### Quest 3S

- **PC VR** (Link/Air Link/Virtual Desktop) — já funciona, `vr_launch`
- **Standalone** — precisa de Modo Desenvolvedor no headset + Android Platform
  Tools com `adb` no PATH. Aí dá pra ver bateria, instalar APK, abrir app.

### Gravação de tela

Instale o [ffmpeg](https://ffmpeg.org/download.html) no PATH. Sem ele, o
`start_recording` dispara o Game Bar do Windows — funciona, mas o JARVIS não
controla o arquivo.

---

## Etapa 5 — Confira tudo

```bash
npm run doctor
```

Saída típica no meio do caminho:

```
  Cérebro
  OK   ANTHROPIC_API_KEY presente, modelo claude-sonnet-5

  Skills
  OK   16 skills carregadas, 92 tools disponíveis

  Voz
  OK   PICOVOICE_ACCESS_KEY presente (wake word)
  OK   STT: whisper.cpp
  OK   TTS: SAPI (voz nativa do Windows)

  Integrações
  --   Spotify: falta autorizar — rode npm run auth:spotify
  OK   GitHub token presente
```

`OK` = funciona. `--` = opcional, desligado. `X` = quebrado, precisa arrumar.

---

## Personalizar

### Seus apps

`config/apps.json` mapeia como você chama → o que abrir:

```json
{
  "obsidian": "C:\\Users\\voce\\AppData\\Local\\Obsidian\\Obsidian.exe",
  "trabalho": "code",
  "jogo": "steam://rungameid/1091500"
}
```

Ou fale: *"jarvis, registra o obsidian em C barra apps barra obsidian ponto exe"*.

### Suas automações

*"jarvis, salva um script chamado backup que roda python no arquivo tal"*

Vira uma entrada em `config/scripts.json`, e depois é só
*"jarvis, roda o backup"*.

### Seus conjuntos de abas

*"jarvis, salva um workspace chamado trabalho com github.com, linear.app e localhost:3000"*

Depois: *"jarvis, abre o workspace de trabalho"* — abre janela nova com as três.

### Suas pastas

Por padrão o JARVIS só mexe em arquivos dentro da sua home e da raiz do
projeto. Pra liberar outros discos:

```
JARVIS_ALLOWED_ROOTS=D:/Projetos,E:/Midia
```

---

## Rodar sempre

Pra escutar desde o boot, crie um atalho em:

```
shell:startup
```

apontando pra:

```
cmd /c cd /d C:\caminho\Jarvis && npm run listen
```

---

## Próximo passo

O **HUD** — a tela escura com vitais, deck de comandos e agenda. Ainda não
existe. É a Etapa 4 do plano original.
