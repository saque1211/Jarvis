# Treinar o "vexis" no Google Colab — receita que FUNCIONA

O notebook oficial do openWakeWord quebra no Colab de hoje (Python 3.13, sem
wheels de vários pacotes de áudio). Esta receita contorna isso criando um
**Python 3.11 por dentro** do Colab. Foi assim que o `pi/vexis.onnx` atual saiu.

Abra um notebook em branco no Colab, ligue **GPU** (Ambiente de execução →
Alterar tipo → T4 GPU) e rode as células abaixo, na ordem.

> **Pra um modelo que te ouça melhor:** suba `n_samples`/`n_samples_val` pra
> `2000` e `steps` pra `20000` na célula 4. Melhor ainda: grave você mesmo
> dizendo "vexis" ~20 vezes e junte como amostras positivas — o modelo só com
> voz sintética tem recall baixo (foi o que deixou o primeiro meio surdo).

## Célula 1 — Python 3.11 + PyTorch (GPU)

```python
!pip install -q uv
!uv venv --python 3.11 /content/venv --seed
import os; os.environ["PY"] = "/content/venv/bin/python"
os.environ["MPLBACKEND"] = "Agg"          # o venv nao tem o backend do Colab
!uv pip install --python $PY torch==2.0.1 torchaudio==2.0.2 --index-url https://download.pytorch.org/whl/cu118
!uv pip install --python $PY piper-phonemize webrtcvad
!$PY -c "import piper_phonemize, torch; print('OK | torch', torch.__version__, '| GPU?', torch.cuda.is_available())"
```

## Célula 2 — resto das libs + código + gerador de voz

```python
!uv pip install --python $PY "numpy<2" "scipy==1.11.4" "pyarrow==14.0.2" "setuptools<80" \
    tqdm pyyaml mutagen==1.47.0 torchinfo==1.8.0 torchmetrics==1.2.0 speechbrain==0.5.14 \
    audiomentations==0.33.0 torch-audiomentations==0.11.0 acoustics==0.2.6 \
    pronouncing==0.2.0 datasets==2.14.6 deep-phonemizer==0.0.19 onnx onnxruntime

!git clone -q https://github.com/dscripka/openWakeWord /content/openWakeWord
!uv pip install --python $PY -e /content/openWakeWord --no-deps
!git clone -q --depth 1 --branch v2.0.0 https://github.com/rhasspy/piper-sample-generator /content/piper-sample-generator
!mkdir -p /content/piper-sample-generator/models
!wget -q -O /content/piper-sample-generator/models/en_US-libritts_r-medium.pt \
    https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt
open("/content/venv/lib/python3.11/site-packages/psg.pth", "w").write("/content/piper-sample-generator\n")
!mkdir -p /content/openWakeWord/openwakeword/resources/models
!wget -q -O /content/openWakeWord/openwakeword/resources/models/embedding_model.onnx \
    https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx
!wget -q -O /content/openWakeWord/openwakeword/resources/models/melspectrogram.onnx \
    https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx
!$PY -c "import openwakeword, openwakeword.data, generate_samples; print('TUDO OK no 3.11')"
```

## Célula 3 — sons de fundo (negativos)

```python
%cd /content
!wget -q -O openwakeword_features_ACAV100M_2000_hrs_16bit.npy \
  https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/openwakeword_features_ACAV100M_2000_hrs_16bit.npy
!wget -q -O validation_set_features.npy \
  https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy

prep = r'''
import os, scipy.io.wavfile, numpy as np, datasets
from tqdm import tqdm
def salvar(a, p): scipy.io.wavfile.write(p, 16000, (a*32767).astype(np.int16))
os.makedirs("fma", exist_ok=True)
try:
    fma = iter(datasets.load_dataset("rudraml/fma", name="small", split="train", streaming=True).cast_column("audio", datasets.Audio(sampling_rate=16000)))
    for _ in tqdm(range(120), desc="fma"):
        r = next(fma); salvar(r["audio"]["array"], "fma/"+r["audio"]["path"].split("/")[-1].replace(".mp3",".wav"))
except Exception as e: print("fma:", e)
os.makedirs("mit_rirs", exist_ok=True)
try:
    for r in tqdm(datasets.load_dataset("davidscripka/MIT_environmental_impulse_responses", split="train", streaming=True), desc="rirs"):
        salvar(r["audio"]["array"], "mit_rirs/"+r["audio"]["path"].split("/")[-1])
except Exception as e: print("rirs:", e)
print("fma:", len(os.listdir("fma")), "| rirs:", len(os.listdir("mit_rirs")))
'''
open("/content/prep.py","w").write(prep)
!$PY /content/prep.py
```

## Célula 4 — config com a palavra "vexis"

```python
import glob, os, yaml
yml = glob.glob("/content/openWakeWord/**/custom_model.yml", recursive=True)[0]
config = yaml.load(open(yml).read(), yaml.Loader)
config["target_phrase"] = ["vexis"]; config["model_name"] = "vexis"
config["n_samples"] = 1000; config["n_samples_val"] = 1000; config["steps"] = 10000
config["target_accuracy"] = 0.6; config["target_recall"] = 0.25
config["background_paths"] = [d for d in ["./fma"] if os.listdir(d)]
config["false_positive_validation_data_path"] = "validation_set_features.npy"
config["feature_data_files"] = {"ACAV100M_sample": "openwakeword_features_ACAV100M_2000_hrs_16bit.npy"}
yaml.dump(config, open("/content/my_model.yaml","w"))
print("config OK:", config["target_phrase"])
```

## Célula 5 — gerar os áudios sintéticos

```python
%cd /content
!$PY /content/openWakeWord/openwakeword/train.py --training_config /content/my_model.yaml --generate_clips
```

## Célula 6 (OPCIONAL, mas é o que deixa bom) — juntar a SUA voz

O modelo só com voz sintética oscila (ele te ouve às vezes). Gravar a sua voz
sobe MUITO o acerto. No PC, rode `python pi/gravar-vexis.py`, grave umas 40
amostras, e **compacte a pasta `pi/minhas-amostras-vexis` num .zip**. Então:

```python
import glob, shutil, zipfile, random
from google.colab import files

up = files.upload()                          # escolha minhas-amostras-vexis.zip
zname = list(up.keys())[0]
with zipfile.ZipFile(zname) as z: z.extractall("/content/minhas_amostras")

wavs = glob.glob("/content/minhas_amostras/**/*.wav", recursive=True)
random.shuffle(wavs)
ptrain = "/content/my_custom_model/vexis/positive_train"
ptest  = "/content/my_custom_model/vexis/positive_test"
corte = max(1, int(len(wavs) * 0.85))
for w in wavs[:corte]: shutil.copy(w, ptrain)
for w in wavs[corte:]: shutil.copy(w, ptest)
print(f"adicionei {len(wavs)} amostras suas: {corte} treino / {len(wavs)-corte} teste")
```

## Célula 7 — aumentar e treinar

```python
%cd /content
!$PY /content/openWakeWord/openwakeword/train.py --training_config /content/my_model.yaml --augment_clips
!$PY /content/openWakeWord/openwakeword/train.py --training_config /content/my_model.yaml --train_model
```

No fim ele salva em `/content/my_custom_model/vexis.onnx` (o erro sobre `onnx_tf`
no final é inofensivo — é só a conversão opcional pra .tflite, que não usamos).

## Célula 8 — baixar

```python
from google.colab import files
files.download("/content/my_custom_model/vexis.onnx")
```

Coloque o arquivo baixado em `pi/vexis.onnx` do projeto (substituindo o atual) e
faça commit — pronto, o wake word novo entra no lugar.
