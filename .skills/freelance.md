# Skill: freelance

Monitorar vagas novas em plataformas de freelance.

## O limite real (leia antes de configurar)

**Workana e Fiverr não têm API pública de freelancer.** Não existe endpoint
oficial pra "meus jobs ativos", "propostas enviadas" ou "mensagens do cliente".
Qualquer coisa que prometa isso está raspando HTML autenticado, o que quebra a
cada mudança de layout e pode violar os termos de uso.

O que **funciona de forma estável** é o feed público de vagas. É nisso que esta
skill trabalha: ela busca os feeds que você cadastrar, guarda o que já viu e só
te avisa do que é novo.

Traduzindo: o JARVIS te avisa de **oportunidades novas**. Status de job em
andamento continua sendo coisa de abrir o site.

## Configurar

No `.env`, separado por vírgula:

```
FREELANCE_FEEDS=https://www.workana.com/jobs/rss?category=it-programming&language=pt
```

### Montando a URL do Workana

1. Abra a busca de projetos no Workana com os filtros que você usa
2. Ajuste os parâmetros na URL do feed:
   - `category=it-programming` — outras: `design-multimedia`, `writing-translation`, `marketing-sales`
   - `language=pt` — idioma dos projetos
   - `query=react` — palavra-chave

### Outras fontes que funcionam por RSS

| Fonte | Feed |
|---|---|
| We Work Remotely | `https://weworkremotely.com/categories/remote-programming-jobs.rss` |
| RemoteOK | `https://remoteok.com/remote-dev-jobs.rss` |
| Hacker News (quem contrata) | via `hnrss.org/whoishiring/jobs` |

Fiverr não publica feed de gigs. Se você vende lá, o caminho prático é
notificação por e-mail — fora do escopo desta skill.

## Usar

```
"tem vaga nova?"
"checa o workana"
"tem alguma vaga de react?"
```

O `check_freelance_jobs` aceita `keyword` pra filtrar e `include_seen` pra
mostrar também o que já tinha aparecido.

## Onde fica o estado

`vault/tasks/freelance-seen.json` — ids das vagas já mostradas, podados
automaticamente depois de 30 dias.

## Cookie autenticado (opcional, frágil)

`WORKANA_COOKIE` no `.env` é enviado junto nas requisições pro Workana. Serve
se você tiver um feed que exige sessão. Cookie expira; se parar de funcionar,
é isso. Não construa rotina em cima disso.
