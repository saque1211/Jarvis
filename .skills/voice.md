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
