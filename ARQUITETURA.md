# Arquitetura da nuvem — Nucleus + Raspberry + App

Quando o Jarvis sai de casa (Windows) pra qualquer lugar (Pi + nuvem), a arquitetura muda.

## Antes (Windows)

```
transcrição (Whisper local)  → router (tool-use)  → Raspberry local
teclado / voz                  + 99 tools             no celular via IP
                                (habilidades)         
```

Tudo no PC. Rápido, sem latência de rede. Dados nunca saem de casa. Mas não anda em lugar nenhum.

## Depois (Nuvem + Pi + Celular)

```
    ┌─ Pi Zero ────────────┐
    │ • microfone          │
    │ • alto-falante       │
    │ • Python que grava   │
    └────────────────────┬─┘
                         │
    ┌────────────────────┴────────────────────────────┐
    │                 Rede + HTTPS                      │
    └────────────────────┬────────────────────────────┘
                         │
    ┌────────────────────┴──────────────────────────────────────┐
    │  VPS (Vultr São Paulo, ~US$6/mês, 1GB)                  │
    │                                                           │
    │  ┌─ Nucleus (Node.js port 3000) ─────────────────────┐  │
    │  │ • Email/senha auth (JWT token)                     │  │
    │  │ • Device pairing flow                              │  │
    │  │ • User + device storage (JSON em vault/)           │  │
    │  └────────────────────────────────────────────────────┘  │
    │                                                           │
    │  ┌─ Jarvis Router (Node.js port 8080) ────────────────┐  │
    │  │ • Tool-use loop (igual ao Windows)                 │  │
    │  │ • Groq API pra Whisper (transcrição)               │  │
    │  │ • Piper local pra síntese (voz)                    │  │
    │  │ • ~30 tools (as que rodam em qualquer lugar)       │  │
    │  │ • Memory + state (vault/)                          │  │
    │  └────────────────────────────────────────────────────┘  │
    └───────────────────┬────────────────────────────────────┘
                        │
    ┌───────────────────┴──────────────┐
    │   Celular (App do celular)        │
    │                                   │
    │  1. Login nucleus (email/senha)   │
    │  2. Pega JWT token                │
    │  3. Edita settings (casa, lista)  │
    │  4. Vê avisos/tempo               │
    └───────────────────────────────────┘
```

## Fluxo de boot

### 1. Usuário registra (primeira vez)

- Abre app no celular
- Vê tela de login (vazio, pede nucleus URL + email + senha)
- Escreve:
  - Email: `seu@email.com`
  - Senha: `senha123456`
  - Nucleus URL: `https://nucleus.seu.dominio.com` (ou IP se local)
- App envia `POST /nucleus/auth/register`
- Recebe JWT token, salva em localStorage
- App agora está logado

### 2. Pi pede pareamento

- Pi roda `python3 jarvis-pi.py`
- Script faz `POST /nucleus/devices/register`:
  ```json
  {
    "deviceName": "Pi da Sala",
    "deviceType": "pi"
  }
  ```
- Recebe `approvalToken` (ex: `abc-def-123`)
- Mostra no terminal ou tela: "Código de pareamento: `abc-def-123`"
- Ou gera QR code com a URL de pairing

### 3. Usuário aprova Pi

- Abre app no celular
- Vai em Ajustes → Nuvem → Parear dispositivo
- Digita o código OU escaneia QR code
- App faz `POST /nucleus/devices/claim` com o approval token
- Recebe `deviceToken` (ex: `xyz-789-456`)
- Pi salva deviceToken em arquivo local

### 4. Pi conecta ao router

- Próximo ciclo, Pi já tem `deviceToken`
- Passa `X-Device-Token: xyz-789-456` nas requisições
- Router valida o token e processa comandos
- Sem token válido, router rejeita com 401

## Endpoints nucleus

```
POST   /auth/register       email + senha → token
POST   /auth/login          email + senha → token
GET    /auth/profile        Bearer token → user info

POST   /devices/register    deviceName + type → approvalToken
POST   /devices/claim       Bearer token + approval token → deviceToken
GET    /devices/list        Bearer token → lista de dispositivos
GET    /devices/ping        X-Device-Token → status
DELETE /devices/:id         Bearer token → revoga
```

## Endpoints router (porta 8080)

Iguais ao HUD Windows, mas com validação de `X-Device-Token` (ou Bearer token de usuário).

Ainda não: fila de comandos entre celular e Pi, sincronização de estado de ponta a ponta, etc.

## Migração do Windows

Se você quiser rodar Jarvis tanto no Windows quanto na nuvem:

1. Install Nucleus no VPS
2. Install Jarvis router no VPS (mesma coisa que roda no Windows, menos as 69 tools win32)
3. No PC Windows, pode manter tudo como está (HUD local continua funcionando)
4. Pi Zero entra na nuvem
5. App do celular pode escolher: conecta ao HUD local do PC ou ao nucleus da nuvem

## Próximos passos

1. **Jarvis-pi.py completo**: Loop de gravação + registro nucleus + requisições ao router
2. **Command queue**: Celular envia comando pro router via nucleus, router quer executar em qual dispositivo
3. **PC agent**: Quando existir, integra-se ao nucleus como dispositivo type `pc`
4. **Home Assistant**: Coordenação entre Jarvis e HA via API HTTP

## Segurança

- `JWT_SECRET` só no servidor, muda a cada deploy
- Token expira em 30 dias (reset automaticamente ao login)
- `X-Device-Token` é UUID aleatório de 128 bits
- HTTPS via Caddy (reverse proxy automático de certificado)
- Token viaja criptografado (TLS obrigatório)
- Sem password reset por email por enquanto (depois com token de 1h)
