# Skill: timer

Contagem regressiva, cronômetro e pomodoro.

## O que você fala

### Timer (conta pra baixo)

```
"jarvis, põe 10 minutos"
"jarvis, marca 8 minutos pra massa"
"jarvis, timer de meia hora pro render"
"jarvis, uma hora e meia"
```

Durações que ele entende: `10 minutos`, `5 min`, `45s`, `1 hora`, `90 segundos`,
`meia hora`, `1 hora e meia`, `2 horas e 30`. Número solto vira minutos —
`"põe 25"` = 25 minutos.

### Cronômetro (conta pra cima)

```
"jarvis, começa a contar"
"jarvis, cronometra meu estudo"
"jarvis, marca uma volta"
"jarvis, pausa o cronômetro"
"jarvis, para o cronômetro"       → fala o total e grava no vault
```

### Pomodoro

```
"jarvis, pomodoro"                        → 25/5, 4 ciclos
"jarvis, pomodoro de 50 minutos"
"jarvis, 4 pomodoros pra gravar o vídeo"
```

**Se encadeia sozinho.** Fim do foco cria a pausa, fim da pausa cria o próximo
foco, até fechar os ciclos. Você não precisa reiniciar nada.

### Consultar e cancelar

```
"jarvis, quanto falta?"
"jarvis, cancela o timer da massa"
"jarvis, cancela o pomodoro"
"jarvis, cancela tudo"
"jarvis, que horas são?"
```

## Como funciona por dentro

Estado em `vault/tasks/timers.json`. Dois motivos pra estar em disco:

1. **Sobrevive a reinício** — fechou o terminal, os timers continuam
2. **O HUD lê o mesmo arquivo** — os dois enxergam a mesma verdade, sem
   servidor no meio

O tempo restante é **calculado na hora** a partir de `endsAt`, nunca guardado
como contador. Por isso nunca dessincroniza, mesmo se o processo travar por
alguns segundos.

Quem dispara é o daemon de voz, chamando `checkDueTimers()` **a cada segundo**
(lembretes rodam a cada 30s — timer precisa do segundo exato, lembrete não).

> **Consequência:** timer e pomodoro só disparam com `npm run listen` rodando.
> Sem o daemon, eles são criados e ficam guardados, mas ninguém toca o alarme.

## Pomodoro — a máquina de estados

```
work(1/4) ─fim→ break(1/4) ─fim→ work(2/4) ─fim→ break(2/4)
                                                     │
                              ┌──────────────────────┘
                              ↓
work(3/4) ─fim→ break(3/4) ─fim→ work(4/4) ─fim→ "pomodoro completo"
```

Cada transição cria o próximo timer e apaga o anterior. O último ciclo não
gera pausa — encerra.

## Campos que o HUD consome

`timerSnapshot()` devolve tudo já formatado pra desenhar:

```js
{
  timers: [{
    label: 'massa',
    kind: 'countdown',      // ou 'pomodoro'
    phase: null,            // 'work' | 'break' no pomodoro
    cycle: null,            // '2/4' no pomodoro
    remaining: '07:58',     // já formatado
    remainingMs: 477955,
    progress: 0.004,        // 0..1, pronto pro anel
    endsAt: '...'
  }],
  stopwatches: [{
    label: 'estudo',
    elapsed: '00:02',
    elapsedMs: 2040,
    paused: false,
    laps: 1
  }]
}
```

Timers já vêm ordenados por quem termina antes.
