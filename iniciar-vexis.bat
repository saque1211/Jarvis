@echo off
REM Duplo-clique aqui pra ligar o Vexis (ele escuta "vexis" e responde).
REM A configuracao (servidor, sensibilidade) vem do arquivo jarvis.env ao lado.
cd /d "%~dp0"
python pi\jarvis-pi.py
echo.
echo O Vexis parou. Feche esta janela ou rode de novo.
pause
