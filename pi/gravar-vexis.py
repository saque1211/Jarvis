"""
Grava amostras da SUA voz dizendo "vexis", pra retreinar o wake word e ele te
reconhecer de primeira (o modelo atual so ouviu voz sintetica, por isso oscila).

    python pi/gravar-vexis.py

Aperte ENTER, fale "vexis" UMA vez perto do bip, e ele salva. Repita ate umas 40.
VARIE bastante: perto e longe do mic, tom normal e mais baixo, rapido e devagar,
"veksis" e "vexis" — quanto mais variado, mais robusto o modelo fica.

Os arquivos vao pra pasta  pi/minhas-amostras-vexis/  (16 kHz mono, o formato do
treino). Depois, zipe essa pasta e siga pi/treino-vexis-colab.md (secao "com a
sua voz").
"""
import os
import sys
import time
import wave

try:
    import pyaudio
except ImportError:
    sys.exit("Falta o pyaudio. No Windows: pip install pyaudio")

TAXA = 16000          # 16 kHz mono int16 — o que o treino espera
CANAIS = 1
FORMATO = pyaudio.paInt16
QUADRO = 1024
DUR = 2.5            # segundos gravados por amostra (bastante folga pra "vexis")

AQUI = os.path.dirname(os.path.abspath(__file__))


def mic_do_env():
    """Le JARVIS_MIC do ambiente ou do jarvis.env (o mesmo mic que o Vexis usa)."""
    if os.environ.get("JARVIS_MIC"):
        return os.environ["JARVIS_MIC"]
    for c in [os.path.join(AQUI, "jarvis.env"), os.path.join(AQUI, "..", "jarvis.env")]:
        if os.path.exists(c):
            for linha in open(c):
                linha = linha.strip()
                if linha.startswith("JARVIS_MIC=") and not linha.startswith("#"):
                    return linha.split("=", 1)[1].strip()
    return None


MIC = mic_do_env()
MIC = int(MIC) if MIC not in (None, "") else None

DESTINO = os.path.join(AQUI, "minhas-amostras-vexis")
os.makedirs(DESTINO, exist_ok=True)
ja = len([f for f in os.listdir(DESTINO) if f.endswith(".wav")])

pa = pyaudio.PyAudio()
print(f"\n=== Gravador de amostras 'vexis' ===")
print(f"Microfone: indice {MIC if MIC is not None else 'padrao do sistema'}")
print(f"Salvando em: {DESTINO}   (ja tem {ja})")
print("\nENTER = grava uma amostra.  Digite 'sair' + ENTER pra terminar.")
print("Mire umas 40. VARIE tom, velocidade e distancia do microfone.\n")

n = ja
while True:
    cmd = input(f"[{n}] ENTER pra gravar 'vexis'  (ou 'sair'): ").strip().lower()
    if cmd in ("sair", "s", "q", "quit", "exit"):
        break
    try:
        s = pa.open(format=FORMATO, channels=CANAIS, rate=TAXA, input=True,
                    frames_per_buffer=QUADRO, input_device_index=MIC)
    except Exception as e:
        print("  Nao consegui abrir o microfone:", e)
        print("  Rode `python pi/testar-mic.py` e ajuste JARVIS_MIC no jarvis.env.")
        break
    # Contagem 3-2-1 com o mic JA aberto (lendo e descartando, pra nao pegar o
    # estalo da abertura). Voce fala so quando aparecer "FALE!". Sem pressa.
    try:
        for c in ("3...", "2...", "1..."):
            print("   " + c, end="   ", flush=True)
            t = time.time() + 0.7
            while time.time() < t:
                s.read(QUADRO, exception_on_overflow=False)
        print("\n  >>>>>  FALE 'VEXIS'  <<<<<")
        quadros = []
        fim = time.time() + DUR
        while time.time() < fim:
            quadros.append(s.read(QUADRO, exception_on_overflow=False))
    finally:
        s.close()
    caminho = os.path.join(DESTINO, f"vexis_{n:03d}.wav")
    w = wave.open(caminho, "wb")
    w.setnchannels(CANAIS)
    w.setsampwidth(pa.get_sample_size(FORMATO))
    w.setframerate(TAXA)
    w.writeframes(b"".join(quadros))
    w.close()
    print(f"  salvo: {os.path.basename(caminho)}\n")
    n += 1

pa.terminate()
print(f"\nPronto! {n} amostras em {DESTINO}.")
if n >= 20:
    print("Zipe a pasta minhas-amostras-vexis e siga pi/treino-vexis-colab.md.")
else:
    print("Grave mais um pouco (mire 40) pra o modelo ficar bem robusto.")
