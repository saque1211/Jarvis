# JARVIS OS — Setup Guide

Follow these 4 steps to build your personal AI assistant.

---

## Step 1: Wire the Brain ✓
**Status: Done**

You have your five core skills:
- `metrics` — poll numbers
- `inbox` — read today's email
- `trends` — scan what's moving
- `plan` — write today's top 3
- `vault` — read + write memory

**Next:** Set up these skills in Claude Code.

---

## Step 2: Build the Memory ✓
**Status: Done**

Your vault structure:
```
vault/
  ├── daily/          ← Today's logs
  ├── weekly/         ← Weekly reviews
  ├── projects/       ← Active projects
  ├── people/         ← People you know
  ├── ideas/          ← Ideas to explore
  └── archive/        ← Old projects
```

**Next:** Create your first daily log entry.

---

## Step 3: Add the Voice
**Status: In Progress**

### What you need:
- [ ] Local STT (Whisper or similar)
- [ ] Local TTS (Piper or similar)
- [ ] Push-to-talk system (spacebar)
- [ ] Audio routing

### Time commitment
~15 minutes to wire

### Implementation:
1. Install Whisper for local speech recognition
2. Install Piper for local text-to-speech
3. Set up push-to-talk keybinding (spacebar)
4. Route audio through JARVIS commands

**Setup coming in next commit...**

---

## Step 4: Build the Face
**Status: Planned**

### What you need:
- [ ] Dark terminal HUD
- [ ] System vitals display
- [ ] Command deck
- [ ] Schedule viewer
- [ ] Live data from vault

### Design:
```
┌─ JARVIS OS ────────────────────────────────────────────┐
│                                                          │
│  System Vitals        Command Deck       Schedule       │
│  ├─ CPU: 45%         ├─ Next up: Plan   ├─ 7:00 Brief │
│  ├─ Memory: 62%      ├─ Command: talk   ├─ 9:00 Plan  │
│  ├─ Vault: OK        └─ Status: ready   ├─ 2:00 Metrics│
│                                         └─ 7:00 Close  │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 🎤 Push to talk (hold SPACE)                   │   │
│  │ listening... (after you press)                 │   │
│  └─────────────────────────────────────────────────┘   │
│                                                          │
│  Vault Quick Access                                     │
│  Today's log | Weekly review | Projects | People       │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Coming next...**

---

## Configuration

Copy `.env.example` to `.env` and set your keys:

```bash
cp .env.example .env
```

Edit `.env`:
```
CLAUDE_API_KEY=your_api_key_here
VOICE_ENABLED=true
VAULT_PATH=./vault
PORT=3000
```

---

## Daily Ritual

Every day, follow this sequence:

| Time | Action | Command |
|------|--------|---------|
| 🌙 7:00 AM | Morning Brief | "Morning brief" |
| ☀️ 9:00 AM | Plan Today | "Plan today" |
| 📊 2:00 PM | Metrics | "Metrics pull" |
| ✅ 7:00 PM | Reflect | "Close the day" |
| 🎤 Anytime | Ask Anything | "Ask anything" |

---

## Next Steps

1. [ ] Set up your `.env` file
2. [ ] Create your first vault entry
3. [ ] Implement voice integration (Step 3)
4. [ ] Build the terminal HUD (Step 4)
5. [ ] Run your first daily ritual

---

**Your voice is the interface. Consistency compounds.**
