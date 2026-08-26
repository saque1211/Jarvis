# Casa inteligente

O VEXIS controla a casa **pelo Home Assistant**, não direto por marca.

## Por que Home Assistant no meio

Xiaomi Home, Tuya e a maioria das nuvens de fabricante **não têm API pública de
consumidor**. Cada uma que tem, tem a sua — quinze protocolos pra integrar.

O Home Assistant já resolve isso: ele fala com Xiaomi (Miio), Tuya, Zigbee,
Z-Wave e mais, e expõe **uma REST só, com token**. Integrando ele, o VEXIS
cobre todos de uma vez. É o caminho honesto — o resto seria uma nuvem por marca,
ou engenharia reversa que quebra no próximo update.

## Como ligar

1. Tenha o Home Assistant rodando (num Raspberry, num mini-PC, num container).
2. No HA: clique no seu usuário → **Long-Lived Access Tokens** → **Create Token**.
   Copie — ele só aparece uma vez.
3. Descubra o endereço do HA na rede (ex: `http://192.168.0.10:8123`).
4. No **app do VEXIS → Ajustes → Casa inteligente**: cole a URL e o token, e
   toque em **Testar e salvar**. Se conectar, ele diz o nome da sua casa.
5. Toque em **Escolher favoritos** e marque os aparelhos que quer no botão
   rápido. Eles aparecem na aba **Casa**, com o estado ao vivo.

Dá pra configurar pelo `.env` também (`HOME_ASSISTANT_URL`,
`HOME_ASSISTANT_TOKEN`) — mas o que você põe pelo app manda, porque é ele que
muda sem terminal. O `.env` fica de reserva.

## O que funciona

- **Voz:** "Vexis, acende a luz da sala", "desliga o ventilador", "qual a
  temperatura do quarto". As tools `home_list_entities`, `home_control` e
  `home_sensor_read` (skill `integrations`) falam com o mesmo HA.
- **App (aba Casa):** botões rápidos dos favoritos — toca pra ligar/desligar,
  o botão mostra o estado real depois de cada toque.

## Limites

- Sem Home Assistant configurado, os botões e a seção somem do app em vez de
  aparecer mortos — a mesma regra do resto: controle que não mexe em nada não
  fica na tela enganando.
- A leitura de estado fala com o HA a cada abertura da aba e a cada toque, não
  num loop — pra não martelar o HA nem gastar bateria do celular.
- O token nunca volta pro navegador: o app mostra "guardado", e as chamadas ao
  HA saem do servidor.
