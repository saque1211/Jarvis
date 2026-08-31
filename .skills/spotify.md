# Spotify

O Vexis toca e controla o Spotify por voz: "toca tal musica", "pausa",
"proxima", "volume", "passa pro [aparelho]". As tools estao em
`src/skills/spotify.js` (`platform: '*'`, porque a Web API do Spotify roda
tambem na nuvem, onde o cerebro vive). O cliente HTTP + refresh de token esta em
`src/integrations/spotify.js`.

## O modelo mental

- **O servidor e o cerebro** — decide o que tocar e manda o comando pro Spotify.
  Nao toca som nenhum (esta num data center).
- **O som sai de um aparelho SEU** que esteja rodando o app do Spotify (Spotify
  Connect), logado na mesma conta: celular, PC, ou o Raspberry com raspotify.
- Um aparelho so aparece pra API se **tocou algo recentemente**. Ficar so aberto,
  parado, faz ele sumir da lista — de play uma vez pra "acordar".

## Requisitos

- Conta **Premium** (a API so controla reproducao no Premium).
- Um **app** no [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard).

## Configurar (uma vez)

1. **Criar o app** no dashboard: marque **Web API**, e em **Redirect URIs**
   adicione exatamente `http://127.0.0.1:8888/callback` (http, 127.0.0.1, sem
   barra no fim) e **Save**. Em **User Management**, adicione a sua conta (nome +
   email do Spotify) — em modo de desenvolvimento so contas liberadas entram.
   Copie **Client ID** e **Client Secret** (Settings).

2. **Chaves no servidor** — em `/opt/jarvis/.env`, cada uma na sua linha:
   ```
   SPOTIFY_CLIENT_ID=...
   SPOTIFY_CLIENT_SECRET=...
   ```
   (Cuidado ao editar o .env: linha nova sem quebra gruda na de cima. Rode
   `npm run env:check` se algo sumir.)

3. **Autorizar** — o servidor nao tem navegador, entao use um tunel SSH pra o
   callback voltar pra ele:
   ```bash
   # no PC:
   ssh -L 8888:127.0.0.1:8888 root@SEU_IP
   # no servidor:
   cd /opt/jarvis && npm run auth:spotify
   ```
   Ele imprime um link e **fica esperando**. Copie o link, abra no navegador do
   PC, clique em **Agree**. O callback volta pelo tunel, e aparece
   "Vexis conectado ao Spotify" + "Tokens salvos" (em `.secrets/spotify.json`).

4. `systemctl restart jarvis-voz`

## Testar

Abra o Spotify em algum aparelho e **de play numa musica** (pra ele ficar
ativo). Entao:
```bash
cd /opt/jarvis && npm run jarvis "toca uma musica no spotify"
```
A musica troca no aparelho ativo. Por voz: "Vexis, toca [x]".

## No Raspberry Pi: caixa de som de verdade (tipo Alexa)

No Pi, instale um cliente Spotify Connect que roda sozinho, pra ele virar um
aparelho **sempre disponivel** (sem app aberto), ligado numa caixa/fone:
```bash
sudo apt install raspotify        # ou: curl -sL https://dtcooper.github.io/raspotify/install.sh | sh
```
Depois de configurar (nome do device, conta), o Pi aparece na lista de
aparelhos do Spotify. Ai o Vexis toca direto nele, e sai som do alto-falante
ligado no Pi — ligado 24h, ouvindo "vexis" e tocando. Esse e o setup final.

## Erros comuns

- **"Nenhum dispositivo Spotify ativo"** → nenhum aparelho tocou algo
  recentemente. De play uma vez no app.
- **"redirect_uri: Not matching configuration"** → o Redirect URI no dashboard
  nao bate com `http://127.0.0.1:8888/callback`. Confira e salve.
- **"Connection refused" no tunel / o auth fecha sozinho** → num servidor sem
  navegador o `xdg-open` falhava e derrubava o auth; ja corrigido em
  `scripts/auth-spotify.js` (ele imprime o link e segue esperando).
- **403 / Premium required** → a conta nao e Premium.
