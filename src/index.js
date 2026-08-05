#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

const VAULT_PATH = process.env.VAULT_PATH || './vault';
const DAILY_PATH = path.join(VAULT_PATH, 'daily');

// Ensure directories exist
if (!fs.existsSync(DAILY_PATH)) {
  fs.mkdirSync(DAILY_PATH, { recursive: true });
}

/**
 * Get today's date in YYYY-MM-DD format
 */
function getTodayDate() {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

/**
 * Load today's vault entry
 */
function loadTodayLog() {
  const date = getTodayDate();
  const filePath = path.join(DAILY_PATH, `${date}.md`);

  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  return null;
}

/**
 * Save to today's vault entry
 */
function saveTodayLog(content) {
  const date = getTodayDate();
  const filePath = path.join(DAILY_PATH, `${date}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Main JARVIS interface
 */
async function jarvis(command) {
  console.log(`\n🎤 JARVIS: "${command}"\n`);

  // Build context from vault
  const todayLog = loadTodayLog();
  const vaultContext = `
Current vault entry for today:
${todayLog || 'No entry yet. Starting fresh.'}
`;

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-1',
      max_tokens: 1024,
      system: `You are JARVIS, a personal AI assistant.

Your mindset: SPEAK. ROUTE. REMEMBER. REPEAT.

You have access to the user's vault (their memory system). Use it to provide context-aware responses.

${vaultContext}

When the user asks you to do something:
1. SPEAK clearly - your response will be read aloud
2. ROUTE - take action (log to vault, fetch data, etc)
3. REMEMBER - store important info in the vault
4. REPEAT - build daily habits

Keep responses concise and actionable.`,
      messages: [
        {
          role: 'user',
          content: command,
        },
      ],
    });

    const result = response.content[0];
    if (result.type === 'text') {
      console.log(`✨ ${result.text}\n`);

      // Log to vault
      const date = getTodayDate();
      let log = loadTodayLog() || `# Daily Log — ${date}\n\n`;
      log += `\n## ${command}\n${result.text}\n`;
      saveTodayLog(log);

      return result.text;
    }
  } catch (error) {
    console.error('Error:', error.message);
    throw error;
  }
}

/**
 * CLI interface
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
╔════════════════════════════════════════╗
║      JARVIS OS — Personal Assistant    ║
║   Mindset: SPEAK. ROUTE. REMEMBER.    ║
╚════════════════════════════════════════╝

Usage: jarvis <command>

Commands:
  "Morning brief"    - Read today's inbox, calendar, news
  "Plan today"       - Set your top 3 priorities
  "Metrics pull"     - Get your numbers
  "Close the day"    - Reflect + log tomorrow's prep
  "Ask anything"     - Query the vault

Or pass any natural command and JARVIS will help.

Examples:
  jarvis "What's on my plate?"
  jarvis "Show me yesterday's progress"
  jarvis "Remember: I need to call Sarah today"
    `);
    process.exit(0);
  }

  const command = args.join(' ');
  await jarvis(command);
}

export { jarvis, loadTodayLog, saveTodayLog };

main().catch(console.error);
