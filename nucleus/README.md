# JARVIS Nucleus — Backend de contas e pareamento

Servidor Node.js que coordena autenticação, pareamento de dispositivos (Pi, PC, telefone) e roteamento de dados entre os clientes.

## Instalação

```bash
npm install
```

## Configuração

Copie `.env.example` para `.env`:

```bash
cp .env.example .env
```

Edite `.env` e configure pelo menos:

- `JWT_SECRET` — qualquer string longa e aleatória (mude em produção)
- `PORT` — porta de escuta (default 3000)

## Desenvolvimento

```bash
npm run dev
```

Escuta em `http://localhost:3000`.

## Endpoints

### Autenticação

**POST /auth/register**
```json
{
  "email": "user@example.com",
  "password": "senha123"
}
```
Resposta:
```json
{
  "ok": true,
  "user": {"id": "...", "email": "..."},
  "token": "jwt..."
}
```

**POST /auth/login**
```json
{
  "email": "user@example.com",
  "password": "senha123"
}
```
Resposta:
```json
{
  "ok": true,
  "user": {"id": "...", "email": "..."},
  "token": "jwt..."
}
```

**GET /auth/profile**
```
Authorization: Bearer <token>
```
Resposta:
```json
{
  "ok": true,
  "user": {"id": "...", "email": "..."}
}
```

### Pareamento de dispositivos

**POST /devices/register**
Dispositivo (Pi, PC, telefone) pede registro. Não requer autenticação.

```json
{
  "deviceName": "Pi da Sala",
  "deviceType": "pi"
}
```
Resposta:
```json
{
  "ok": true,
  "device": {
    "id": "...",
    "approvalToken": "..."
  }
}
```

O dispositivo recebe um `approvalToken` que será fornecido ao usuário (QR code, URL, etc).

**POST /devices/claim**
Usuário autenticado reivindica um dispositivo usando o approval token.

```
Authorization: Bearer <token>
```
```json
{
  "approvalToken": "..."
}
```
Resposta:
```json
{
  "ok": true,
  "device": {
    "id": "...",
    "name": "...",
    "type": "pi",
    "deviceToken": "..."
  }
}
```

O dispositivo recebe `deviceToken` que usa daqui em diante.

**GET /devices/list**
Lista dispositivos aprovados do usuário.

```
Authorization: Bearer <token>
```
Resposta:
```json
{
  "ok": true,
  "devices": [
    {
      "id": "...",
      "name": "Pi da Sala",
      "type": "pi",
      "approvedAt": "2026-08-21T..."
    }
  ]
}
```

**DELETE /devices/:deviceId**
Revoga um dispositivo.

```
Authorization: Bearer <token>
```
Resposta:
```json
{"ok": true}
```

**GET /devices/ping**
Testa se um dispositivo está conectado.

```
X-Device-Token: <deviceToken>
```
Resposta:
```json
{
  "ok": true,
  "device": "Pi da Sala"
}
```

## Fluxo de pareamento

1. **Pi registra**: `POST /devices/register` com `deviceName` e `deviceType: "pi"`
   - Recebe `approvalToken`
   - Exibe código ou instrução para usuário
   
2. **Usuário fornece token**: digita em `/app` ou escaneia QR code
   - `POST /devices/claim` com o `approvalToken`
   - Recebe `deviceToken` para usar daqui em diante
   
3. **Pi usa deviceToken**: passa `X-Device-Token` em requests depois
   - `GET /devices/ping` para testar conexão
   - Próximos endpoints: fila de comandos, sync de estado, etc

## Dados

Armazenamento em `vault/`:
- `vault/users.json` — contas de usuário
- `vault/devices.json` — dispositivos pareados

Migração para SQL/PostgreSQL pode ser feita depois.

## Deploy em VPS

Veja `../NUVEM.md` para instruções completas de setup no servidor.
