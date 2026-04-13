/**
 * Add a new user agent for NanoClaw meeting prep.
 * Creates the group directory, copies shared config, and registers the Slack channel.
 *
 * Usage:
 *   npx tsx scripts/add-user.ts --name caie --slack-channel-id C0XXXXXX
 *
 * Options:
 *   --name           User's first name (lowercase). Used for directory naming.
 *   --slack-channel-id  Slack channel/DM ID (starts with C or D).
 *   --template       Group to copy CLAUDE.md from (default: slack_main).
 *   --no-register    Skip database registration (just create files).
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { execSync } from 'child_process';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

function parseArgs(): {
  name: string;
  slackChannelId: string;
  template: string;
  register: boolean;
} {
  const args = process.argv.slice(2);
  let name = '';
  let slackChannelId = '';
  let template = 'slack_main';
  let register = true;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--name':
        name = args[++i]?.toLowerCase() || '';
        break;
      case '--slack-channel-id':
        slackChannelId = args[++i] || '';
        break;
      case '--template':
        template = args[++i] || 'slack_main';
        break;
      case '--no-register':
        register = false;
        break;
    }
  }

  if (!name) {
    console.error('Error: --name is required');
    console.error(
      'Usage: npx tsx scripts/add-user.ts --name caie --slack-channel-id C0XXXXXX',
    );
    process.exit(1);
  }

  if (!slackChannelId && register) {
    console.error('Error: --slack-channel-id is required (or use --no-register)');
    process.exit(1);
  }

  return { name, slackChannelId, template, register };
}

function main(): void {
  const { name, slackChannelId, template, register } = parseArgs();

  const groupFolder = `slack_${name}`;
  const groupDir = join(PROJECT_ROOT, 'groups', groupFolder);
  const templateDir = join(PROJECT_ROOT, 'groups', template);
  const refDir = join(groupDir, 'reference');

  console.log(`\n=== Adding user: ${name} ===\n`);

  // Check if already exists
  if (existsSync(groupDir)) {
    console.log(`Group directory already exists: ${groupDir}`);
    console.log('Updating shared files only (personal tokens untouched).\n');
  } else {
    console.log(`Creating group directory: ${groupDir}`);
    mkdirSync(groupDir, { recursive: true });
  }

  // Create reference directory
  mkdirSync(refDir, { recursive: true });

  // Copy CLAUDE.md from template
  const templateClaudeMd = join(templateDir, 'CLAUDE.md');
  const targetClaudeMd = join(groupDir, 'CLAUDE.md');
  if (existsSync(templateClaudeMd)) {
    if (!existsSync(targetClaudeMd)) {
      copyFileSync(templateClaudeMd, targetClaudeMd);
      console.log(`Copied CLAUDE.md from ${template}`);
    } else {
      console.log('CLAUDE.md already exists — skipping (won\'t overwrite customizations)');
    }
  } else {
    console.error(`Warning: Template CLAUDE.md not found at ${templateClaudeMd}`);
  }

  // Copy .mcp.json (LC MCP config — shared org-level token)
  const templateMcpJson = join(templateDir, '.mcp.json');
  const targetMcpJson = join(groupDir, '.mcp.json');
  if (existsSync(templateMcpJson)) {
    copyFileSync(templateMcpJson, targetMcpJson);
    console.log('Copied .mcp.json (LC MCP config)');
  }

  // Copy shared reference files (NOT personal tokens)
  const sharedRefFiles = [
    'google-credentials.json', // Same GCP OAuth client for all users
    'slack-bot-token.txt',     // Same Slack bot for all users
  ];

  const templateRefDir = join(templateDir, 'reference');
  for (const file of sharedRefFiles) {
    const src = join(templateRefDir, file);
    const dst = join(refDir, file);
    if (existsSync(src)) {
      copyFileSync(src, dst);
      console.log(`Copied shared: ${file}`);
    } else {
      console.log(`Shared file not found (skipping): ${file}`);
    }
  }

  // Check for personal tokens (don't copy — these must be generated per-user)
  const personalTokens = ['google-token.json', 'granola-token.json'];
  const missingTokens: string[] = [];
  for (const file of personalTokens) {
    if (!existsSync(join(refDir, file))) {
      missingTokens.push(file);
    }
  }

  // Register the Slack channel
  if (register && slackChannelId) {
    console.log(`\nRegistering Slack channel: slack:${slackChannelId}`);
    try {
      const registerCmd = [
        'npx tsx setup/index.ts --step register --',
        `--jid "slack:${slackChannelId}"`,
        `--name "slack-${name}"`,
        `--folder "${groupFolder}"`,
        `--trigger "@Clawbot"`,
        '--channel slack',
        '--no-trigger-required',
      ].join(' ');

      const output = execSync(registerCmd, {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (output.includes('STATUS: success')) {
        console.log('Channel registered successfully');
      } else {
        console.log('Registration output:', output.slice(-200));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint')) {
        console.log('Channel already registered — skipping');
      } else {
        console.error(`Registration failed: ${msg}`);
      }
    }
  }

  // Summary
  console.log('\n=== Setup Summary ===\n');
  console.log(`User:           ${name}`);
  console.log(`Group folder:   groups/${groupFolder}/`);
  console.log(`Slack channel:  slack:${slackChannelId || '(not registered)'}`);
  console.log(`CLAUDE.md:      ${existsSync(targetClaudeMd) ? '✓' : '✗'}`);
  console.log(`LC MCP config:  ${existsSync(targetMcpJson) ? '✓' : '✗'}`);
  console.log(`Google creds:   ${existsSync(join(refDir, 'google-credentials.json')) ? '✓' : '✗'}`);
  console.log(`Slack bot:      ${existsSync(join(refDir, 'slack-bot-token.txt')) ? '✓' : '✗'}`);
  console.log(`Google token:   ${existsSync(join(refDir, 'google-token.json')) ? '✓ (authorized)' : '✗ (needs auth)'}`);
  console.log(`Granola token:  ${existsSync(join(refDir, 'granola-token.json')) ? '✓ (authorized)' : '✗ (needs auth)'}`);

  if (missingTokens.length > 0) {
    console.log('\n=== Next Steps ===\n');
    console.log(`${name} needs to authorize their personal accounts:\n`);
    if (missingTokens.includes('google-token.json')) {
      console.log(`  Google Calendar + Gmail:`);
      console.log(`    npx tsx scripts/google-auth.ts --token groups/${groupFolder}/reference/google-token.json\n`);
    }
    if (missingTokens.includes('granola-token.json')) {
      console.log(`  Granola meeting notes:`);
      console.log(`    npx tsx scripts/granola-auth.ts --token groups/${groupFolder}/reference/granola-token.json\n`);
    }
  } else {
    console.log('\nAll tokens present — user is fully authorized.');
  }

  console.log('After auth, restart NanoClaw to pick up the new agent:');
  console.log('  launchctl kickstart -k gui/$(id -u)/com.nanoclaw\n');
}

main();
