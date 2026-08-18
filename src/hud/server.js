import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot } from '../core/state.js';
import { route } from '../core/router.js';

/**
 * Servidor do HUD.
 *
 * E HTTP + SSE em vez de Electron de proposito: o app fica sendo uma janela do
 * navegador que ja existe na maquina, sem 200 MB de runtime empacotado e sem
 * mais uma dependencia pra manter. O mesmo padrao do alto-falante do celular —
 * e de quebra o HUD abre no celular tambem, pelo IP da rede.
 *
 * O estado vai por SSE porque quem manda e o servidor: o HUD nao pergunta "e
 * agora?" dez vezes por segundo, ele recebe quando muda.
 */

const AQUI = path.dirname(fileURLToPath(import.meta.url));

// Vitais custam um PowerShell cada. A 1s eles empilhariam processo; a 5s o
// numero continua util e a maquina nem sente.
const CADENCIA_ESTADO = 1000;
const CADENCIA_VITAIS = 5000;

export function startHud({ port = 8791, host = '0.0.0.0' } = {}) {
  const clientes = new Set();
  let vitais = null;

  const servidor = http.createServer(async (req, res) => {
    try {
      await atender(req, res);
    } catch (err) {
      // Qualquer rota que estoure devolve erro legivel em vez de deixar a
      // requisicao pendurada. Navegador esperando pra sempre nao mostra nada.
      console.error(`[hud] ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ erro: err.message }));
      } else {
        res.end();
      }
    }
  });

  async function atender(req, res) {
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/') {
      const html = fs.readFileSync(path.join(AQUI, 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // Fluxo de estado. Sem cache e sem buffer de proxy: um HUD que mostra
    // estado de 30s atras e pior que um HUD que nao abre.
    if (url.pathname === '/estado') {
      // Monta o primeiro estado ANTES de escrever o cabecalho: falhando depois
      // do 200, a resposta fica pendurada e o navegador espera pra sempre — sem
      // erro, sem tela, sem pista.
      let primeiro;
      try {
        primeiro = JSON.stringify({ ...snapshot(), vitais });
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ erro: `nao consegui ler o estado: ${err.message}` }));
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`data: ${primeiro}\n\n`);
      clientes.add(res);
      req.on('close', () => clientes.delete(res));
      return;
    }

    // Comando digitado na caixa do HUD. Mesmo caminho da voz: um router so.
    if (url.pathname === '/comando' && req.method === 'POST') {
      let corpo = '';
      req.on('data', (c) => (corpo += c));
      req.on('end', async () => {
        try {
          const { texto } = JSON.parse(corpo || '{}');
          const r = await route(String(texto || ''), { source: 'hud' });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, reply: r.reply }));
        } catch (err) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: err.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  }

  // Uma falha ao montar o snapshot NAO pode derrubar o HUD. Ele roda dentro de
  // um setInterval, e excecao em callback de timer nao tem quem pegue: sobe
  // como uncaught e mata o processo. Do lado de fora isso aparece como "sem
  // conexao com o nucleo" numa janela que continua aberta — o sintoma nao diz
  // que o servidor morreu, e o terminal ja foi fechado.
  const emitir = () => {
    if (!clientes.size) return;

    let linha;
    try {
      linha = `data: ${JSON.stringify({ ...snapshot(), vitais })}\n\n`;
    } catch (err) {
      console.error(`[hud] falhei ao montar o estado: ${err.message}`);
      return;
    }

    for (const c of clientes) {
      try {
        c.write(linha);
      } catch {
        clientes.delete(c);
      }
    }
  };

  const tickEstado = setInterval(emitir, CADENCIA_ESTADO);

  // Os vitais rodam soltos do envio: se um PowerShell demorar, o HUD continua
  // atualizando o resto com o ultimo valor conhecido em vez de congelar.
  const tickVitais = setInterval(async () => {
    if (!clientes.size) return;
    try {
      const { vitais: ler } = await import('../skills/hardware.js');
      vitais = await ler();
    } catch {
      // Fora do Windows, ou sem nvidia-smi: segue com o que tem.
    }
  }, CADENCIA_VITAIS);

  // Rede e disco falham de formas que nao da pra prever uma a uma. O HUD e um
  // painel: ficar de pe mostrando dado velho e melhor que sumir.
  servidor.on('error', (err) => console.error(`[hud] erro no servidor: ${err.message}`));
  process.on('unhandledRejection', (err) =>
    console.error(`[hud] promessa rejeitada sem tratamento: ${err?.message || err}`)
  );

  servidor.listen(port, host);

  return {
    port,
    stop() {
      clearInterval(tickEstado);
      clearInterval(tickVitais);
      for (const c of clientes) c.end();
      servidor.close();
    },
  };
}
