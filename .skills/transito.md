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
