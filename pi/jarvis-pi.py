#!/usr/bin/env python3
"""
JARVIS — cliente do Raspberry Pi Zero 2 W.

Este arquivo e TODO o software que roda no Pi. Ele nao pensa: grava audio,
manda pra nuvem, toca o que volta. A escolha e por causa da placa — 512 MB de
RAM nao carregam o modelo do whisper (488 MB so pra abrir), e sintetizar voz
nele leva segundos. O servidor faz as duas coisas em milissegundos.

Depende so de coisas que ja vem no Raspberry Pi OS mais:
    sudo apt install python3-pyaudio alsa-utils mpg123 espeak-ng
    pip install requests
    pip install pvporcupine        # so pra palavra de ativacao

Configuracao em /etc/jarvis.env ou variaveis de ambiente:
    JARVIS_NUCLEUS_URL=http://SEU_IP:3000    # contas e pareamento
    JARVIS_CLOUD_URL=http://SEU_IP:8080      # voz (router); cai no nucleus se vazio
    JARVIS_TRIGGER=escuta                    # escuta | botao | enter
    JARVIS_BOTAO_GPIO=17                      # so se JARVIS_TRIGGER=botao
    PORCUPINE_ACCESS_KEY=...                  # chave gratis do console Picovoice
    PORCUPINE_KEYWORD=jarvis                  # palavra de fabrica, ou:
    PORCUPINE_KEYWORD_PATH=/caminho/vexis.ppn # .ppn treinado ("vexis")

Pareamento (primeira vez):
    O Pi se registra sozinho, FALA um codigo de 6 digitos, e espera voce
    aprovar no app do celular. Depois salva o token e nunca mais pergunta.
"""

import os
import sys
import json
import time
import wave
import audioop
import base64
import io
import platform
import subprocess
import tempfile

# Roda tanto no Raspberry (Linux) quanto no PC (Windows/Mac) — pra dar pra
# testar a voz no computador antes de ter o Pi, e sem a trava de HTTPS que o
# microfone do navegador tem.
SISTEMA = platform.system()

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

# Duas nuvens, e elas podem ser o mesmo servidor. O NUCLEUS cuida de conta e
# pareamento (porta 3000). O CLOUD (router) transcreve e responde a voz. Se so
# um estiver configurado, o outro herda dele — comeca simples, separa depois.
NUCLEUS = os.environ.get("JARVIS_NUCLEUS_URL", "").rstrip("/")
CLOUD = os.environ.get("JARVIS_CLOUD_URL", "").rstrip("/") or NUCLEUS
NUCLEUS = NUCLEUS or CLOUD

TRIGGER = os.environ.get("JARVIS_TRIGGER", "escuta").strip().lower()
GPIO_BOTAO = os.environ.get("JARVIS_BOTAO_GPIO")

# Token fixo (modo antigo/manual): se existir, pula o pareamento inteiro.
TOKEN_FIXO = os.environ.get("JARVIS_CLOUD_TOKEN", "")

# Onde guardar o token que o pareamento devolve. Fica no HOME de quem roda —
# assim nao precisa de root, e sobrevive a reboot.
ARQ_DISPOSITIVO = os.environ.get(
    "JARVIS_DEVICE_FILE", os.path.expanduser("~/.jarvis/device.json")
)
NOME_DISPOSITIVO = os.environ.get("JARVIS_DEVICE_NAME", "Raspberry Pi")

if not NUCLEUS:
    sys.exit("Configure JARVIS_NUCLEUS_URL (ex: http://SEU_IP:3000) em /etc/jarvis.env")

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

DIGITOS = {
    "0": "zero", "1": "um", "2": "dois", "3": "três", "4": "quatro",
    "5": "cinco", "6": "seis", "7": "sete", "8": "oito", "9": "nove",
}


def log(marca, texto):
    print(f"[{marca}] {texto}", flush=True)


# ── Voz local (so pra falar o codigo e avisos de sistema) ────────────────────
def falar_texto(texto):
    """
    Fala uma frase curta usando o espeak, que roda no proprio Pi.

    E so pro pareamento e avisos ("estou conectado") — a voz bonita (Piper/
    ElevenLabs) vem da nuvem. O espeak e feio, mas cabe em qualquer placa e nao
    depende de rede, que e exatamente o que o codigo de pareamento precisa:
    ser falado ANTES de existir conexao nenhuma.
    """
    # No Windows, a voz do proprio sistema (SAPI) fala sem instalar nada.
    if SISTEMA == "Windows":
        seguro = texto.replace("'", " ")
        ps = ("Add-Type -AssemblyName System.Speech;"
              "$v=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
              f"$v.Speak('{seguro}')")
        try:
            subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True)
            return True
        except FileNotFoundError:
            pass
    elif SISTEMA == "Darwin":
        try:
            subprocess.run(["say", "-v", "Luciana", texto], capture_output=True)
            return True
        except FileNotFoundError:
            pass

    for prog in (["espeak-ng", "-v", "pt-br"], ["espeak-ng", "-v", "pt"],
                 ["espeak", "-v", "pt-br"], ["espeak", "-v", "pt"]):
        try:
            r = subprocess.run(prog + ["-s", "150", texto], capture_output=True)
            if r.returncode == 0:
                return True
        except FileNotFoundError:
            continue
    log("aviso", "sem voz de sistema pra falar o codigo — veja o numero na tela acima")
    return False


def falar_codigo(codigo):
    """Fala o codigo digito a digito, devagar — dois numeros colados viram um so."""
    ditado = ", ".join(DIGITOS.get(d, d) for d in codigo)
    falar_texto(f"Para me conectar, diga no aplicativo o código: {ditado}.")


# ── Pareamento ───────────────────────────────────────────────────────────────
def carregar_token():
    """Le o token salvo do pareamento anterior, se houver."""
    if TOKEN_FIXO:
        return TOKEN_FIXO
    try:
        with open(ARQ_DISPOSITIVO) as f:
            return json.load(f).get("deviceToken")
    except (FileNotFoundError, ValueError):
        return None


def salvar_token(dados):
    os.makedirs(os.path.dirname(ARQ_DISPOSITIVO), exist_ok=True)
    with open(ARQ_DISPOSITIVO, "w") as f:
        json.dump(dados, f)
    # O token e um segredo; ninguem alem do dono precisa ler.
    try:
        os.chmod(ARQ_DISPOSITIVO, 0o600)
    except OSError:
        pass


def registrar():
    """Pede um par (codigo curto, segredo de polling) ao nucleus."""
    r = requests.post(
        f"{NUCLEUS}/devices/register",
        json={"deviceName": NOME_DISPOSITIVO, "deviceType": "pi"},
        timeout=30,
    )
    r.raise_for_status()
    d = r.json()["device"]
    return d["pairingCode"], d["pollSecret"]


def parear():
    """
    Fluxo completo de pareamento. So retorna quando tiver um deviceToken.

    Fala o codigo, fica perguntando "ja me aprovaram?", e se o codigo expirar
    (10 min) sem ninguem aprovar, pega um codigo novo e fala de novo. Um Pu
    ligado num quarto vazio nao pode ficar preso num codigo morto.
    """
    while True:
        try:
            codigo, segredo = registrar()
        except Exception as e:
            log("erro", f"nao consegui registrar: {e}. Tento de novo em 10s.")
            time.sleep(10)
            continue

        log("parear", f"código de pareamento: {codigo}  (digite no app, vale 10 min)")
        falar_codigo(codigo)

        # O codigo vale 10 min no servidor; troco aos 9 pra nunca falar um morto.
        limite = time.time() + 9 * 60
        while time.time() < limite:
            time.sleep(3)
            try:
                r = requests.post(
                    f"{NUCLEUS}/devices/poll",
                    json={"pollSecret": segredo},
                    timeout=30,
                )
            except Exception:
                continue  # rede oscilou; tenta no proximo ciclo
            if r.status_code != 200:
                break  # segredo sumiu (servidor reiniciou o vault?) — recomeca
            resp = r.json()
            if resp.get("approved"):
                salvar_token({
                    "deviceToken": resp["deviceToken"],
                    "deviceId": resp.get("device", {}).get("id"),
                    "name": resp.get("device", {}).get("name"),
                })
                log("parear", "aprovado! token salvo.")
                falar_texto("Pronto, estou conectado.")
                return resp["deviceToken"]

        log("parear", "código expirou sem aprovação — gerando outro.")


# ── Gravacao ────────────────────────────────────────────────────────────────
def _gravar_quadros(stream):
    """
    Le do stream ate a pessoa parar de falar. Nao abre nem fecha o stream — o
    chamador decide isso, porque na palavra de ativacao o mesmo stream ja esta
    aberto ouvindo, e reabrir cortaria a primeira palavra do comando.
    """
    quadros = []
    silencio_ms = 0
    duracao_ms = 0
    falou = False
    piso = PISO_RUIDO

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

    if not falou:
        return None

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(CANAIS)
        wav.setsampwidth(carregar_audio().get_sample_size(FORMATO))
        wav.setframerate(TAXA)
        wav.writeframes(b"".join(quadros))
    return buffer.getvalue()


def gravar(audio):
    """Abre um stream proprio, grava um comando e fecha. Usado por botao/Enter."""
    stream = audio.open(
        format=FORMATO, channels=CANAIS, rate=TAXA,
        input=True, frames_per_buffer=BLOCO,
    )
    try:
        return _gravar_quadros(stream)
    finally:
        stream.stop_stream()
        stream.close()


# ── Nuvem (voz) ──────────────────────────────────────────────────────────────
def perguntar(wav, token):
    resposta = requests.post(
        f"{CLOUD}/v1/audio",
        data=wav,
        headers={
            # O router deve validar o mesmo token de dispositivo do nucleus.
            "x-device-token": token,
            "authorization": f"Bearer {token}",
            "content-type": "audio/wav",
        },
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

    with tempfile.NamedTemporaryFile(suffix=sufixo, delete=False) as f:
        f.write(dados)
        caminho = f.name
    try:
        if SISTEMA == "Windows":
            _tocar_windows(caminho, e_mp3)
        elif SISTEMA == "Darwin":
            subprocess.run(["afplay", caminho], capture_output=True)
        else:
            # mpg123 vem no Raspberry Pi OS; se faltar, o apt resolve numa linha.
            player = ["mpg123", "-q"] if e_mp3 else ["aplay", "-q"]
            r = subprocess.run(player + [caminho], capture_output=True)
            if r.returncode != 0:
                log("erro", f"{player[0]} falhou: {r.stderr.decode()[:120]}")
                if e_mp3:
                    log("dica", "instale com: sudo apt install mpg123")
    finally:
        try:
            os.unlink(caminho)
        except OSError:
            pass


def _tocar_windows(caminho, e_mp3):
    """
    Toca no Windows sem instalar nada. WAV vai pelo winsound (built-in); MP3
    (voz do ElevenLabs) vai pelo MediaPlayer do PowerShell, que espera a
    duracao do arquivo pra nao cortar a fala no meio.
    """
    if not e_mp3:
        import winsound
        winsound.PlaySound(caminho, winsound.SND_FILENAME)
        return
    ps = ("Add-Type -AssemblyName presentationCore;"
          "$p=New-Object System.Windows.Media.MediaPlayer;"
          f"$p.Open([uri]'{caminho}');"
          "Start-Sleep -Milliseconds 400; $p.Play();"
          "$s=0; while($p.NaturalDuration.HasTimeSpan -eq $false -and $s -lt 30){Start-Sleep -Milliseconds 100; $s++};"
          "if($p.NaturalDuration.HasTimeSpan){Start-Sleep -Seconds ([int]$p.NaturalDuration.TimeSpan.TotalSeconds + 1)}")
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True)


# ── Processar um comando (gravar ja feito) ───────────────────────────────────
def atender(wav, token):
    inicio = time.time()
    if not wav:
        log("nada", "nao captei fala")
        return
    log("enviando", f"{len(wav) // 1024} KB")
    try:
        r = perguntar(wav, token)
    except Exception as e:
        # Rede caindo nao pode derrubar o daemon: o proximo comando tenta de
        # novo. Um assistente que morre no primeiro timeout exige alguem pra
        # reinicia-lo, e ninguem vai fazer isso.
        log("erro", str(e))
        return
    if r.get("transcricao"):
        log("voce", r["transcricao"])
    log("jarvis", r.get("resposta", ""))
    _ = time.time() - inicio
    if r.get("audio"):
        falar(base64.b64decode(r["audio"]))
    else:
        log("aviso", "servidor respondeu sem audio (voz nao configurada la)")


# ── Gatilhos ─────────────────────────────────────────────────────────────────
def laco_botao(audio, token):
    """Botao fisico no GPIO. Mais confiavel que wake word numa placa fraca."""
    from gpiozero import Button

    botao = Button(int(GPIO_BOTAO))
    log("pronto", f"segure o botao no GPIO {GPIO_BOTAO} e fale")
    while True:
        botao.wait_for_press()
        log("ouvindo", "fale agora")
        wav = gravar(audio)
        botao.wait_for_release()
        atender(wav, token)


def laco_enter(audio, token):
    log("pronto", "Enter pra falar, Ctrl+C pra sair")
    while True:
        input()
        log("ouvindo", "fale agora")
        atender(gravar(audio), token)


def laco_escuta(audio, token):
    """
    Palavra de ativacao via Porcupine — detecta LOCALMENTE, sem transcrever.

    E por isso que da pra usar palavra de ativacao no Pi: cada barulho do
    comodo NAO vira uma chamada de nuvem. So quando o Porcupine ouve a palavra
    e que o comando seguinte e gravado e enviado — uma transcricao por comando
    de verdade, nao por ruido. Sem isso, a cota do Whisper evapora.
    """
    try:
        import pvporcupine
    except ImportError:
        sys.exit("Falta o pvporcupine: pip install pvporcupine  (ou use JARVIS_TRIGGER=botao)")

    chave = os.environ.get("PORCUPINE_ACCESS_KEY")
    if not chave:
        sys.exit("Falta PORCUPINE_ACCESS_KEY (pegue de graca em console.picovoice.ai)")

    caminho_ppn = os.environ.get("PORCUPINE_KEYWORD_PATH")
    if caminho_ppn:
        porcupine = pvporcupine.create(access_key=chave, keyword_paths=[caminho_ppn])
        nome_palavra = os.path.basename(caminho_ppn)
    else:
        palavra = os.environ.get("PORCUPINE_KEYWORD", "jarvis")
        porcupine = pvporcupine.create(access_key=chave, keywords=[palavra])
        nome_palavra = palavra

    # Porcupine dita o tamanho do quadro e a taxa. Abrimos UM stream com esse
    # tamanho e usamos ele tanto pra ouvir a palavra quanto pra gravar depois.
    stream = audio.open(
        format=FORMATO, channels=CANAIS, rate=porcupine.sample_rate,
        input=True, frames_per_buffer=porcupine.frame_length,
    )
    log("pronto", f'diga "{nome_palavra}" e fale o comando')

    import struct
    try:
        while True:
            quadro = stream.read(porcupine.frame_length, exception_on_overflow=False)
            pcm = struct.unpack_from("h" * porcupine.frame_length, quadro)
            if porcupine.process(pcm) >= 0:
                log("acordou", "fale agora")
                wav = _gravar_quadros(stream)  # mesmo stream, sem cortar a 1a palavra
                atender(wav, token)
                log("pronto", f'diga "{nome_palavra}" de novo')
    finally:
        stream.stop_stream()
        stream.close()
        porcupine.delete()


# ── Laco principal ──────────────────────────────────────────────────────────
def main():
    log("nucleus", NUCLEUS)
    if CLOUD != NUCLEUS:
        log("voz", CLOUD)

    token = carregar_token()
    if not token:
        log("parear", "sem token ainda — iniciando pareamento.")
        token = parear()

    audio = carregar_audio().PyAudio()

    # Escolhe o gatilho. "escuta" (palavra de ativacao) e o padrao; cai pro
    # botao se houver GPIO, e pro Enter se nao houver mais nada.
    modo = TRIGGER
    if modo == "botao" and not GPIO_BOTAO:
        log("aviso", "JARVIS_TRIGGER=botao mas sem JARVIS_BOTAO_GPIO — usando Enter")
        modo = "enter"

    try:
        if modo == "escuta":
            laco_escuta(audio, token)
        elif modo == "botao":
            laco_botao(audio, token)
        else:
            laco_enter(audio, token)
    except KeyboardInterrupt:
        pass
    finally:
        audio.terminate()


if __name__ == "__main__":
    main()
