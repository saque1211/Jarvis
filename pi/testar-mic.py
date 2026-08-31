"""
Descobre QUAL microfone esta captando som.

Voce tem varios (USB, headset, mics virtuais) e o Vexis pode estar ouvindo o
errado — dando "nivel do mic: 0". Rode isto e FALE ALTO E SEM PARAR enquanto ele
passa por cada microfone. O que mostrar "OUVE VOCE" (ou o pico mais alto) e o seu.

    python pi/testar-mic.py

Depois, use o numero dele:
    $env:JARVIS_MIC="<numero>"       (PowerShell, Windows)
    export JARVIS_MIC=<numero>       (Linux/Mac)
e rode o Vexis de novo. Ou fixe JARVIS_MIC=<numero> no arquivo jarvis.env.
"""
import sys
import time

try:
    import pyaudio
except ImportError:
    sys.exit("Falta o pyaudio. No Windows: pip install pyaudio")

try:
    import numpy as np
except ImportError:
    sys.exit("Falta o numpy: pip install numpy")


def rms(data):
    a = np.frombuffer(data, dtype=np.int16).astype(np.float32)
    return int((a ** 2).mean() ** 0.5) if len(a) else 0


pa = pyaudio.PyAudio()
print("\n=== Teste de microfones ===")
print("FALE ALTO e SEM PARAR ('vexis vexis vexis...') ate o teste acabar.\n")
time.sleep(1.5)

melhor = (-1, 0, "")
for i in range(pa.get_device_count()):
    info = pa.get_device_info_by_index(i)
    if int(info.get("maxInputChannels", 0)) < 1:
        continue
    rate = int(info.get("defaultSampleRate") or 16000) or 16000
    try:
        s = pa.open(format=pyaudio.paInt16, channels=1, rate=rate,
                    input=True, frames_per_buffer=1024, input_device_index=i)
    except Exception:
        continue  # dispositivo nao abre nessa config — ignora
    pico = 0
    fim = time.time() + 1.2
    try:
        while time.time() < fim:
            pico = max(pico, rms(s.read(1024, exception_on_overflow=False)))
    except Exception:
        pass
    finally:
        try:
            s.close()
        except Exception:
            pass
    marca = "   <<<<< OUVE VOCE!" if pico > 250 else ""
    nome = info.get("name", "?")
    print(f"[{i:2}] pico {pico:6}   {nome}{marca}")
    if pico > melhor[1]:
        melhor = (i, pico, nome)

pa.terminate()
print("\n--------------------------------------------------")
if melhor[0] >= 0 and melhor[1] > 250:
    print(f"Seu microfone e o [{melhor[0]}]  ({melhor[2]})  — pico {melhor[1]}.")
    print(f'Use:  $env:JARVIS_MIC="{melhor[0]}"   e rode o Vexis de novo.')
else:
    print("Nenhum microfone captou som forte. Verifique se falou alto durante o")
    print("teste, e se o mic nao esta mudo/desligado nas Configuracoes de Som do Windows.")
