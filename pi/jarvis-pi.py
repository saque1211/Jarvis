#!/usr/bin/env python3
"""
JARVIS — cliente do Raspberry Pi Zero 2 W.

Este arquivo e TODO o software que roda no Pi. Ele nao pensa: grava audio,
manda pra nuvem, toca o que volta. A escolha e por causa da placa — 512 MB de
RAM nao carregam o modelo do whisper (488 MB so pra abrir), e sintetizar voz
nele leva segundos. O servidor faz as duas coisas em milissegundos.

Depende so de coisas que ja vem no Raspberry Pi OS mais:
    sudo apt install python3-pyaudio alsa-utils mpg123
    pip install requests

Configuracao em /etc/jarvis.env ou variaveis de ambiente:
    JARVIS_CLOUD_URL=https://seu-servidor:8080
    JARVIS_CLOUD_TOKEN=o-mesmo-token-do-servidor
    JARVIS_BOTAO_GPIO=17        opcional: botao fisico em vez de voz
"""

import os
import sys
import time
import wave
import audioop
import base64
import io
import subprocess
import tempfile

try:
    import requests
except ImportError:
    sys.exit("Falta o requests: pip install requests")

# O pyaudio entra so quando vai gravar. Importado no topo, ele impediria rodar
# testes e conferir configuracao em qualquer maquina sem placa de som — e o
# erro apareceria como "modulo faltando", nao como "falta driver de audio".
pyaudio = None


def carregar_audio():
    global pyaudio
    if pyaudio is None:
        try:
            import pyaudio as _pa
        except ImportError:
            sys.exit("Falta o pyaudio: sudo apt install python3-pyaudio")
        pyaudio = _pa
    return pyaudio


# ── Configuracao ────────────────────────────────────────────────────────────
def carregar_env(caminho="/etc/jarvis.env"):
    """Le um arquivo CHAVE=valor. Existe pro systemd nao precisar de shell."""
    if not os.path.exists(caminho):
        return
    with open(caminho) as f:
        for linha in f:
            linha = linha.strip()
            if not linha or linha.startswith("#") or "=" not in linha:
                continue
            chave, valor = linha.split("=", 1)
            os.environ.setdefault(chave.strip(), valor.strip())


carregar_env()

URL = os.environ.get("JARVIS_CLOUD_URL", "").rstrip("/")
TOKEN = os.environ.get("JARVIS_CLOUD_TOKEN", "")
GPIO_BOTAO = os.environ.get("JARVIS_BOTAO_GPIO")

if not URL or not TOKEN:
    sys.exit("Configure JARVIS_CLOUD_URL e JARVIS_CLOUD_TOKEN (em /etc/jarvis.env)")

# 16 kHz mono e o que o Whisper quer. Gravar em 44,1 kHz so gastaria banda: o
# modelo reamostra pra 16 kHz de qualquer jeito.
TAXA = 16000
CANAIS = 1
BLOCO = 1024
FORMATO = 8  # pyaudio.paInt16, sem depender do import

# Deteccao de fim de fala. Os mesmos numeros que funcionaram na versao Windows,
# achados na marra: 1s de silencio encerra, mas so depois de 1,5s de gravacao —
# sem esse piso, a pausa que todo mundo faz depois das duas primeiras palavras
# corta o comando no meio.
SILENCIO_MS = 1000
MINIMO_MS = 1500
MAXIMO_MS = 15000
PISO_RUIDO = 200      # RMS de sala silenciosa num mic USB comum
FATOR_FALA = 2.5      # fala precisa ser 2,5x o chiado pra contar como fala


def log(marca, texto):
    print(f"[{marca}] {texto}", flush=True)


# ── Gravacao ────────────────────────────────────────────────────────────────
def gravar(audio):
    """Grava ate a pessoa parar de falar. Devolve WAV em memoria ou None."""
    stream = audio.open(
        format=FORMATO, channels=CANAIS, rate=TAXA,
        input=True, frames_per_buffer=BLOCO,
    )

    quadros = []
    silencio_ms = 0
    duracao_ms = 0
    falou = False
    piso = PISO_RUIDO

    try:
        while duracao_ms < MAXIMO_MS:
            dados = stream.read(BLOCO, exception_on_overflow=False)
            quadros.append(dados)

            nivel = audioop.rms(dados, 2)
            ms = (BLOCO / TAXA) * 1000
            duracao_ms += ms

            # O piso acompanha a sala: ventilador ligado sobe o chiado, e um
            # limiar fixo faria o assistente achar que voce esta sempre falando.
            if not falou:
                piso = min(piso, max(nivel, 50))

            if nivel > piso * FATOR_FALA:
                falou = True
                silencio_ms = 0
            elif falou:
                silencio_ms += ms
                if silencio_ms >= SILENCIO_MS and duracao_ms >= MINIMO_MS:
                    break
    finally:
        stream.stop_stream()
        stream.close()

    if not falou:
        return None

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(CANAIS)
        wav.setsampwidth(audio.get_sample_size(FORMATO))
        wav.setframerate(TAXA)
        wav.writeframes(b"".join(quadros))
    return buffer.getvalue()


# ── Nuvem ───────────────────────────────────────────────────────────────────
def perguntar(wav):
    resposta = requests.post(
        f"{URL}/v1/audio",
        data=wav,
        headers={"authorization": f"Bearer {TOKEN}", "content-type": "audio/wav"},
        timeout=60,
    )
    resposta.raise_for_status()
    return resposta.json()


def falar(dados):
    """
    Toca o audio que voltou, escolhendo o player pelo formato REAL do arquivo.

    O servidor manda WAV quando usa Piper e MP3 quando usa ElevenLabs, e o
    aplay nao toca MP3 — confiar na extensao daria silencio sem erro. Os
    primeiros bytes dizem a verdade: "RIFF" e WAV; "ID3" ou 0xFF 0xFB e MP3.
    """
    e_mp3 = dados[:3] == b"ID3" or dados[:2] == b"\xff\xfb"
    sufixo = ".mp3" if e_mp3 else ".wav"
    # mpg123 vem no Raspberry Pi OS; se faltar, o apt resolve numa linha.
    player = ["mpg123", "-q"] if e_mp3 else ["aplay", "-q"]

    with tempfile.NamedTemporaryFile(suffix=sufixo, delete=False) as f:
        f.write(dados)
        caminho = f.name
    try:
        r = subprocess.run(player + [caminho], capture_output=True)
        if r.returncode != 0:
            log("erro", f"{player[0]} falhou: {r.stderr.decode()[:120]}")
            if e_mp3:
                log("dica", "instale com: sudo apt install mpg123")
    finally:
        os.unlink(caminho)


# ── Gatilho ─────────────────────────────────────────────────────────────────
def esperar_botao():
    """Botao fisico no GPIO. Mais confiavel que wake word numa placa fraca."""
    from gpiozero import Button

    botao = Button(int(GPIO_BOTAO))
    log("pronto", f"segure o botao no GPIO {GPIO_BOTAO} e fale")
    while True:
        botao.wait_for_press()
        yield
        botao.wait_for_release()


def esperar_enter():
    log("pronto", "Enter pra falar, Ctrl+C pra sair")
    while True:
        input()
        yield


# ── Laco principal ──────────────────────────────────────────────────────────
def main():
    audio = carregar_audio().PyAudio()
    log("nuvem", URL)

    gatilho = esperar_botao() if GPIO_BOTAO else esperar_enter()

    try:
        for _ in gatilho:
            log("ouvindo", "fale agora")
            inicio = time.time()
            wav = gravar(audio)

            if not wav:
                log("nada", "nao captei fala")
                continue

            log("enviando", f"{len(wav) // 1024} KB, {time.time() - inicio:.1f}s de captura")
            try:
                r = perguntar(wav)
            except Exception as e:
                # Rede caindo nao pode derrubar o daemon: o proximo comando
                # tenta de novo. Um assistente que morre no primeiro timeout
                # exige alguem pra reinicia-lo, e ninguem vai fazer isso.
                log("erro", str(e))
                continue

            if r.get("transcricao"):
                log("voce", r["transcricao"])
            log("jarvis", r.get("resposta", ""))

            if r.get("audio"):
                falar(base64.b64decode(r["audio"]))
            else:
                log("aviso", "servidor respondeu sem audio (Piper nao configurado la)")
    except KeyboardInterrupt:
        pass
    finally:
        audio.terminate()


if __name__ == "__main__":
    main()
