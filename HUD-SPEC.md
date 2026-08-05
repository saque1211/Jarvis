# HUD — brief de design

Este documento é feito pra ser **mandado inteiro** pra quem for desenhar o HUD.
Ele existe porque design de dashboard só funciona quando o desenhista sabe
exatamente que dado existe, com que frequência ele muda, e o que aparece quando
o dado falta.

Tudo que está aqui tem fonte real: `npm run hud:state` cospe exatamente este
JSON. Não tem painel inventado.

---

## O briefing em uma frase

> Um HUD de terminal escuro, tela cheia, **uma tela só, sem abas**, que mostra o
> estado de um assistente pessoal por voz rodando num PC Windows: se ele está
> ouvindo, o que a máquina está aguentando, os timers correndo, o que precisa
> ser feito hoje, e o que ele acabou de executar.

Referência de sensação: cockpit / centro de controle. **Não** é dashboard de SaaS,
não é painel de analytics, não tem card branco com sombra.

---

## Formato

| Item | Valor |
|---|---|
| Alvo | 1920×1080, tela cheia, monitor secundário |
| Mínimo | 1366×768 (degrada pra 2 colunas) |
| Orientação | Paisagem, sempre |
| Distância de leitura | ~80cm — texto de corpo mínimo 14px |
| Interação | **Nenhuma.** Não tem mouse. É display, não app |
| Estado | Sempre ligado. Vai ficar horas na tela sem ninguém olhar |

Esse último ponto manda no design: **nada pode piscar, girar ou pulsar sem
motivo.** Animação só quando algo realmente aconteceu.

---

## Layout

Grid de 12 colunas. Três faixas verticais: 3 / 6 / 3.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  JARVIS          14:32:07  ·  quarta, 5 de agosto        ● ouvindo       │  HEADER 64px
├────────────────┬──────────────────────────────────┬──────────────────────┤
│                │                                  │                      │
│    VITALS      │            VOICE                 │       TIMERS         │
│                │           (herói)                │                      │
│  cpu gpu ram   │   forma de onda + estado         │   anéis regressivos  │
│  disco temp    │   última fala + resposta         │   pomodoro           │
│                │                                  │   cronômetro         │
│   3 col        │            6 col                 │        3 col         │
├────────────────┼──────────────────────────────────┼──────────────────────┤
│                │                                  │                      │
│    HOJE        │        COMMAND DECK              │      AGENDA          │
│                │                                  │                      │
│  top 3         │   fluxo das últimas tools        │   lembretes          │
│  atrasadas     │   executadas                     │                      │
│                │                                  ├──────────────────────┤
│                │                                  │    TOCANDO AGORA     │
├────────────────┴──────────────────────────────────┴──────────────────────┤
│  vault ›  17:02 timer · 16:58 nota salva · 16:51 commit no jarvis        │  FOOTER 48px
└──────────────────────────────────────────────────────────────────────────┘
```

**Por que o VOICE fica no centro e grande:** é um assistente de voz. A pergunta
que a pessoa faz olhando pra tela de longe é *"ele tá me ouvindo?"*. Essa
resposta tem que ser legível do outro lado da sala.

---

## Os 8 painéis

### 1. HEADER

**Mostra:** wordmark JARVIS · relógio (HH:MM:SS, atualiza de segundo em segundo)
· data por extenso · indicador de estado do daemon.

**Estado do daemon** — quatro valores, e essa é a informação mais importante da tela:

| Estado | Significado | Tratamento sugerido |
|---|---|---|
| `idle` | Ligado, esperando a wake word | Ponto verde, calmo |
| `listening` | Wake word disparou, gravando | Verde vivo, com movimento |
| `thinking` | Transcrevendo e roteando | Âmbar |
| `speaking` | Respondendo em voz alta | Ciano |
| `offline` | Daemon caído | **Vermelho. Não pode passar despercebido.** |

> `offline` é o caso que o design costuma esquecer. Se o JARVIS morreu, a tela
> inteira continua mostrando os últimos números — e eles ficam mentindo. Precisa
> de um tratamento global: esmaecer todos os painéis, ou uma faixa no topo.

---

### 2. VITALS — vitais da máquina

**Fonte:** `system.memory` (barato, 1×/seg) + skill `hardware` (caro, 1×/5seg)

**Campos:**
- CPU — nome, % de uso, nº de núcleos
- GPU — nome, % de uso, VRAM usada/total, temperatura °C
- RAM — usada/total GB, %
- Disco — livre/total GB por unidade
- Bateria — %, se houver (é desktop na maioria das vezes, então **projete pra não existir**)

**Precisa de:**
- Sparkline de histórico (~60 pontos) por métrica — o valor sozinho não conta história
- Faixas de alerta: verde <70%, âmbar 70–89%, vermelho ≥90%
- Temperatura tem escala própria: verde <70°C, âmbar 70–83, vermelho >83

**Estados:**
- `nvidia-smi` ausente (GPU AMD/Intel) → **a linha da GPU some ou diz "indisponível"**. Nunca mostrar 0%.
- Bateria ausente → linha some.

---

### 3. VOICE — o herói

**Fonte:** `voice.*`

**Campos:**
- Estado atual (os 5 acima)
- Wake word configurada (`"jarvis"`)
- Última transcrição — o que a pessoa falou
- Última resposta — o que o JARVIS respondeu
- Motor de STT ativo, microfone selecionado (texto pequeno, secundário)

**Precisa de:**
- Um **visualizador de áudio** que reage ao estado. É o elemento com mais peso visual da tela.
  - `idle` — quase parado. Linha discreta, respiração lenta
  - `listening` — reage de verdade, amplitude alta
  - `thinking` — movimento sem som: pulso, varredura, algo que diz "processando"
  - `speaking` — movimento distinto do listening (a pessoa precisa saber quem está falando)
- Transcrição em tipo grande. Resposta abaixo, um degrau menor.
- Transição entre estados precisa ser instantânea de perceber (<100ms). Nada de fade longo.

**Estados:**
- Sem transcrição ainda (recém-ligado) → placeholder tipo `diga "jarvis"`
- Transcrição longa → truncar em ~120 caracteres com reticências
- `offline` → visualizador congelado e esmaecido

---

### 4. TIMERS

**Fonte:** `timers[]` e `stopwatches[]` — atualiza **1×/segundo**

**Campos por timer:**
- `label` — do que é ("massa", "render")
- `remaining` — já vem formatado: `07:58` ou `01:23:45`
- `progress` — 0 a 1, pronto pra desenhar arco/barra
- `kind` — `countdown` ou `pomodoro`
- `phase` — `work` ou `break` (só pomodoro)
- `cycle` — `"2/4"` (só pomodoro)

**Campos por cronômetro:**
- `label`, `elapsed` (`00:02`), `paused` (bool), `laps` (contagem)

**Precisa de:**
- Regressiva como **anel de progresso** com o tempo no centro. É o formato que se lê de longe.
- Pomodoro precisa ser visualmente distinto de timer comum, e a fase `work` vs `break` precisa
  ser óbvia sem ler texto (cor diferente, provavelmente)
- Cronômetro conta pra cima — trate diferente da regressiva, senão confunde
- Últimos 10 segundos de uma regressiva: **precisa chamar atenção**. É a hora que a pessoa
  olha pra tela.

**Estados:**
- Nenhum ativo (o normal na maior parte do dia) → estado vazio que não pareça quebrado
- Múltiplos ativos → até 4 visíveis, ordenados por quem termina antes; excedente vira `+2`
- Pausado → visualmente inequívoco

---

### 5. HOJE — tarefas

**Fonte:** `tasks.*`

**Campos:**
- `total`, `overdue`, `dueToday`, `completedToday` (números de resumo)
- `items[]` — até 6, já ordenados: atrasadas primeiro, depois por prioridade
  - `title`, `priority` (alta/media/baixa), `due`, `overdue` (bool), `project`

**Precisa de:**
- As 3 primeiras com mais peso que o resto (são as prioridades do dia)
- `overdue: true` precisa gritar
- Prioridade codificada por cor **e** por outra coisa (barra, peso da fonte) — cor sozinha não basta
- `completedToday` merece destaque: é a única métrica de vitória da tela

**Estados:**
- Zero tarefas → estado vazio otimista, não "erro"
- Mais de 6 → `+4 outras`

---

### 6. COMMAND DECK — o que ele executou

**Fonte:** `activity[]` — últimas 12, mais recente primeiro

**Campos por entrada:** `tool` (ex: `open_app`), `skill` (ex: `apps`), `ok` (bool), `error`, `at`

**Precisa de:**
- Ler como log de terminal — é aqui que o visual "cockpit" mora
- Entrada nova entra por cima com movimento curto (~200ms). É a única animação
  recorrente da tela, então precisa ser sóbria.
- `ok: false` claramente marcado, com a mensagem de erro
- Timestamp relativo (`há 12s`) em vez de absoluto

**Estados:**
- Vazio (acabou de ligar) → linha discreta tipo `aguardando comando`

---

### 7. AGENDA — lembretes

**Fonte:** `reminders[]` — até 5, ordenados por quem dispara antes

**Campos:** `message`, `at` (ISO), `inMs` (quanto falta), `alarm` (bool)

**Precisa de:**
- Contagem relativa (`em 25 min`) — é o que importa, não o horário absoluto
- `alarm: true` (vai tocar som) diferente de lembrete silencioso
- Quem dispara em menos de 5 min sobe de destaque

---

### 8. TOCANDO AGORA

**Fonte:** `nowPlaying` — pode ser `null`

**Campos:** título, artista, se está tocando ou pausado

**Precisa de:**
- Painel pequeno. É informação ambiente, não protagonista.
- **`null` é o caso mais comum** (Spotify não autorizado, ou nada tocando).
  Projete o vazio primeiro, o cheio depois.

---

### 9. FOOTER — feed do vault

**Fonte:** `vault[]` — últimas 5 entradas

**Campos:** `path`, `at`, `excerpt` (~140 caracteres)

**Precisa de:**
- Ticker horizontal ou lista de uma linha
- Tipo pequeno, baixo contraste — é periférico
- À direita, fixo: `SPEAK. ROUTE. REMEMBER. REPEAT.`

---

## Sistema visual

### Cores

Preciso de uma paleta que funcione com **um monitor ligado o dia inteiro num
quarto escuro**. Contraste alto, mas sem branco puro em área grande.

| Papel | Uso |
|---|---|
| Fundo | Quase preto, levemente frio |
| Superfície | Um degrau acima do fundo, pros painéis |
| Borda | Sutil. Separa sem desenhar caixa |
| Texto primário | Alto contraste, **não** `#FFFFFF` puro |
| Texto secundário | Rótulos, unidades, timestamps |
| Texto terciário | Vault feed, metadados |
| **Acento** | Verde ácido/lima — é a cor do JARVIS. Estados vivos, valores em foco |
| Aviso | Âmbar — 70–89% de uso, prazo chegando |
| Crítico | Vermelho — ≥90%, atrasado, daemon offline |
| Info | Ciano — estado "falando", pausa do pomodoro |

O verde ácido vem da referência original do projeto. Se você propuser outra
direção, ela precisa continuar legível nos três níveis de alerta.

### Tipografia

- **Monoespaçada em tudo.** É um HUD de terminal — números têm que alinhar em coluna.
  Sugestões: JetBrains Mono, IBM Plex Mono, Berkeley Mono.
- Escala sugerida: 48/32/20/16/14/12
- Números grandes (timer, %) com **tabular figures** obrigatório — senão o
  layout treme a cada segundo
- Rótulos em caixa alta com tracking aumentado

### Movimento

Regra única: **movimento significa que algo aconteceu.**

- Permitido: entrada no command deck, mudança de estado da voz, últimos 10s de timer, alerta cruzando limiar
- Proibido: loop decorativo, gradiente animado, partícula flutuando à toa, skeleton pulsando eternamente

O motivo é prático: essa tela fica no canto de visão periférica. Movimento sem
significado treina a pessoa a ignorar a tela — e aí o alerta que importa também
passa batido.

---

## O que não fazer

- ❌ Card branco com sombra. Não é dashboard de SaaS
- ❌ Ícone colorido decorativo. Se tiver ícone, é funcional e monocromático
- ❌ Cantos muito arredondados. Isso é instrumentação, não app de celular
- ❌ Gráfico de pizza. Nunca
- ❌ Cor como **único** portador de significado
- ❌ Mostrar `0` quando o dado não existe. Ausente ≠ zero — isso já morde na GPU
- ❌ Barra de rolagem em qualquer painel. **Uma tela, sem abas** — se não coube, corta e conta quantos ficaram de fora

---

## Entregáveis pedidos

1. **Tela cheia, estado normal** — daemon `idle`, 2 timers, 4 tarefas, deck com histórico
2. **Tela cheia, estado ativo** — daemon `listening`, forma de onda no auge, pomodoro em `work`, uma tarefa atrasada
3. **Tela cheia, estado degradado** — daemon `offline`, GPU indisponível, nada tocando, zero timers
4. **Detalhe dos 4 estados da voz** — como o visualizador muda entre idle/listening/thinking/speaking
5. **Painel de timer isolado** — regressiva, pomodoro e cronômetro lado a lado
6. **Tokens** — cores, tipos, espaçamentos, como variáveis nomeadas

---

## Contrato de dados

Este é o JSON exato que o HUD consome. Gere o seu com `npm run hud:state`.

```json
{
  "version": 1,
  "generatedAt": "2026-08-05T17:04:33.729Z",

  "voice": {
    "state": "listening",
    "wakeWord": "jarvis",
    "lastTranscript": "abre o vscode no projeto do site",
    "lastReply": "Abri vscode com C:/Projects/site.",
    "lastAt": "2026-08-05T17:04:12.004Z",
    "sttEngine": "whisper.cpp",
    "micDevice": "Microphone (Realtek Audio)"
  },

  "system": {
    "clock": "2026-08-05T17:04:33.729Z",
    "hostname": "DESKTOP-J4RV1S",
    "uptimeMs": 1952260,
    "memory": { "totalGb": 32.0, "usedGb": 18.4, "percent": 58 },
    "loadAverage": 0.2
  },

  "timers": [
    {
      "id": 1, "label": "massa", "kind": "countdown",
      "phase": null, "cycle": null,
      "remainingMs": 477955, "remaining": "07:58",
      "durationMs": 480000, "progress": 0.004,
      "endsAt": "2026-08-05T17:11:39.445Z"
    },
    {
      "id": 3, "label": "gravar video", "kind": "pomodoro",
      "phase": "work", "cycle": "1/4",
      "remainingMs": 1499965, "remaining": "25:00",
      "durationMs": 1500000, "progress": 0.00002,
      "endsAt": "2026-08-05T17:28:41.455Z"
    }
  ],

  "stopwatches": [
    { "id": 1, "label": "estudo", "elapsedMs": 2040, "elapsed": "00:02", "paused": false, "laps": 1 }
  ],

  "tasks": {
    "total": 4, "overdue": 1, "dueToday": 3, "completedToday": 1,
    "items": [
      { "id": 3, "title": "Gravar video", "priority": "alta", "due": "2026-08-05", "overdue": false, "project": null }
    ]
  },

  "reminders": [
    { "id": 1, "message": "Pausa pro cafe", "at": "2026-08-05T17:16:00.000Z", "inMs": 690000, "alarm": false }
  ],

  "activity": [
    { "tool": "open_app", "skill": "apps", "ok": true, "at": "2026-08-05T17:04:12.001Z" },
    { "tool": "run_tests", "skill": "build", "ok": false, "error": "exit 1", "at": "2026-08-05T17:03:44.220Z" }
  ],

  "vault": [
    { "path": "daily/2026-08-05.md", "at": "2026-08-05T17:04:12.100Z", "excerpt": "17:04 — Comando ..." }
  ],

  "nowPlaying": { "title": "Bohemian Rhapsody", "artist": "Queen", "isPlaying": true }
}
```

### Cadência de atualização

| Dado | Frequência | Por quê |
|---|---|---|
| Relógio, timers, cronômetros | **1×/seg** | Segundo visível |
| Estado da voz | Por evento, imediato | É a informação principal |
| RAM, load | 1×/seg | Leitura barata |
| CPU, GPU, disco | 1×/5seg | Cada leitura custa um PowerShell |
| Tarefas, lembretes, vault | 1×/10seg | Muda devagar |
| Tocando agora | 1×/10seg | Chamada de rede |

---

## Nota final pro designer

Os campos acima **já existem e já têm dado real** — não é wireframe de coisa
futura. O que não existe ainda é só a camada visual.

Se algum painel parecer fraco, o problema provavelmente é que ele merece menos
espaço, não que precisa de mais dado. Prefira cortar painel a espremer todos.
