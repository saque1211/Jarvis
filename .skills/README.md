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

## `speaks: true`

Marque assim a tool cuja saída **já é a resposta falada**:

```js
{ name: 'start_timer', speaks: true, /* ... */ }
```

Quando o comando é resolvido por uma tool `speaks` só, o router responde com a
saída dela direto, em vez de gastar mais uma ida ao modelo pra reescrever
"Timer de 10 minutos rodando." com outras palavras. Corta cerca de metade da
latência dos comandos de ação.

Só marque se a frase serve pra ser lida em voz alta sem edição. `start_timer`
devolve *"Timer de 10m rodando."* — serve. `system_stats` devolve um relatório
de quatro linhas — não serve, o modelo precisa destilar aquilo na parte que
responde a pergunta.

O atalho se desliga sozinho quando o comando parece ter mais de uma intenção
("abre o spotify **e** põe 10 minutos"), pra não perder a segunda ação.

`speaks` também aceita uma função, quando depende da entrada:

```js
{
  name: 'system_stats',
  speaks: (input) => Boolean(input?.focus) && input.focus !== 'tudo',
}
```

Com `focus=ram` a saída é *"Tem 9,8 de 16 GB de RAM livres."* — resposta pronta.
Sem foco é relatório de quatro linhas, e aí o modelo precisa destilar.

## Tools da mesma rodada rodam em paralelo

Quando o modelo pede duas tools de uma vez, o router executa as duas juntas —
o comando custa a mais lenta, não a soma. Se a sua tool depende do resultado de
outra, não confie na ordem: descreva a dependência na `description` pro modelo
pedir em rodadas separadas.

**A `description` da tool é o que faz o roteamento funcionar.** Ela é o único
sinal que o modelo tem pra escolher entre 99 tools. Diga *quando* usar, não só
*o que faz* — e cite as frases que o usuário realmente fala.

## As skills

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
| `timer.js` | Contagem regressiva, cronômetro, pomodoro |
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
