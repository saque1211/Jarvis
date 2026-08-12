# Voz — como funciona por dentro

O pipeline inteiro roda local, menos o roteamento. **Seu áudio nunca sai da
máquina** — só o texto transcrito vai pra API do modelo.

```
microfone
   ↓
gatilho                            ← tecla, Enter ou wake word
   ↓  dispara
grava até detectar silêncio        ← RMS por frame, 1.2s de silêncio encerra
   ↓  WAV 16kHz mono
Whisper (STT)                      ← local
   ↓  texto
router + 99 tools                  ← única coisa que sai da máquina
   ↓  resposta
SAPI ou Piper (TTS)                ← local
   ↓
alto-falante
```

## O gatilho

Só a primeira etapa é trocável. As outras não sabem quem disparou.

| `JARVIS_TRIGGER` | Como dispara | Precisa de chave? | Mic aberto |
|---|---|---|---|
| `hotkey` (padrão) | `Ctrl+Alt+J`, mesmo com o terminal atrás | não | só no disparo |
| `enter` | Enter, com o terminal em foco | não | só no disparo |
| `wakeword` | falar "jarvis" | sim (Picovoice) | o tempo todo |

O padrão é `hotkey` quando não há `PICOVOICE_ACCESS_KEY`, e `wakeword` quando há.

### hotkey

Um PowerShell vigia o teclado com `GetAsyncKeyState` e avisa o daemon por
stdout. Combine teclas com `+`: `JARVIS_HOTKEY=shift+space`, `f9`, `ctrl+alt+j`.

**Duas formas de usar, e ele descobre sozinho qual você quis:**

- **Segurar enquanto fala e soltar** — soltar encerra na hora. É o fim exato:
  você disse que acabou, não há o que adivinhar.
- **Tocar e falar** — aí quem decide o fim é a detecção de silêncio, com a
  espera de `JARVIS_SILENCE_MS`.

A diferença é a duração do toque: acima de 400ms conta como "segurou". Um toque
rápido não é tratado como fim de fala, senão cortaria quem apertou e só depois
começou a falar.

Se a espera do silêncio incomoda, segure a tecla — é a forma sem espera nenhuma.

Vantagem sobre a wake word, além de não precisar de cadastro: o microfone só
abre quando você aperta. Nada de falso positivo, e o indicador do Windows só
acende quando você pediu.

### wakeword

Usa **Porcupine**, da Picovoice. A keyword `"jarvis"` já vem embutida — não
precisa treinar nada.

- Chave: https://console.picovoice.ai — **o cadastro exige e-mail corporativo**,
  e o login por GitHub cai na mesma tela. Sem um desses, use `hotkey`.
- Outras built-in: `computer`, `alexa`, `bumblebee`, `picovoice`, `porcupine`, `terminator`
- Quer uma palavra sua? Treine um `.ppn` no console e aponte `JARVIS_WAKE_WORD_PATH`

`JARVIS_WAKE_SENSITIVITY` vai de 0 a 1 (padrão 0.6).

- **Disparando sozinho** (falso positivo) → baixe pra 0.4
- **Não te ouve** → suba pra 0.75

Você também pode ajustar falando: *"jarvis, aumenta a sensibilidade pra 0.7"*.
Vale até reiniciar o daemon.

## Trocar a voz

```bash
npm run voices          # lista e fala uma frase com cada uma
npm run voices --mudo   # só lista
```

Escolheu? Um pedaço do nome basta:

```
JARVIS_VOICE=maria
JARVIS_VOICE_RATE=1        # -10 (devagar) a 10 (rápido)
JARVIS_VOICE_VOLUME=100    # 0 a 100
```

**Só tem uma voz em português?** O Windows traz mais sob demanda:
*Configurações → Hora e idioma → Fala → Adicionar vozes*.

## Voz melhor: Piper

O SAPI é síntese dos anos 2000 e soa como tal. O [Piper](https://github.com/rhasspy/piper)
é neural, roda local, é grátis e soa quase natural.

```bash
npm run voice:piper              # instala e testa falando
npm run voice:piper edresson     # outro locutor
```

Ele baixa o binário e a voz, testa, e imprime a linha pro `.env`:

```
TTS_COMMAND=C:/piper/piper/piper.exe --model C:/piper/pt_BR-faber-medium.onnx --output_file {out}
```

Com `TTS_COMMAND` presente o SAPI sai de cena, e `JARVIS_VOICE` deixa de valer —
quem manda na voz passa a ser o modelo `.onnx`.

Cada voz são dois arquivos: o `.onnx` (o modelo) e o `.onnx.json` (como
pronunciar). Faltando um dos dois, não roda.

### Ver o catálogo

```bash
npm run voice:piper --lista          # vozes em português
npm run voice:piper --lista en       # inglês
npm run voice:piper --lista todas    # tudo
```

Lê o `voices.json` do repositório, então mostra o que existe hoje — não uma
lista chumbada aqui que envelhece. Cada linha já vem com o comando pra instalar.

Qualidades: `high` soa melhor e ocupa mais disco, `low` é o contrário, `medium`
é o meio. Pra assistente de voz, `medium` costuma bastar.

### Pegar outra voz

O instalador aceita três formas:

```bash
npm run voice:piper alan                                    # atalho
npm run voice:piper pt/pt_BR/cadu/medium/pt_BR-cadu-medium  # caminho no repositório
npm run voice:piper https://algum-site.com/voz.onnx         # URL direta
```

Atalhos que já vêm: `faber` e `edresson` (pt-BR), `alan` e `northern` (inglês
britânico), `ryan` (inglês americano).

> **Modelo em inglês não fala português.** O Piper converte texto em fonemas
> usando as regras do idioma do modelo, então um `en_GB` aplica fonética
> inglesa em palavra portuguesa — não é sotaque, é pronúncia errada, e não tem
> ajuste que corrija: a fonetização está amarrada ao modelo. Se quiser a voz
> inglesa, o JARVIS precisa responder em inglês também.

Catálogo completo: [huggingface.co/rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices/tree/main).
São centenas, em dezenas de idiomas, todas livres.

A URL direta existe porque o repositório do Piper não é o único lugar com voz
pronta. Qualquer `.onnx` no formato do Piper serve — inclusive um que você
treine. Se for clonar voz de alguém, a pessoa precisa ter concordado.

**Custo:** o Piper sintetiza em fração de segundo no CPU, então não pesa como o
Whisper. A troca é disco — cada voz ocupa entre 20 e 60 MB.

## Voz boa de graça: Edge TTS

As vozes neurais da Microsoft — as mesmas do "ler em voz alta" do Edge. Não tem
cadastro, não tem chave, não tem custo. Em português são muito melhores que
qualquer coisa local, porque rodam na infra da Microsoft em vez do seu CPU.

```bash
npm run voices:edge          # ouve todas as pt-BR e imprime a linha do .env
npm run voices:edge en-US    # outro idioma
npm run voices:edge --mudo   # só lista
```

```
EDGE_TTS_VOICE=pt-BR-AntonioNeural
EDGE_TTS_RATE=-10%      # mais devagar
EDGE_TTS_VOLUME=+20%    # mais alta
```

**O preço:** precisa de internet, e o texto da resposta sai da máquina. O áudio
do microfone continua nunca saindo — isso é o Whisper, sempre local.

**Aviso honesto:** é o protocolo interno do Edge, não uma API pública com
contrato. A Microsoft pode mudar e quebrar. Por isso a fala cai no TTS local
quando falha, com o motivo no terminal.

### Se o cliente embutido não conectar

Ele é uma reimplementação do protocolo, e o protocolo muda. Quando o serviço
aceita o token mas recusa a síntese, o caminho confiável é o pacote `edge-tts`
do Python — mantido, e acompanha essas mudanças:

```bash
python -m pip install -U edge-tts
```

```
TTS_COMMAND=python -m edge_tts --voice pt-BR-AntonioNeural --text {text} --write-media {out}
```

Tire o `EDGE_TTS_VOICE` do `.env` pra não tentar os dois. Mesmas vozes, mesma
qualidade — só quem fala com o servidor muda.

Ele devolve MP3. Isso é tratado: o formato é detectado pelos primeiros bytes do
arquivo, não pela extensão, e MP3 toca por outro caminho no Windows.

Ver as vozes disponíveis:

```bash
python -m edge_tts --list-voices
```

### Ordem de preferência

Com mais de um configurado, a ordem é: **Fish Audio → Edge → Piper/`TTS_COMMAND`
→ SAPI**. Cada um que falha passa pro próximo, então o JARVIS nunca fica mudo
por causa de rede.

## Voz na nuvem (Fish Audio)

Quando você quer uma voz específica que não existe em formato local:

```
FISH_AUDIO_API_KEY=...
FISH_AUDIO_VOICE_ID=d9a100f6d45f43dea41bd0c160d7e578
```

O `VOICE_ID` é o `reference_id` que aparece na página da voz em
[fish.audio](https://fish.audio). Com as duas variáveis presentes, o Fish Audio
tem prioridade sobre Piper e SAPI.

**Não dá pra trazer essa voz pro Piper.** O Fish Audio te dá um identificador
que aponta pro modelo no servidor deles — o modelo em si nunca sai de lá. E o
Piper roda arquivos `.onnx` no formato VITS, que é outra arquitetura. Pra ter a
mesma voz local seria preciso *treinar* um modelo Piper com horas de áudio dela,
não converter um ID.

**O que muda ao sair do local:**

| | Piper | Fish Audio |
|---|---|---|
| Onde sintetiza | sua máquina | servidor deles |
| Custo | zero | por caractere |
| Latência | fração de segundo | ida e volta de rede |
| Funciona offline | sim | não |
| O texto sai da máquina | não | sim |

O áudio do microfone continua nunca saindo, nos dois casos — isso é o Whisper,
e ele é local sempre.

**Se a API falhar** — sem crédito, sem internet, chave errada — a fala cai no
TTS local automaticamente, com o motivo no terminal. Ficar mudo por causa de
API fora do ar seria pior que uma voz feia.

## Ouvir pelo celular

`JARVIS_SPEAKER=phone` no `.env` faz a resposta sair no seu telefone em vez da
placa de som do PC. Serve pra caixa de som quebrada, pra ouvir de outro cômodo,
ou pra usar o fone que já está no celular.

Não instala nada. O daemon sobe um servidor e imprime o endereço no boot:

```
[alto-falante] http://192.168.0.12:8790
```

Abre isso no navegador do celular e toca em **"Tocar aqui"** — esse toque
existe porque navegador não libera áudio sem interação do usuário. Depois dele
a página fica conectada e toca cada resposta assim que chega.

Por dentro: o SAPI grava a fala num WAV em vez de tocar, o servidor avisa a
página por SSE, e ela busca o arquivo. As falas entram numa fila no celular, pra
duas respostas seguidas não saírem por cima uma da outra.

**Ninguém com a página aberta = a fala volta pro PC.** Fechar a aba não deixa o
JARVIS mudo sem avisar.

O celular precisa estar na mesma rede. Na primeira vez o Windows vai perguntar
se libera o Node no firewall — tem que aceitar, senão o telefone não alcança.

## Fim da fala

O limiar que separa fala de silêncio **é relativo ao seu microfone**, não um
número fixo. Ele se calibra sozinho durante a gravação: acompanha o menor nível
visto (que converge pro chiado do mic) e o pico (que é a sua voz), e corta
quando a energia cai perto do chiado.

Um limiar fixo funciona num microfone limpo e falha num ruidoso — lá o chiado
sozinho já fica acima dele, o silêncio nunca é detectado, e o daemon grava até
o limite de 15 segundos. O whisper então recebe dois segundos de fala afogados
em treze de ruído, e devolve palavra trocada. Se você já viu "spotify" virar
"spatchfire", era isso.

O daemon imprime os dois níveis depois de cada comando:

```
[audio] pico 0.339 · chiado 0.021
```

Distância curta entre eles (menos de 8x) é aviso: nenhum modelo de STT salva
transcrição quando a fala está perto do ruído. Aí é microfone, não software.

Depois do gatilho, o daemon grava e mede a energia RMS de cada frame. Quando
passa `JARVIS_SILENCE_MS` (padrão 1200ms) em silêncio **depois de você ter
começado a falar**, ele corta e manda pro STT.

Se você fala devagar e ele corta no meio, suba pra 1800. Se demora demais pra
responder, baixe pra 900.

Teto absoluto: `JARVIS_MAX_COMMAND_MS` (15s).

## STT — escolhendo o motor

O `stt.js` autodetecta nesta ordem:

1. `STT_COMMAND` do `.env` (manda em tudo, `{file}` = caminho do wav)
2. **whisper.cpp** — binário `whisper-cli` no PATH
3. **openai-whisper** — `pip install -U openai-whisper`

### Recomendação prática

**whisper.cpp com o modelo `small`** é o melhor custo-benefício pra português
em tempo real. O `base` erra nome próprio demais; o `medium` fica lento numa
GPU ocupada com outra coisa.

```
STT_COMMAND=whisper-cli -m C:/models/ggml-small.bin -f {file} -l pt -nt --no-prints
```

Baixe os modelos em: https://huggingface.co/ggerganov/whisper.cpp/tree/main

## TTS

**Padrão: SAPI**, a voz nativa do Windows. Não é bonita, mas já está instalada
e fala pt-BR — o JARVIS responde no primeiro boot sem você baixar nada.

**Upgrade: Piper.** Local, rápido, muito melhor.

```
TTS_COMMAND=piper --model C:/piper/pt_BR-faber-medium.onnx --output_file {out}
```

Vozes pt-BR: https://huggingface.co/rhasspy/piper-voices/tree/main/pt/pt_BR

Veja as vozes SAPI que você já tem: *"jarvis, lista as vozes"*.

## Comandos sobre a própria voz

| Você fala | Acontece |
|---|---|
| "para de falar" / "fica quieto" | Só texto, sem áudio |
| "pode falar de novo" | Volta a responder em voz |
| "repete" | Repete a última resposta |
| "lê isso aqui: ..." | Fala o texto que você mandar |

## Problemas comuns

**O gatilho não dispara.** Rode `npm run doctor` — ele diz qual modo está ativo
e o que falta pra ele. Depois cheque se o mic certo foi escolhido: o daemon
imprime o dispositivo no boot. Ajuste com `JARVIS_MIC_INDEX`.

No `hotkey`, se a tecla não responder, provavelmente outro programa já a
capturou (Discord e OBS costumam brigar por combinações comuns). Troque em
`JARVIS_HOTKEY`. Se nada funcionar, `JARVIS_TRIGGER=enter` não depende do
teclado global.

**Transcreve errado.** Modelo pequeno demais. Suba de `base` pra `small`.

**Corta no meio da frase.** Suba `JARVIS_SILENCE_MS`.

**Dispara sozinho com a TV ligada.** Baixe `JARVIS_WAKE_SENSITIVITY` pra 0.4.
