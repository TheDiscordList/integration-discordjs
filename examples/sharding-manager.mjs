// discord.js ShardingManager. Nothing changes in your bot file: `autopost`
// detects `client.shard`, elects shard 0 to publish the aggregate server count,
// and lets every shard heartbeat for itself.
//
//   node examples/sharding-manager.mjs      <- the manager
//
// The bot file it spawns is examples/basic.mjs, unmodified.
import { ShardingManager } from 'discord.js';

const manager = new ShardingManager('./examples/basic.mjs', {
  token: process.env.DISCORD_TOKEN,
  totalShards: 'auto',
});

manager.on('shardCreate', (shard) => console.log(`Launched shard ${shard.id}`));

await manager.spawn();
