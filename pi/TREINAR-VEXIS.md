# Treinar o "vexis" como palavra de ativação

O openWakeWord só reconhece de fábrica algumas palavras (`hey_jarvis`, `alexa`…).
"vexis" é inventada, então precisa de um modelo treinado — um arquivo
`vexis.onnx`. O treino é **uma vez só**, roda de graça num Google Colab (usa a
GPU deles), e leva ~30–60 min. Você não instala nada no PC.

## Passo a passo

1. **Abra o notebook oficial de treino** (Google Colab, precisa de conta Google):

   https://colab.research.google.com/github/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb

2. No topo, **Runtime → Change runtime type → GPU** (T4 serve). Depois
   **Runtime → Run all**.

3. Quando pedir a **palavra-alvo** (`target_word` / `target_phrase`), ponha:

   ```
   vexis
   ```

   Dica: a voz sintética às vezes lê "vexis" torto. Se acontecer, tente a
   grafia que soa certo, tipo `vex iss` ou `véksis` — o que importa é o SOM que
   ele gera, não a escrita. O notebook deixa você ouvir umas amostras; confira
   antes de treinar.

4. (Opcional, melhora MUITO) Se o notebook permitir **clipes próprios**, grave
   você mesmo dizendo "vexis" umas 15–20 vezes, em tons e distâncias diferentes,
   e suba junto. Modelo treinado só com voz sintética funciona; com a sua voz
   junto, erra bem menos.

5. Ao final ele gera **`vexis.onnx`** (e às vezes `vexis.tflite`). **Baixe o
   `.onnx`.**

## Ligar no VEXIS

Largue o arquivo baixado dentro da pasta `pi/` do projeto, com esse nome exato:

```
pi/vexis.onnx
```

Pronto — o cliente acha sozinho. Sem precisar de variável nenhuma: se existe um
`pi/vexis.onnx`, ele vira a palavra; senão, cai no `hey_jarvis`. (Se quiser
apontar pra outro caminho, use `WAKE_MODELO=/caminho/vexis.onnx`.)

Roda assim (no PC ou no Pi):

```bash
python pi/jarvis-pi.py
```

No arranque ele mostra `modelos carregados: ['vexis']` e
`diga "vexis" e fale o comando`. Se vier `NENHUM`, o nome/caminho do arquivo
está errado.

## Ajustar a sensibilidade

Palavra curta dispara à toa com mais facilidade. Regule com:

```bash
WAKE_LIMIAR=0.6   # padrão 0.5. Mais alto = dispara menos (e erra menos à toa)
WAKE_DEBUG=1      # mostra nível do mic e a pontuação a cada fala, pra calibrar
```

Com `WAKE_DEBUG=1`, fale "vexis" e veja até quanto a pontuação sobe; ponha o
`WAKE_LIMIAR` um pouco abaixo desse pico, e acima do que sobe com conversa
normal no cômodo.

## Por que não Porcupine

A Porcupine (Picovoice) gastaria menos CPU, mas o cadastro dela pede e-mail de
empresa e o treino de palavra custa. O openWakeWord é aberto, grátis, sem
cadastro, e roda igual no PC e no Raspberry — que é o que este projeto precisa.
