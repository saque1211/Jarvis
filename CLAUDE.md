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
npm run log                # últimas conversas: o que ouviu e o que respondeu
npm run env:check          # acha linha colada/repetida no .env (add "-- --corrigir")
npm run test:voice         # mic + STT + TTS isolados do resto
npm run wake              # calibra a palavra de ativacao (ao vivo ou com frases)
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

20 skills / 109 tools. No Windows carregam todas; no Raspberry e na nuvem,
as 9 que não tocam a máquina (weather, avisos, compras, memory, tasks,
search, voice, integrations, freelance).

Uma skill marca `platform: 'win32'` pra rodar só no PC, ou `platform: '*'`
pra rodar em qualquer lugar. Sem marcação nenhuma também vale em todo lugar
— o `'*'` existe pra dizer isso de propósito em vez de por omissão.

`src/core/state.js` monta o snapshot que o HUD consome — é o contrato entre
dado e visual. Brief de design em `HUD-SPEC.md`.

**Duas configurações, e elas não se misturam.** `.env` é de quem instala:
chaves, caminhos, escrito uma vez com o editor aberto. `src/core/settings.js`
(JSON no vault) é de quem usa: variante do HUD, fotos, avisos, lista de
compras, janela da previsão — mudado do celular, no meio do dia, sem
terminal. Foi misturar as duas que corrompeu o `.env` três vezes.

**HUD** (`src/hud/`): servidor HTTP + SSE e uma página só. Não é Electron de
propósito — o navegador já está na máquina, e `--app` dá janela sem barra de
endereço pelo mesmo efeito sem empacotar 200 MB de runtime. Como é HTTP, abre
no celular pelo IP da rede de graça. Estado a cada 1s; vitais (CPU/GPU/disco,
que custam um PowerShell cada) a cada 5s; previsão a cada 5min.

A página desenha em 1920x1080 fixos e é **escalada** pra caber na tela. Uma
folha de estilo só serve o monitor do PC, os 800x480 do Pi e o celular.

**Palavra de ativação** (`JARVIS_TRIGGER=escuta`): o microfone fica aberto, um
porteiro de energia decide o que é fala, e o Whisper — que já está carregado —
transcreve só esses pedaços. `src/voice/wake.js` compara por **som**, não por
grafia: `x→ks`, `c→k`, `z→s`, `b→v`, e aceita distância de edição até
`VEXIS_WAKE_TOLERANCIA`.

Não é Porcupine porque o Porcupine só reconhece palavras de fábrica ou um
`.ppn` treinado no console da Picovoice, e "vexis" não é palavra nenhuma. O
preço é uma transcrição por pedaço de fala no cômodo; o ganho é um nome
inventado funcionando sem cadastro, com a tolerância na sua mão.

O nome entra **primeiro** no prompt inicial do Whisper. Avisar que a palavra
existe faz ele escrever certo de primeira — melhor que depender da tolerância
para consertar depois. Calibre com `npm run wake`.

Quando o nome vem junto com o pedido ("Vexis, toca música"), o comando é
aproveitado da mesma transcrição em vez de reabrir o microfone.

`src/platform/index.js` despacha rede/brilho/volume/reiniciar pro `win32.js`
ou pro `linux.js`. O HUD nunca sabe em qual dos dois está. `capacidades()`
diz o que a máquina realmente faz, e **controle que não mexe em nada some da
tela** em vez de existir enganando.

**App do celular** (`src/app/`): PWA servida pelo mesmo processo do HUD, em
`/app`. Cinco abas — Casa, Fotos, Lista, Avisos, Ajustes — editando o mesmo
`settings.json` que o painel obedece, pelas mesmas rotas HTTP. Instala na tela
inicial (manifest + service worker) e não precisa de loja.

Não usa o palco escalado do HUD de propósito: lá o alvo é uma tela fixa vista
de longe; aqui é um polegar, e o que importa é alvo grande e texto que reflui.

O service worker guarda **só a casca**, nunca dados. Lista de compras de ontem
servida como se fosse a de hoje é pior que erro de rede: o erro você vê, a
lista velha você acredita.

**Falta:** contas e pareamento na nuvem, casa inteligente, calendário e e-mail.

## Limites conhecidos, documentados de propósito

- **Workana/Fiverr não têm API pública de freelancer.** A skill trabalha com
  feeds RSS de vagas. Ver `.skills/freelance.md`.
- **Abas já abertas do navegador** não são manipuláveis de fora sem extensão.
  Por isso existe o conceito de *workspace de abas*: em vez de reorganizar o
  caos, você abre a janela certa de uma vez.
- **GPU** depende de `nvidia-smi`. Em AMD/Intel a tool reporta indisponível em
  vez de inventar número.
- **Xiaomi Home não tem API pública de consumidor.** O caminho honesto é o
  Home Assistant como intermediário: ele tem REST com token, e a integração
  Xiaomi Miio dele já resolve o protocolo. Uma integração cobre Xiaomi, Tuya
  e Zigbee de uma vez, em vez de uma nuvem por fabricante.
- **Volume no Windows não é lido nem escrito por comando.** O caminho exato
  seria P/Invoke na `IAudioEndpointVolume`, que erra em silêncio se a ordem
  da vtable estiver torta. Fica nas teclas de mídia, de 2 em 2, e o nível
  exibido é o que você escolheu — não uma leitura do sistema.
- **Brilho por WMI só existe em painel integrado.** Monitor de mesa obedece
  DDC/CI, não a WMI; no Pi, `/sys/class/backlight` precisa de regra de udev.
  Em qualquer um dos casos o controle some da tela.
- **`Add-Content` no PowerShell cola** o texto novo no fim da última linha
  quando o arquivo não termina com quebra de linha. Já corrompeu o `.env` três
  vezes aqui (STT_PROMPT, JARVIS_SPEAKER_PORT, ELEVENLABS_API_KEY), sempre com
  o mesmo sintoma: a variável de cima fica com lixo e a de baixo some. É o que
  o `npm run env:check` procura.
