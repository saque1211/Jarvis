# JARVIS

Assistente pessoal voice-first pra Windows 11. Wake word local, roteamento por
LLM (Groq ou Claude), **controle real da máquina** — não é um chatbot que
explica como fazer, é um que faz.

```
SPEAK. ROUTE. REMEMBER. REPEAT.
```

---

## O que ele faz

Você fala **"jarvis"**, dá o comando, ele executa.

```
"jarvis, abre o vscode no projeto do site"
"jarvis, toca lo-fi no spotify"
"jarvis, como tá a GPU?"
"jarvis, organiza minha pasta de downloads"
"jarvis, roda os testes do backend"
"jarvis, me lembra de mandar a proposta em 40 minutos"
"jarvis, tem vaga nova no workana?"
"jarvis, tira um print e salva como bug-login"
"jarvis, o que eu fiz na terça?"
```

**17 skills, 99 tools.** O modelo escolhe qual usar — não existe lista de
comandos decorados.

| Skill | O que cobre |
|---|---|
| **apps** | Abrir/fechar apps, focar janelas |
| **exec** | Scripts Python/PowerShell, automações salvas, tarefas agendadas |
| **files** | Criar, mover, copiar, organizar arquivos |
| **media** | Spotify (API real), YouTube, volume, teclas de mídia |
| **hardware** | CPU/GPU/RAM/disco, monitores, energia, **Quest 3S** |
| **capture** | Screenshots, gravação de tela |
| **browser** | Abrir links, workspaces de abas, buscar bookmarks |
| **build** | npm/pnpm/yarn, testes, git, GitHub Actions |
| **scaffold** | Projetos novos, componentes React, boilerplate |
| **search** | Web, GitHub, Stack Overflow, npm, ler páginas |
| **tasks** | To-dos, prioridades do dia, anotações |
| **timer** | Contagem regressiva, cronômetro, pomodoro |
| **notify** | Lembretes, alarmes, notificações do Windows |
| **integrations** | Discord, Home Assistant, HTTP genérico |
| **freelance** | Feeds de vagas |
| **memory** | Consultar o vault — o que já aconteceu |
| **voice** | Controlar como o JARVIS fala |

---

## Privacidade

**Seu áudio nunca sai da máquina.** Wake word e transcrição rodam local
(Porcupine + Whisper). A única coisa que vai pra rede é o texto já transcrito,
pra API do LLM decidir qual tool chamar.

O vault é markdown puro no seu disco. Abre no Obsidian, no Notepad, no que
você quiser. Sem banco de dados, sem nuvem, sem lock-in.

---

## Começar

### 1. Instale

```bash
git clone https://github.com/saque1211/Jarvis
cd Jarvis
npm install
copy .env.example .env
```

### 2. Chave de um LLM (única obrigatória)

Escolha um dos dois e ponha no `.env`:

**Groq** — free tier, rápido. Chave em https://console.groq.com/keys

```
GROQ_API_KEY=gsk_...
```

**Anthropic** — pago, mas escolhe a tool certa com bem mais precisão entre as 99.

```
ANTHROPIC_API_KEY=sk-ant-...
```

Se as duas estiverem presentes, o Groq ganha. Force com `LLM_PROVIDER=anthropic`.

> Com Groq, espere erros de roteamento de vez em quando — 99 tools é muita
> escolha pra um modelo aberto. Se o JARVIS chamar a tool errada com frequência,
> é sinal pra migrar pro Claude.

### 3. Teste por texto primeiro

```bash
npm run jarvis "que horas são e como tá a memória da máquina"
```

Ou modo conversa:

```bash
npm run jarvis
```

### 4. Ligue a voz

Precisa de duas coisas:

**Gravação do microfone** — sem chave, sem cadastro:

```bash
npm install @picovoice/pvrecorder-node
```

O gatilho padrão é a tecla `Ctrl+Alt+J`, que funciona com o terminal em segundo
plano. Quer falar **"jarvis"** em vez de apertar? Aí precisa da Picovoice:

```bash
npm install @picovoice/porcupine-node
```
```
JARVIS_TRIGGER=wakeword
PICOVOICE_ACCESS_KEY=...   # console.picovoice.ai — exige e-mail corporativo
```

**Transcrição local** — instale um dos dois:

```bash
pip install -U openai-whisper          # mais fácil
```
ou [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (mais rápido — recomendado)

Aí:

```bash
npm run listen
```

Aperte `Ctrl+Alt+J` (ou diga **"jarvis"**, se ligou a wake word) e fale.

### 5. Confira o que falta

```bash
npm run doctor       # o que está configurado
npm run test:voice   # mic + transcrição + fala, isolados do resto
```

Lista, item por item, o que já funciona e o que ainda precisa de chave.

---

## Integrações opcionais

Nada aqui é obrigatório. Cada uma que você liga, mais coisa o JARVIS resolve.

| Integração | Pra quê | Como |
|---|---|---|
| **Spotify** | Tocar música por nome, ver o que tá tocando | `npm run auth:spotify` |
| **GitHub** | Actions, busca de código | `GITHUB_TOKEN` no `.env` |
| **Discord** | Mandar avisos num canal | `DISCORD_WEBHOOK_URL` |
| **Home Assistant** | Luz, temperatura, tomada | `HOME_ASSISTANT_URL` + token |
| **Brave Search** | Busca web decente (2k/mês grátis) | `BRAVE_API_KEY` |
| **ffmpeg** | Gravação de tela controlável | instalar no PATH |
| **adb** | Quest 3S standalone | Android Platform Tools |

Sem Spotify autorizado, o controle de mídia cai nas teclas nativas do Windows —
funciona, só não sabe o nome da música.

---

## Segurança

O JARVIS controla sua máquina de verdade, então tem freio:

- **Comandos destrutivos** (`rm -rf`, `format`, `git push --force`, `shutdown`)
  são bloqueados até você confirmar em voz. Ele pergunta antes, não avisa depois.
- **Arquivos** só são tocados dentro da sua home e da raiz do projeto. Amplie
  com `JARVIS_ALLOWED_ROOTS` se quiser.
- **Nada de shell string.** Todo comando vai por `spawn` com argumentos
  separados, ou PowerShell `-EncodedCommand`. Transcrição errada não vira
  injeção.

---

## Estrutura

```
src/
  core/         router (tool-use loop), llm (Groq/Claude), registry, vault, config
  platform/     win32.js — tudo que toca o Windows passa aqui
  skills/       17 skills, uma por arquivo
  core/state.js snapshot que o HUD consome
  voice/        wake word, STT, TTS, daemon
  integrations/ clientes de API (Spotify OAuth...)
config/         apps.json, scripts.json, tab-workspaces.json
vault/          sua memória, em markdown
.skills/        documentação de cada skill
```

Trocar de sistema operacional no futuro = escrever um irmão de
`platform/win32.js`. As skills não sabem em que SO estão.

---

## Adicionar uma skill

Crie `src/skills/minha.js`:

```js
export default {
  name: 'minha',
  description: 'O que ela cobre.',
  tools: [{
    name: 'fazer_algo',
    description: 'Quando usar isso. Cite as frases que você realmente fala.',
    input_schema: {
      type: 'object',
      properties: { alvo: { type: 'string' } },
      required: ['alvo'],
    },
    handler: async ({ alvo }) => `Feito em ${alvo}.`,
  }],
};
```

Pronto. O registry carrega sozinho no próximo boot.

Detalhes em [`.skills/README.md`](.skills/README.md).

---

## HUD

O brief de design está em [`HUD-SPEC.md`](HUD-SPEC.md) — 8 painéis, contrato
de dados e estados, prontos pra mandar pra quem for desenhar.

Os dados já existem: `npm run hud:state` cospe o JSON que o HUD vai consumir.
Falta só a camada visual.

## Ainda não tem

- **A tela do HUD** — spec pronta, visual não.
- **Calendário** — `tasks` guarda prazos, mas não fala com Google Calendar ainda.
- **E-mail** — sem integração de inbox.

---

**Sua voz é a interface. Consistência compõe.**
