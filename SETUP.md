# Setup — passo a passo

Do zero até falar com a máquina. Tempo real: ~30 minutos, sendo 20 esperando
download de modelo.

---

## Pré-requisitos

- **Windows 11** (o `src/platform/win32.js` assume isso)
- **Node 20+** — https://nodejs.org
- **Git** — https://git-scm.com/download/win
- Um microfone que funcione

> **PowerShell bloqueando o npm?** Se aparecer *"a execução de scripts foi
> desabilitada neste sistema"*, abra o PowerShell como Administrador e rode
> `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`.

---

## Etapa 1 — Cérebro (5 min)

Sem isso nada roteia.

```bash
npm install
copy .env.example .env
```

Escolha um provedor e ponha a chave no `.env`.

**Groq** (free tier) — https://console.groq.com/keys

```
GROQ_API_KEY=gsk_...
```

**Anthropic** (pago) — https://console.anthropic.com

```
ANTHROPIC_API_KEY=sk-ant-...
```

Com as duas presentes o Groq ganha. Force com `LLM_PROVIDER=anthropic`.

**Teste:**

```bash
npm run jarvis "quanto de RAM tá livre?"
```

Se ele respondeu com números reais da sua máquina, o cérebro e a camada
Windows estão de pé.

> **Modelo.** Vazio no `.env` = padrão do provedor
> (`llama-3.3-70b-versatile` no Groq, `claude-sonnet-5` na Anthropic).
> Sobrescreva com `JARVIS_MODEL` se quiser outro.
>
> **O trade-off honesto:** o JARVIS oferece as 99 tools de uma vez e deixa o
> modelo escolher. O Llama do Groq erra essa escolha com mais frequência que o
> Claude — vai chamar a tool errada, ou nenhuma, em comandos ambíguos. Começa
> no Groq porque é grátis; se irritar, migra.

**Se aparecer erro de limite de tokens:** as 99 tools custam ~14 mil tokens e o
free tier do Groq dá 12 mil por minuto. Por isso, no Groq, o router faz antes
uma chamada barata que escolhe 2-3 skills relevantes e só manda as tools delas
— cai pra ~4 mil por comando. Você vê a escolha na saída:

```
  · skills: hardware, timer
  → system_stats
```

Ainda estourando? Baixe `JARVIS_TOOL_BUDGET` no `.env`.

### Se estiver lento

Cada comando mostra onde o tempo foi:

```
  2.4s total — 0.3s escolha, 1.9s modelo, 0.2s máquina
```

- **escolha** alta → o `JARVIS_FAST_MODEL` está pesado demais pro serviço.
  Ele só precisa cuspir `["hardware"]`; use o menor modelo que existir.
- **modelo** alta → é o roteador pensando. Um modelo menor em `JARVIS_MODEL`
  responde mais rápido e erra mais a escolha de tool. Esse é o trade.

  Comandos de ação ("põe 10 minutos", "abre o spotify") já encerram na saída da
  tool e economizam uma viagem inteira. Perguntas focadas ("quanto de RAM tá
  livre") também, desde que o modelo passe o `focus` certo. Só a pergunta geral
  ("como tá a máquina") gasta a viagem extra, porque aí destilar o relatório é
  trabalho de verdade.

- **máquina** alta com várias tools → elas já rodam em paralelo; o número é o
  relógio de parede do lote, então é a tool mais lenta, não a soma.
- **máquina** alta → não é o LLM, é o Windows. PowerShell frio demora no
  primeiro comando de cada tipo.

Vale lembrar: no CLI o tempo de fala do TTS vem *depois* desse número. Se a
sensação de lentidão for a resposta demorando a sair da caixa, é o TTS —
`npm run jarvis --mudo "..."` mede sem ele.

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

### 3a. O gatilho — o que faz ele começar a ouvir

Só isso precisa de decisão. O resto da cadeia (gravar, transcrever, rotear,
falar) é igual nos três modos.

```bash
npm install @picovoice/pvrecorder-node
```

Esse pacote é só a gravação do microfone — **não precisa de chave nenhuma.**

**Modo `hotkey` (padrão) — tecla global, sem cadastro**

Nada a configurar. Você aperta `Ctrl+Alt+J` e fala, mesmo com o terminal atrás
de outra janela. Troque a tecla com `JARVIS_HOTKEY=shift+space` se quiser.

**Modo `enter` — mais simples ainda**

```
JARVIS_TRIGGER=enter
```

Aperta Enter no terminal e fala. Zero dependência; só exige o terminal em foco.

**Modo `wakeword` — falar "jarvis"**

Precisa de uma chave da Picovoice:

```bash
npm install @picovoice/porcupine-node
```

```
JARVIS_TRIGGER=wakeword
PICOVOICE_ACCESS_KEY=...
```

Conta em https://console.picovoice.ai. **Atenção:** o cadastro deles exige
e-mail corporativo, e o login por GitHub cai na mesma tela. Se você não tem um
e-mail assim, fique no `hotkey` — a única diferença é apertar uma tecla em vez
de falar a palavra.

A keyword `"jarvis"` já vem embutida. Não precisa treinar nada.

> **Efeito colateral bom do hotkey:** o microfone só abre quando você aperta a
> tecla. No modo wake word ele fica aberto o tempo todo, porque é ouvindo que
> ele detecta a palavra.

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

### 3d. Teste a cadeia de voz antes de ligar tudo

```bash
npm run test:voice
```

Grava 5 segundos, transcreve e fala de volta — sem gatilho, sem LLM, sem tools.
Cada etapa reporta sozinha: microfone, volume captado, motor de STT, tempo de
transcrição, TTS.

Vale porque o `npm run listen` junta seis coisas numa corrente só; quando ele
falha calado, esse aqui diz qual elo quebrou. Se o pico de volume vier zerado,
o problema é permissão de microfone ou `JARVIS_MIC_INDEX` — não é o Whisper.

### 3e. Ligue

```bash
npm run listen
```

Ele imprime o gatilho que está usando e o que fazer. Dispare (tecla, Enter ou
a palavra), espere o `pode falar`, e fale.

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
  OK   provedor groq, GROQ_API_KEY presente, modelo llama-3.3-70b-versatile
  --   Groq e free tier: mais barato, mas erra mais na escolha entre 99 tools

  Skills
  OK   17 skills carregadas, 99 tools disponíveis

  Voz
  OK   gatilho: tecla ctrl+alt+j (sem chave, funciona em segundo plano)
  OK   gravacao de microfone instalada
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
