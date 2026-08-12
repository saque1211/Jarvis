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

**As vozes do SAPI são datadas.** Pra algo bem melhor, o [Piper](https://github.com/rhasspy/piper)
roda local e soa quase natural:

```
TTS_COMMAND=C:/piper/piper.exe --model C:/piper/pt_BR-faber-medium.onnx --output_file {out}
```

Com `TTS_COMMAND` presente o SAPI sai de cena, e `JARVIS_VOICE` deixa de valer —
quem manda na voz passa a ser o modelo `.onnx` que você apontar.

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
