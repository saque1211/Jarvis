# JARVIS — contexto pro Claude Code

Assistente pessoal voice-first pra **Windows 11**. Wake word local (Porcupine),
STT local (Whisper), roteamento por Claude com tool-use, TTS local (SAPI/Piper).

## Arquitetura

```
voz/texto → router (tool-use loop) → skills → platform/win32 → máquina
                    ↕
                  vault (markdown)
```

- **`src/core/router.js`** — loop de tool-use. Carrega todas as tools de uma
  vez e deixa o modelo escolher. Não existe intent matching.
- **`src/core/registry.js`** — varre `src/skills/*.js` e achata as tools.
  Adicionar skill = criar arquivo, nada de registrar em lugar nenhum.
- **`src/platform/win32.js`** — **toda** chamada de sistema passa aqui.
  Nunca use `spawn`/`exec` direto numa skill.
- **`src/core/vault.js`** — memória em markdown. Sem banco.

## Regras ao mexer no código

**Nunca monte comando como string de shell.** Use `run(cmd, argsArray)` ou
`ps(script)` (que usa `-EncodedCommand`). O input vem de transcrição de voz —
tratar como não-confiável não é paranoia, é o caso normal.

**Toda operação irreversível precisa de `confirmed`.** Padrão: o handler
retorna uma frase pedindo confirmação em vez de executar, e o modelo pergunta
antes de chamar de novo. Veja `exec.run_command` e `files.delete_file`.

**Escrita de arquivo passa por `assertAllowed()`** em `files.js`.

**A `description` da tool é o roteamento.** É o único sinal que o modelo tem
pra escolher entre 92 tools. Escreva *quando usar*, com as frases reais que o
usuário fala — não só *o que faz*.

**Respostas são lidas em voz alta.** O system prompt pede 1-2 frases, sem
markdown, sem emoji. Handlers devem devolver texto curto e falável.

## Comandos

```bash
npm run jarvis "comando"   # uma vez
npm run jarvis             # modo conversa
npm run listen             # daemon de voz (wake word)
npm run doctor             # diagnóstico de setup
npm run auth:spotify       # OAuth do Spotify, uma vez só
```

## Estado atual

16 skills / 92 tools. Cobertura: apps, exec, files, media, hardware (inclui
Quest 3S), capture, browser, build, scaffold, search, tasks, notify,
integrations, freelance, memory, voice.

**Falta:** o HUD (terminal escuro com vitais + deck + agenda), integração de
calendário e de e-mail.

## Limites conhecidos, documentados de propósito

- **Workana/Fiverr não têm API pública de freelancer.** A skill trabalha com
  feeds RSS de vagas. Ver `.skills/freelance.md`.
- **Abas já abertas do navegador** não são manipuláveis de fora sem extensão.
  Por isso existe o conceito de *workspace de abas*: em vez de reorganizar o
  caos, você abre a janela certa de uma vez.
- **GPU** depende de `nvidia-smi`. Em AMD/Intel a tool reporta indisponível em
  vez de inventar número.
