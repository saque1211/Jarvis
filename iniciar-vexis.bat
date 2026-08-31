@echo off
REM ============================================================
REM  Duplo-clique aqui pra ligar o Vexis:
REM   1) abre o painel (HUD) no navegador
REM   2) comeca a escutar a palavra "vexis" e responder
REM  A configuracao (servidor, sensibilidade) vem do jarvis.env ao lado.
REM ============================================================
cd /d "%~dp0"

REM --- 1) Abre o painel. Tenta o Chrome em modo app (janela limpa, sem barra de
REM        endereco, tipo o do Raspberry); se nao achar, cai no navegador padrao.
start "" chrome --app=http://163.245.213.167:3000/hud 2>nul || start "" http://163.245.213.167:3000/hud

REM --- 2) Liga a escuta do "vexis".
python pi\jarvis-pi.py

echo.
echo O Vexis parou. Feche esta janela ou rode de novo.
pause
