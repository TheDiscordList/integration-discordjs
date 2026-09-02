// The whole integration, for most bots, in every topology.
//
//   node examples/basic.mjs
//
// Environment: DISCORD_TOKEN, TDL_TOKEN.
import { Client, GatewayIntentBits } from 'discord.js';
import { autopost } from '@thediscordlist/discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const poster = autopost(client, process.env.TDL_TOKEN);

// Entirely optional. Without an 'error' listener the package logs a warning
// instead — it never throws an unhandled 'error' event at your process.
poster.on('posted', ({ type, status }) => console.log(`[tdl] ${type} -> ${status}`));
poster.on('error', (error) => console.error(`[tdl] ${error.type} failed`, error.message));
poster.on('disabled', ({ type, reason }) => console.warn(`[tdl] ${type} disabled: ${reason}`));

await client.login(process.env.DISCORD_TOKEN);
