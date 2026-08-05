# Voz — como funciona por dentro

O pipeline inteiro roda local, menos o roteamento. **Seu áudio nunca sai da
máquina** — só o texto transcrito vai pra API do Claude.

```
microfone
   ↓
Porcupine (wake word "jarvis")     ← local, sempre escutando
   ↓  dispara
grava até detectar silêncio        ← RMS por frame, 1.2s de silêncio encerra
   ↓  WAV 16kHz mono
Whisper (STT)                      ← local
   ↓  texto
Claude + 92 tools (router)         ← única coisa que sai da máquina
   ↓  resposta
SAPI ou Piper (TTS)                ← local
   ↓
alto-falante
```

## Wake word

Usa **Porcupine**, da Picovoice. A keyword `"jarvis"` já vem embutida — não
precisa treinar nada.

- Chave grátis: https://console.picovoice.ai (plano free cobre uso pessoal)
- Outras built-in: `computer`, `alexa`, `bumblebee`, `picovoice`, `porcupine`, `terminator`
- Quer uma palavra sua? Treine um `.ppn` no console e aponte `JARVIS_WAKE_WORD_PATH`

### Sensibilidade

`JARVIS_WAKE_SENSITIVITY` vai de 0 a 1 (padrão 0.6).

- **Disparando sozinho** (falso positivo) → baixe pra 0.4
- **Não te ouve** → suba pra 0.75

Você também pode ajustar falando: *"jarvis, aumenta a sensibilidade pra 0.7"*.
Vale até reiniciar o daemon.

## Fim da fala

Depois da wake word, o daemon grava e mede a energia RMS de cada frame. Quando
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

**Não detecta a wake word.** Rode `npm run doctor` — ele valida a chave da
Picovoice e os pacotes. Depois cheque se o mic certo foi escolhido: o daemon
imprime o dispositivo no boot. Ajuste com `JARVIS_MIC_INDEX`.

**Transcreve errado.** Modelo pequeno demais. Suba de `base` pra `small`.

**Corta no meio da frase.** Suba `JARVIS_SILENCE_MS`.

**Dispara sozinho com a TV ligada.** Baixe `JARVIS_WAKE_SENSITIVITY` pra 0.4.
