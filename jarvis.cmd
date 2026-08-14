@echo off
REM Roda qualquer comando do JARVIS de onde voce estiver.
REM
REM Existe porque o terminal do Windows abre em C:\WINDOWS\system32 quando e
REM aberto como administrador, e ali o npm nao acha o package.json — o erro
REM (ENOENT, C:\WINDOWS\system32\package.json) nao diz que o problema e a pasta.
REM
REM %~dp0 e a pasta DESTE arquivo, entao ele sempre acha o projeto sozinho.
REM
REM   jarvis                 modo conversa
REM   jarvis doctor          npm run doctor
REM   jarvis listen          npm run listen
REM   jarvis llm:test        npm run llm:test

cd /d "%~dp0"

if "%~1"=="" (
  npm run jarvis
) else (
  npm run %*
)
