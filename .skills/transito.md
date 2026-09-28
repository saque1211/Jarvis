# Trânsito

`src/skills/transito.js` + `src/integrations/transito.js`

Responde "como está o trânsito", "quanto tempo até o trabalho" e
"tem engarrafamento" com dois números: quanto leva **agora** e quanto levaria
com a via livre. A diferença entre os dois é a resposta — "23 minutos" sozinho
não diz se o dia está bom ou ruim.

## Por que TomTom, e não Google Maps

O Directions do Google exige projeto com cartão de crédito cadastrado antes da
primeira chamada. A TomTom dá **2.500 consultas por dia** com só um e-mail,
cobre o Brasil e devolve o campo que interessa (`trafficDelayInSeconds`).

O Waze não tem API pública — o app é o produto. Quem "usa o Waze por trás" está
raspando o site, que quebra sem aviso e viola os termos.

Chave em [developer.tomtom.com](https://developer.tomtom.com) → `TOMTOM_API_KEY`
no `.env`. Sem ela a skill responde que falta configurar, em vez de dar erro.

## Os lugares têm nome

A pergunta de toda manhã é a mesma; o que muda é o trânsito, não o endereço do
trabalho. Por isso:

- **origem** (`transito.origem`) — de onde os trajetos saem. Uma vez só.
- **lugares** (`transito.lugares`) — `{ nome, endereco, lat, lon }`.
- **padrão** (`transito.padrao`) — quem responde "como está o trânsito" sem
  destino dito. O primeiro lugar salvo vira padrão sozinho.

A origem **não** cai na cidade da previsão do tempo quando falta. O centro da
cidade não é a sua rua, e o trajeto sairia errado por vinte minutos com cara de
certo — pior que não responder.

Um destino que não está salvo ainda funciona: ele é geocodificado na hora e não
fica guardado. "Quanto tempo até o aeroporto" não deveria exigir cadastro.

## Endereço se digita

Ditar "rua Doutor Fulano de Tal, 1420" pro microfone da sala erra o número
metade das vezes. Por isso os mesmos lugares se cadastram na aba **Ajustes** do
app, com teclado — `POST /transito/origem`, `POST /transito/lugar`,
`POST /transito/padrao`, `DELETE /transito/lugar`. A regra de salvar mora na
skill e é exportada; as rotas chamam a mesma função, senão "Trabalho" e
"trabalho" virariam dois destinos.

A busca usada é a **difusa** (`search/2/search`), não o geocode puro: a entrada
vem de transcrição de voz, onde "shopping do centro" é tão comum quanto
"rua tal, 120". Quando já existe origem, ela entra como viés de proximidade —
sem isso "Avenida Brasil" pode cair em outro estado.

## Detalhes que custaram bug

- **Cache de 2 minutos** por par origem→destino. Trânsito muda em minutos;
  repetir a pergunta gastaria cota sem trazer número novo.
- **A hora de chegada usa `JARVIS_TZ`**, não o relógio do processo. Raspberry Pi
  OS sem configurar fica em UTC, e ali uma chegada às 8h seria falada como 11h.
- `trafficDelayInSeconds` é preferido à subtração (ele desconta paradas
  previstas), mas nem sempre vem — a subtração é a rede de baixo.
- 403 e 429 viram frase em português ("chave recusada", "cota acabou") em vez de
  "HTTP 403", que ninguém ouve e entende.

## O indicador animado

`src/hud/transito/indicador.html` e `src/hud/transito/mapa.html` são páginas
inteiras, desenhadas por fora do projeto, servidas em `/transito/*.html` pelos
dois servidores (HUD e nucleus) e embutidas em **iframe**. Iframe e não HTML
colado dentro da página porque elas têm CSS próprio — dentro do HUD as duas
folhas brigariam, e qualquer redesenho vira um merge à mão.

A conversa é por `postMessage`:

```js
quadro.contentWindow.postMessage({
  tipo: 'transito', situacao: 'travado', minutos: 41, atrasoMin: 21, destino: 'trabalho',
}, '*');
```

As quatro situações (`livre`, `moderado`, `carregado`, `travado`) são as mesmas
que `classificar()` devolve — não há tradução no meio.

### Onde cada uma roda, e por quê

Medido no Chromium, 6 segundos de execução real:

| | nós | animações | 800×480 | 1920×1080 |
|---|---|---|---|---|
| indicador | 172 | 12 | 60 fps | 60 fps |
| mapa | 750 | 69 | 35 fps | 14 fps |
| mapa `carros=0.4&3d=0` | 638 | 69 | 57 fps | 17 fps |

Em tela cheia, tirar carros e perspectiva quase não ajuda (14 → 17 fps): o
gargalo é **área pintada**, não quantidade de elemento. O que muda tudo é o
tamanho da caixa:

| mapa em | fps | pior quadro |
|---|---|---|
| 1280×340 | 60 | 33 ms |
| 1360×520 (a cena grande) | 50 | 50 ms |
| 1360×520 com `3d=1` | 32 | 83 ms |
| 1600×620 | 38 | 67 ms |
| 1920×1080 | 19 | 117 ms |

Daí a divisão: o **indicador** é a faixa da manhã, porque pode passar horas na
tela e faz 60 fps em qualquer tamanho; o **mapa** é a cena de 16s, numa caixa
de 1360×520 onde ele faz 50 fps. Sem a perspectiva de propósito — ela custa um
terço do quadro por um detalhe que, num painel visto de longe, ninguém enxerga.
A máquina onde isso foi medido é bem mais rápida que um Pi 3 B+.

### Duas formas de aparecer no painel

- **Faixa da manhã** — `paraOPainel()` é chamada de 5 em 5 minutos por quem
  serve o painel e devolve `null` fora da janela **sem tocar na API**. Trânsito
  às 3 da madrugada é enfeite, e cada consulta gasta cota de um trajeto que
  ninguém vai fazer.
- **Cena de quem perguntou** — `get_traffic` grava `transitoPedido` no runtime
  com a hora, igual à cena do tempo. O **mapa** sobe no meio da tela com véu por
  trás, por 16s, e a faixa sai de cena enquanto isso (com o véu no ar ela ficaria
  boiando por cima). Vale mesmo fora da janela: quem perguntou quer ver agora, e
  merece ver o trajeto, não o resumo.

O iframe é criado na **primeira vez** que precisa e vive daí em diante. Num Pi
de 1 GB não se paga uma página extra no boot por algo que talvez não apareça no
dia, e recriar entre as duas formas custaria um recarregamento no meio da
transição.

### `color-scheme: dark` não é enfeite

Sem essa meta nas duas páginas, o Chromium pinta o fundo do iframe de **branco**
por baixo do documento transparente: com `fundo=transparente` o cartão some e
sobra uma caixa branca no meio do painel escuro. Foi assim que apareceu na
primeira montagem.
