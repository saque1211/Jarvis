# Skills

Cada arquivo `src/skills/*.js` exporta um conjunto de **tools** que o Claude
pode chamar. O roteador (`src/core/router.js`) entrega todas elas de uma vez e
deixa o modelo escolher — não existe lista de comandos fixos.

## Anatomia de uma skill

```js
export default {
  name: 'exemplo',
  description: 'O que essa skill cobre.',
  tools: [
    {
      name: 'fazer_algo',
      description: 'Quando usar. Escreva pensando no modelo lendo isso.',
      input_schema: {
        type: 'object',
        properties: { alvo: { type: 'string', description: '...' } },
        required: ['alvo'],
      },
      handler: async ({ alvo }, ctx) => `Fiz em ${alvo}.`,
    },
  ],
};
```

Coloque o arquivo em `src/skills/` e pronto — o registry carrega sozinho no
próximo boot. Nomes de tool são globais, então não pode repetir.

**A `description` da tool é o que faz o roteamento funcionar.** Ela é o único
sinal que o modelo tem pra escolher entre 92 tools. Diga *quando* usar, não só
*o que faz* — e cite as frases que o usuário realmente fala.

## As 15 skills

| Arquivo | Cobre |
|---|---|
| `apps.js` | Abrir/fechar aplicativos, focar janelas |
| `exec.js` | Scripts Python/PowerShell, automações salvas, tarefas agendadas |
| `search.js` | Web, GitHub, Stack Overflow, npm, ler páginas |
| `tasks.js` | To-dos, prioridades do dia, anotações |
| `integrations.js` | Discord, Home Assistant, HTTP genérico |
| `files.js` | Criar/mover/copiar/organizar arquivos |
| `scaffold.js` | Projetos novos, componentes React, boilerplate |
| `hardware.js` | CPU/GPU/RAM, monitores, energia, Quest 3S |
| `media.js` | Spotify, YouTube, volume, teclas de mídia |
| `capture.js` | Screenshots, gravação de tela |
| `voice.js` | Controle da própria voz do JARVIS |
| `browser.js` | Abas, workspaces de abas, bookmarks |
| `freelance.js` | Feeds de vagas (Workana e afins) |
| `build.js` | Build, testes, git, GitHub Actions |
| `notify.js` | Lembretes, alarmes, notificações do Windows |
| `memory.js` | Consultar e alimentar o vault |

## Segurança

Três skills tocam em coisas irreversíveis e têm freio:

- **`exec.run_command`** — bloqueia padrões destrutivos (`rm -rf`, `format`,
  `git push --force`, `shutdown`) até o modelo pedir confirmação e chamar de
  novo com `confirmed=true`.
- **`files.*`** — só escreve dentro da sua home, da raiz do projeto e do que
  você listar em `JARVIS_ALLOWED_ROOTS`. `delete_file` exige `confirmed`.
- **`hardware.power_control`** — `restart` e `shutdown` exigem `confirmed`.

O system prompt reforça: **perguntar antes, não avisar depois.**
