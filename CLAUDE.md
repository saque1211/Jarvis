# JARVIS OS — Claude Code Project

Your personal AI assistant built with Claude.

## Project Overview

JARVIS is an operating system for your mind. It's a voice-first AI assistant that:

- **Wires the Brain** — Claude + Skills (metrics, inbox, trends, plan, vault)
- **Builds Memory** — Everything in the vault (vault/ directory)
- **Adds Voice** — Local STT/TTS (Whisper + Piper)
- **Builds the Face** — Dark terminal HUD with real-time data

## Mindset
```
SPEAK. ROUTE. REMEMBER. REPEAT.
```

## Architecture

### Directory Structure
```
jarvis/
├── src/                    # Core application
│   ├── index.js           # Main CLI interface
│   ├── skills/            # Skill implementations
│   └── voice/             # Voice integration
├── vault/                 # User's memory (local database)
│   ├── daily/            # Daily logs
│   ├── projects/         # Project notes
│   ├── people/           # People database
│   └── archive/          # Old projects
├── .skills/              # Skill definitions
├── config/               # Configuration templates
├── SETUP.md             # Step-by-step setup
└── README.md            # Project overview
```

## Quick Start

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env

# Run JARVIS
npm start "Morning brief"
npm start "Plan today"
npm start "Ask anything"
```

## Skills

- **metrics** — Poll your numbers (views, followers, etc)
- **inbox** — Read today's emails
- **trends** — Scan what's trending
- **plan** — Set your top 3 priorities
- **vault** — Query your memory

## Development

### Adding a New Skill
1. Create `.skills/skill-name.md` with documentation
2. Create `src/skills/skill-name.js` with implementation
3. Add to package.json scripts
4. Test with `npm start "skill command"`

### Next Steps
- [ ] Implement voice integration (Step 3)
- [ ] Build terminal HUD (Step 4)
- [ ] Add email integration
- [ ] Connect to analytics APIs
- [ ] Create scheduling system

## Configuration

See `.env.example` for all available options.

Key variables:
- `CLAUDE_API_KEY` — Your Claude API key
- `VAULT_PATH` — Where to store vault data
- `VOICE_ENABLED` — Enable/disable voice
- `PORT` — Server port (for future web UI)

---

**Your voice is the interface. Consistency compounds.**
