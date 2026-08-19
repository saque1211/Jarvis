# JARVIS — contexto pro Claude Code

Assistente pessoal voice-first pra **Windows 11**. Wake word local (Porcupine),
STT local (Whisper), roteamento por LLM com tool-use, TTS local (SAPI/Piper).

## Arquitetura

```
voz/texto → router (tool-use loop) → skills → platform/win32 → máquina
              ↕            ↕
            llm.js       vault (markdown)
         (groq|anthropic)
```

- **`src/core/router.js`** — loop de tool-use. Carrega todas as tools de uma
  vez e deixa o modelo escolher. Não existe intent matching.
- **`src/core/llm.js`** — adapter dos provedores. O router fala um formato
  canônico só; cada adapter traduz pro wire format. Trocar de cérebro não
  toca em skill nenhuma.
- **`src/core/preselect.js`** — só entra quando as 99 tools não cabem no
  orçamento de tokens do provedor (`JARVIS_TOOL_BUDGET`). Uma chamada barata,
  sem tool nenhuma, escolhe 2-3 skills; o loop recebe só as tools delas.
  Com Anthropic fica desligado.
- **`src/core/registry.js`** — varre `src/skills/*.js` e achata as tools.
  Adicionar skill = criar arquivo, nada de registrar em lugar nenhum.
- **`src/platform/win32.js`** — **toda** chamada de sistema passa aqui.
  Nunca use `spawn`/`exec` direto numa skill.
- **`src/core/vault.js`** — memória em markdown. Sem banco.

## Regras ao mexer no código

**Nunca monte comando como string de shell.** Use `run(cmd, argsArray)` ou
`ps(script)` (que usa `-EncodedCommand`). O input vem de transcrição de voz —
tratar como não-confiável não é paranoia, é o caso normal.

**Toda operação irreversível precisa de `confirmed`.** Padrão: o handler
retorna uma frase pedindo confirmação em vez de executar, e o modelo pergunta
antes de chamar de novo. Veja `exec.run_command` e `files.delete_file`.

**Escrita de arquivo passa por `assertAllowed()`** em `files.js`.

**A `description` da tool é o roteamento.** É o único sinal que o modelo tem
pra escolher entre 99 tools. Escreva *quando usar*, com as frases reais que o
usuário fala — não só *o que faz*. Isso pesa mais ainda no Groq, onde o modelo
é menor e erra a escolha com mais facilidade.

**Respostas são lidas em voz alta.** O system prompt pede 1-2 frases, sem
markdown, sem emoji. Handlers devem devolver texto curto e falável.

**`speaks: true` numa tool** = a saída dela já é a resposta final, e o router
encerra ali em vez de fazer mais uma viagem ao modelo. Só marque quando a
frase serve pra ser falada sem edição. Aceita função, quando depende da
entrada. Detalhes em `.skills/README.md`.

**Tools pedidas na mesma rodada rodam em paralelo.** Se uma depende da outra,
diga isso na `description` — não confie na ordem de execução.

## Comandos

```bash
npm run jarvis "comando"   # uma vez
npm run jarvis             # modo conversa
npm run listen             # daemon de voz (wake word)
npm run hud                # HUD como app (janela sem barra de endereço)
npm run doctor             # diagnóstico de setup
npm run env:check          # acha linha colada/repetida no .env (add "-- --corrigir")
npm run test:voice         # mic + STT + TTS isolados do resto
npm run voices             # lista e fala com cada voz do Windows
npm run voices:eleven      # vozes do ElevenLabs (add "-- --ouvir" pra escutar)
npm run whisper:server     # whisper.cpp com o modelo carregado, pra latência
npm run whisper:model      # baixa o modelo do whisper que cabe na RAM
npm run llm:test           # uma chamada real: tools, tempo, tokens e custo
npm run hud:state          # snapshot que o HUD consome (add "-- watch")
npm run auth:spotify       # OAuth do Spotify, uma vez só
```

Todos exigem estar na raiz do projeto. `jarvis.cmd` faz o `cd` sozinho
(`jarvis doctor`, `jarvis listen`) — existe porque o terminal aberto como
administrador cai em `C:\WINDOWS\system32`, e ali o npm falha com um ENOENT que
não diz que o problema é a pasta.

## Estado atual

17 skills / 99 tools. Cobertura: apps, exec, files, media, hardware (inclui
Quest 3S), capture, browser, build, scaffold, search, tasks, timer, notify,
integrations, freelance, memory, voice.

`src/core/state.js` monta o snapshot que o HUD consome — é o contrato entre
dado e visual. Brief de design em `HUD-SPEC.md`.

**HUD** (`src/hud/`): servidor HTTP + SSE e uma página só. Não é Electron de
propósito — o navegador já está na máquina, e `--app` dá janela sem barra de
endereço pelo mesmo efeito sem empacotar 200 MB de runtime. Como é HTTP, abre
no celular pelo IP da rede de graça. Estado a cada 1s; vitais (CPU/GPU/disco,
que custam um PowerShell cada) a cada 5s.

**Falta:** integração de calendário e de e-mail.

## Limites conhecidos, documentados de propósito

- **Workana/Fiverr não têm API pública de freelancer.** A skill trabalha com
  feeds RSS de vagas. Ver `.skills/freelance.md`.
- **Abas já abertas do navegador** não são manipuláveis de fora sem extensão.
  Por isso existe o conceito de *workspace de abas*: em vez de reorganizar o
  caos, você abre a janela certa de uma vez.
- **GPU** depende de `nvidia-smi`. Em AMD/Intel a tool reporta indisponível em
  vez de inventar número.
- **`Add-Content` no PowerShell cola** o texto novo no fim da última linha
  quando o arquivo não termina com quebra de linha. Já corrompeu o `.env` três
  vezes aqui (STT_PROMPT, JARVIS_SPEAKER_PORT, ELEVENLABS_API_KEY), sempre com
  o mesmo sintoma: a variável de cima fica com lixo e a de baixo some. É o que
  o `npm run env:check` procura.
