require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  ActivityType,
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events,
} = require("discord.js");
const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} = require("@discordjs/voice");
const YTDlpWrap = require("yt-dlp-wrap").default;
const ffmpegPath = require("ffmpeg-static");

if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

const token = process.env.DISCORD_TOKEN;
const prefix = process.env.PREFIX || "!";
const instanceLockPath = path.join(__dirname, "..", ".bot-instance.lock");
const ytDlpStatePath = path.join(__dirname, "..", ".cache", "yt-dlp-state.json");

const ytDlpAutoUpdateHours = Number.parseInt(process.env.YTDLP_AUTO_UPDATE_HOURS || "24", 10);
const streamRetryCount = Number.parseInt(process.env.STREAM_RETRY_COUNT || "2", 10);
const healthcheckVideoId = process.env.HEALTHCHECK_VIDEO_ID || "dQw4w9WgXcQ";
const commandDedupeDelayMs = Number.parseInt(process.env.COMMAND_DEDUPE_DELAY_MS || "450", 10);
const idleTimeoutMs = 5 * 60 * 1000;

let hasInstanceLock = false;

function toPositiveInt(value, fallback) {
  if (Number.isInteger(value) && value >= 0) {
    return value;
  }

  return fallback;
}

const safeYtDlpAutoUpdateHours = toPositiveInt(ytDlpAutoUpdateHours, 24);
const safeStreamRetryCount = toPositiveInt(streamRetryCount, 2);
const safeCommandDedupeDelayMs = toPositiveInt(commandDedupeDelayMs, 450);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function releaseInstanceLock() {
  if (!hasInstanceLock) return;

  try {
    fs.unlinkSync(instanceLockPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("[LOCK] Failed to release instance lock:", error.message);
    }
  } finally {
    hasInstanceLock = false;
  }
}

function acquireInstanceLock() {
  if (fs.existsSync(instanceLockPath)) {
    try {
      const existing = fs.readFileSync(instanceLockPath, "utf8").trim();
      const existingPid = Number.parseInt(existing, 10);

      if (isProcessAlive(existingPid) && existingPid !== process.pid) {
        console.error(
          `[LOCK] Another bot instance is already running (PID ${existingPid}). Exiting.`
        );
        process.exit(1);
      }
    } catch {
      // If lock file is unreadable, we still attempt to replace it safely below.
    }

    try {
      fs.unlinkSync(instanceLockPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error("[LOCK] Could not clear stale lock file:", error.message);
        process.exit(1);
      }
    }
  }

  try {
    fs.writeFileSync(instanceLockPath, String(process.pid), { flag: "wx" });
    hasInstanceLock = true;
  } catch (error) {
    console.error("[LOCK] Failed to acquire instance lock:", error.message);
    process.exit(1);
  }
}

acquireInstanceLock();

process.on("exit", () => {
  releaseInstanceLock();
});

process.on("SIGINT", () => {
  releaseInstanceLock();
  process.exit(0);
});

process.on("SIGTERM", () => {
  releaseInstanceLock();
  process.exit(0);
});

process.on("SIGUSR2", () => {
  releaseInstanceLock();
  process.kill(process.pid, "SIGUSR2");
});

if (!token) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const queues = new Map();
const ytDlpBinaryName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
const ytDlpPath = path.join(__dirname, "..", "bin", ytDlpBinaryName);
const ytDlp = new YTDlpWrap(ytDlpPath);

let ytDlpReadyPromise = null;
let currentPresenceKey = "";

function setPresence(activityText, type = ActivityType.Playing, status = "online") {
  if (!client.user) return;

  const trimmedText = String(activityText || "").slice(0, 120);
  const key = `${status}:${type}:${trimmedText}`;
  if (key === currentPresenceKey) return;

  currentPresenceKey = key;
  try {
    client.user.setPresence({
      status,
      activities: [{ name: trimmedText, type }],
    });
  } catch (error) {
    console.warn("[PRESENCE] Failed to update presence:", error.message);
  }
}

function setHealthyPresence() {
  let nowPlaying = null;

  for (const queue of queues.values()) {
    if (queue.nowPlaying) {
      nowPlaying = queue.nowPlaying;
      break;
    }
  }

  if (nowPlaying?.title) {
    const shortTitle = nowPlaying.title.slice(0, 100);
    setPresence(`Now playing: ${shortTitle}`, ActivityType.Playing);
    return;
  }

  setPresence(`Ready | ${prefix}play`, ActivityType.Listening);
}

function readYtDlpState() {
  try {
    if (!fs.existsSync(ytDlpStatePath)) {
      return {};
    }

    const raw = fs.readFileSync(ytDlpStatePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeYtDlpState(nextState) {
  fs.mkdirSync(path.dirname(ytDlpStatePath), { recursive: true });
  fs.writeFileSync(ytDlpStatePath, JSON.stringify(nextState, null, 2));
}

async function getYtDlpVersion() {
  const output = await ytDlp.execPromise(["--version"]);
  return String(output).trim().split(/\r?\n/)[0] || "unknown";
}

function shouldAutoUpdateYtDlp(state) {
  if (safeYtDlpAutoUpdateHours <= 0) {
    return false;
  }

  const lastUpdatedAt = state.lastUpdatedAt;
  if (!lastUpdatedAt) {
    return true;
  }

  const parsed = Date.parse(lastUpdatedAt);
  if (Number.isNaN(parsed)) {
    return true;
  }

  const maxAgeMs = safeYtDlpAutoUpdateHours * 60 * 60 * 1000;
  return Date.now() - parsed >= maxAgeMs;
}

async function downloadOrUpdateYtDlp(reason) {
  setPresence("Updating yt-dlp", ActivityType.Playing, "idle");
  console.log(`[YTDLP] Updating binary (${reason})...`);
  await YTDlpWrap.downloadFromGithub(ytDlpPath);

  const state = readYtDlpState();
  let version = "unknown";

  try {
    version = await getYtDlpVersion();
  } catch {
    // Version lookup can fail temporarily; keep update metadata anyway.
  }

  writeYtDlpState({
    ...state,
    lastUpdatedAt: new Date().toISOString(),
    lastUpdateReason: reason,
    version,
  });

  setHealthyPresence();
}

function getGuildNameById(guildId) {
  return client.guilds.cache.get(guildId)?.name || guildId;
}

async function ensureYtDlpReady() {
  if (ytDlpReadyPromise) {
    return ytDlpReadyPromise;
  }

  ytDlpReadyPromise = (async () => {
    if (!fs.existsSync(ytDlpPath)) {
      fs.mkdirSync(path.dirname(ytDlpPath), { recursive: true });
      await downloadOrUpdateYtDlp("missing-binary");
      console.log(`[YTDLP] Binary ready at ${ytDlpPath}`);
      return;
    }

    const state = readYtDlpState();
    if (shouldAutoUpdateYtDlp(state)) {
      try {
        await downloadOrUpdateYtDlp("scheduled-auto-update");
      } catch (error) {
        console.warn(`[YTDLP] Auto-update skipped: ${error.message}`);
      }
    }
  })();

  return ytDlpReadyPromise;
}

async function resolveDirectAudioUrl(videoUrl) {
  await ensureYtDlpReady();

  const output = await ytDlp.execPromise([
    "--no-warnings",
    "--no-playlist",
    "-f",
    "bestaudio",
    "-g",
    videoUrl,
  ]);

  const directUrl = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!directUrl) {
    throw new Error("yt-dlp returned an empty stream URL");
  }

  return directUrl;
}

async function buildAudioResourceWithRetry(queue, song) {
  const totalAttempts = safeStreamRetryCount + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      const directAudioUrl = await resolveDirectAudioUrl(song.url);
      return createYouTubeAudioResource(directAudioUrl, queue);
    } catch (error) {
      lastError = error;
      setPresence("Fixing playback", ActivityType.Playing, "idle");
      stopActiveTranscoder(queue);
      console.warn(
        `[PLAYBACK] guild=${queue.guildName} attempt=${attempt}/${totalAttempts} failed: ${error.message}`
      );

      if (attempt >= totalAttempts) {
        break;
      }

      await recreateVoiceConnection(queue).catch(() => {
        // Best effort reconnect before another extraction attempt.
      });
      await ensureVoiceConnectionReady(queue).catch(() => {
        // Best effort only; retry loop handles final failure.
      });
    }
  }

  throw lastError || new Error("Unknown playback failure");
}

async function getHealthStatus(message) {
  const queue = getQueue(message.guild.id);
  const state = readYtDlpState();

  let ytDlpVersion = "unknown";
  let ytDlpProbe = "not-run";

  try {
    await ensureYtDlpReady();
    ytDlpVersion = await getYtDlpVersion();

    await resolveDirectAudioUrl(`https://www.youtube.com/watch?v=${healthcheckVideoId}`);
    ytDlpProbe = "ok";
  } catch (error) {
    ytDlpProbe = `failed (${error.message})`;
  }

  return [
    `pid: ${process.pid}`,
    `uptime_s: ${Math.floor(process.uptime())}`,
    `instance_lock: ${hasInstanceLock ? "held" : "not-held"}`,
    `queue_size: ${queue?.songs.length || 0}`,
    `voice_state: ${queue?.connection?.state?.status || "none"}`,
    `yt_dlp_version: ${ytDlpVersion}`,
    `yt_dlp_last_update: ${state.lastUpdatedAt || "unknown"}`,
    `yt_dlp_probe: ${ytDlpProbe}`,
    `stream_retries: ${safeStreamRetryCount}`,
  ].join("\n");
}

async function notifyQueue(queue, content) {
  if (!queue?.textChannelId) return;

  try {
    const channel = await client.channels.fetch(queue.textChannelId);
    if (channel?.isTextBased()) {
      await channel.send(content);
    }
  } catch (error) {
    console.error("Failed to send queue notification:", error);
  }
}

async function alreadyHandledByBotReply(message) {
  try {
    const recent = await message.channel.messages.fetch({ limit: 15 });
    return recent.some(
      (entry) =>
        entry.author.id === client.user.id && entry.reference?.messageId === message.id
    );
  } catch {
    return false;
  }
}

function isLikelyYouTubeVideoUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtu.be") {
      return url.pathname.length > 1;
    }

    if (host === "youtube.com" || host === "m.youtube.com") {
      return url.pathname === "/watch" && Boolean(url.searchParams.get("v"));
    }

    return false;
  } catch {
    return false;
  }
}

function getQueue(guildId) {
  return queues.get(guildId);
}

function clearIdleTimer(queue) {
  if (!queue?.idleTimer) return;

  clearTimeout(queue.idleTimer);
  queue.idleTimer = null;
}

function scheduleIdleDisconnect(queue) {
  clearIdleTimer(queue);

  queue.idleTimer = setTimeout(async () => {
    if (!queues.has(queue.guildId)) return;
    if (queue.songs.length > 0 || queue.nowPlaying) return;

    await notifyQueue(queue, "Idle for 5 minutes. Leaving voice channel.");
    destroyQueue(queue.guildId);
  }, idleTimeoutMs);
}

function bindConnectionHandlers(queue, connection, guildName) {
  connection.on("stateChange", (oldState, newState) => {
    if (oldState.status !== newState.status) {
      console.log(
        `[VOICE] guild=${guildName} state=${oldState.status} -> ${newState.status}`
      );
    }
  });

  connection.on("error", (error) => {
    console.error(`[VOICE] guild=${guildName} connection error:`, error);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    // Ignore stale events from an old connection that has already been replaced.
    if (queue.connection !== connection) return;

    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroyQueue(queue.guildId);
    }
  });
}

function createQueue(guild, voiceChannel) {
  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
  });

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  const queue = {
    guildId: guild.id,
    guildName: guild.name,
    textChannelId: null,
    voiceChannelId: voiceChannel.id,
    adapterCreator: guild.voiceAdapterCreator,
    connection,
    player,
    songs: [],
    nowPlaying: null,
    idleTimer: null,
    activeTranscoder: null,
    lock: false,
  };

  connection.subscribe(player);
  queues.set(guild.id, queue);
  bindConnectionHandlers(queue, connection, guild.name);

  player.on(AudioPlayerStatus.Idle, async () => {
    console.log(`[AUDIO] guild=${guild.name} status=idle`);
    stopActiveTranscoder(queue);
    queue.nowPlaying = null;
    queue.songs.shift();
    setHealthyPresence();
    if (queue.songs.length === 0) {
      scheduleIdleDisconnect(queue);
    }
    await playNext(queue);
  });

  player.on(AudioPlayerStatus.Playing, () => {
    clearIdleTimer(queue);
    const current = queue.songs[0];
    const shortTitle = current?.title ? current.title.slice(0, 100) : "Music";
    setPresence(`Now playing: ${shortTitle}`, ActivityType.Playing);
    console.log(
      `[AUDIO] guild=${guild.name} status=playing title="${current?.title || "unknown"}"`
    );
  });

  player.on("error", async (error) => {
    setPresence("Fixing playback", ActivityType.Playing, "idle");
    console.error("Audio player error:", error);
    await notifyQueue(queue, "Playback error. Skipping to the next track.");
    stopActiveTranscoder(queue);
    queue.nowPlaying = null;
    queue.songs.shift();
    await playNext(queue);
  });

  return queue;
}

function destroyQueue(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;

  clearIdleTimer(queue);
  stopActiveTranscoder(queue);
  queue.player.stop();
  queue.connection.destroy();
  queues.delete(guildId);
  setHealthyPresence();
}

function stopActiveTranscoder(queue) {
  if (!queue?.activeTranscoder) return;

  const proc = queue.activeTranscoder;
  queue.activeTranscoder = null;

  if (!proc.killed) {
    proc.kill();
  }
}

async function recreateVoiceConnection(queue) {
  setPresence("Restarting voice", ActivityType.Playing, "idle");
  const guild = client.guilds.cache.get(queue.guildId);
  if (!guild) {
    throw new Error("Guild not found for voice reconnect");
  }

  const voiceChannel = guild.channels.cache.get(queue.voiceChannelId);
  if (!voiceChannel?.isVoiceBased()) {
    throw new Error("Voice channel no longer available");
  }

  try {
    queue.connection.destroy();
  } catch {
    // Ignore destroy errors during reconnect attempts.
  }

  const connection = joinVoiceChannel({
    channelId: queue.voiceChannelId,
    guildId: queue.guildId,
    adapterCreator: queue.adapterCreator,
    selfDeaf: true,
  });

  queue.connection = connection;
  connection.subscribe(queue.player);
  bindConnectionHandlers(queue, connection, queue.guildName);
  setHealthyPresence();
}

async function ensureVoiceConnectionReady(queue) {
  if (queue.connection.state.status === VoiceConnectionStatus.Ready) {
    return true;
  }

  try {
    await entersState(queue.connection, VoiceConnectionStatus.Ready, 12_000);
    return true;
  } catch {
    console.warn(
      `[VOICE] guildId=${queue.guildId} ready-timeout status=${queue.connection.state.status}; recreating connection`
    );
  }

  try {
    await recreateVoiceConnection(queue);
    await entersState(queue.connection, VoiceConnectionStatus.Ready, 12_000);
    return true;
  } catch {
    console.warn(
      `[VOICE] guildId=${queue.guildId} reconnect-failed status=${queue.connection.state.status}`
    );
    return false;
  }
}

async function resolveSong(url, requestedBy) {
  await ensureYtDlpReady();
  const output = await ytDlp.execPromise([
    "--no-warnings",
    "--no-playlist",
    "--dump-single-json",
    url,
  ]);

  const details = JSON.parse(String(output));
  const resolvedUrl =
    details.webpage_url ||
    (details.id ? `https://www.youtube.com/watch?v=${details.id}` : url);

  const durationSeconds = Number.parseInt(details.duration || "0", 10);
  const duration =
    durationSeconds > 0
      ? new Date(durationSeconds * 1000).toISOString().slice(11, 19).replace(/^00:/, "")
      : "Live";

  return {
    title: details.title || "Unknown title",
    url: resolvedUrl,
    duration,
    thumbnail: details.thumbnail || null,
    requestedBy,
  };
}

function createYouTubeAudioResource(directUrl, queue) {
  const ffmpeg = spawn(
    ffmpegPath,
    [
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",
      "-i",
      directUrl,
      "-analyzeduration",
      "0",
      "-vn",
      "-loglevel",
      "error",
      "-c:a",
      "libopus",
      "-b:a",
      "128k",
      "-f",
      "ogg",
      "pipe:1",
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  queue.activeTranscoder = ffmpeg;

  ffmpeg.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      console.error(`[FFMPEG] guild=${getGuildNameById(queue.guildId)} ${text}`);
    }
  });

  ffmpeg.on("close", (code, signal) => {
    if (queue.activeTranscoder === ffmpeg) {
      queue.activeTranscoder = null;
    }

    if (code !== 0 && signal !== "SIGTERM") {
      console.warn(
        `[FFMPEG] guild=${getGuildNameById(queue.guildId)} exited code=${code} signal=${signal || "none"}`
      );
    }
  });

  return createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.OggOpus,
  });
}

async function playNext(queue) {
  if (queue.lock) return;
  if (!queue.songs.length) {
    queue.player.stop();
    return;
  }

  queue.lock = true;
  const song = queue.songs[0];
  queue.nowPlaying = song;

  try {
    const ready = await ensureVoiceConnectionReady(queue);
    if (!ready) {
      await notifyQueue(
        queue,
        "I couldn't establish a voice connection. Please reconnect me with !stop then !play."
      );
      queue.songs.shift();
      queue.nowPlaying = null;
      return;
    }

    const resource = await buildAudioResourceWithRetry(queue, song);

    if (resource.volume) {
      resource.volume.setVolume(0.6);
    }
    queue.player.play(resource);
  } catch (error) {
    console.error("Failed to stream song:", error);
    await notifyQueue(queue, `Failed to play **${song.title}**. Skipping.`);
    stopActiveTranscoder(queue);
    queue.songs.shift();
    queue.nowPlaying = null;
  } finally {
    queue.lock = false;

    if (!queue.nowPlaying && queue.songs.length) {
      await playNext(queue);
    }
  }
}

async function sendNowPlaying(message, song) {
  const embed = new EmbedBuilder()
    .setColor(0x1f8b4c)
    .setTitle("Now Playing")
    .setDescription(`[${song.title}](${song.url})`)
    .addFields(
      { name: "Duration", value: song.duration, inline: true },
      { name: "Requested by", value: song.requestedBy, inline: true }
    );

  if (song.thumbnail) {
    embed.setThumbnail(song.thumbnail);
  }

  await message.channel.send({ embeds: [embed] });
}

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  setPresence("Starting up", ActivityType.Playing, "idle");
  ensureYtDlpReady().catch((error) => {
    console.error("[YTDLP] Failed to prepare yt-dlp binary:", error);
  }).finally(() => {
    setHealthyPresence();
  });
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(prefix)) return;

  const [command, ...rest] = message.content
    .slice(prefix.length)
    .trim()
    .split(/\s+/);

  if (!command) return;

  const cmd = command.toLowerCase();
  const argsText = rest.join(" ");
  console.log(
    `[CMD] user=${message.author.tag} guild=${message.guild.name} channel=#${message.channel.name} command=${cmd} args="${argsText}"`
  );

  const jitterMs = Math.floor(Math.random() * 150);
  await sleep(safeCommandDedupeDelayMs + jitterMs);
  if (await alreadyHandledByBotReply(message)) {
    console.log(`[CMD] skipped duplicate handling for message=${message.id}`);
    return;
  }

  if (cmd === "play") {
    const url = rest[0];

    if (!url) {
      await message.reply(`Usage: ${prefix}play <youtube_url>`);
      return;
    }

    if (!isLikelyYouTubeVideoUrl(url)) {
      await message.reply("Please provide a valid YouTube video URL.");
      return;
    }

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      await message.reply("Join a voice channel first.");
      return;
    }

    const permissions = voiceChannel.permissionsFor(message.client.user);
    if (!permissions?.has("Connect") || !permissions.has("Speak")) {
      await message.reply("I need permission to connect and speak in your voice channel.");
      return;
    }

    let queue = getQueue(message.guild.id);

    if (!queue) {
      queue = createQueue(message.guild, voiceChannel);
    } else if (queue.voiceChannelId !== voiceChannel.id) {
      await message.reply("You must be in the same voice channel as the bot.");
      return;
    }

    try {
      const song = await resolveSong(url, message.author.username);
      queue.textChannelId = message.channel.id;
      queue.songs.push(song);
      clearIdleTimer(queue);

      const shouldStart = queue.songs.length === 1 && !queue.nowPlaying;
      if (shouldStart) {
        await playNext(queue);
        if (queue.nowPlaying) {
          await sendNowPlaying(message, queue.nowPlaying);
        }
      } else {
        await message.reply(`Queued: **${song.title}**`);
      }
    } catch (error) {
      console.error("Unable to queue song:", error);
      await message.reply("I couldn't read that YouTube link.");
    }

    return;
  }

  if (cmd === "skip") {
    const queue = getQueue(message.guild.id);
    if (!queue || !queue.songs.length) {
      await message.reply("Nothing is playing right now.");
      return;
    }

    stopActiveTranscoder(queue);
    queue.player.stop(true);
    await message.reply("Skipped.");
    return;
  }

  if (cmd === "pause") {
    const queue = getQueue(message.guild.id);
    if (!queue || !queue.nowPlaying) {
      await message.reply("Nothing is playing right now.");
      return;
    }

    const paused = queue.player.pause(true);
    if (!paused) {
      await message.reply("Playback is already paused.");
      return;
    }

    await message.reply("Paused.");
    return;
  }

  if (cmd === "resume") {
    const queue = getQueue(message.guild.id);
    if (!queue || !queue.nowPlaying) {
      await message.reply("Nothing is playing right now.");
      return;
    }

    const resumed = queue.player.unpause();
    if (!resumed) {
      await message.reply("Playback is not paused.");
      return;
    }

    await message.reply("Resumed.");
    return;
  }

  if (cmd === "stop") {
    const queue = getQueue(message.guild.id);
    if (!queue) {
      await message.reply("Nothing to stop.");
      return;
    }

    destroyQueue(message.guild.id);
    await message.reply("Stopped playback and left the voice channel.");
    return;
  }

  if (cmd === "queue") {
    const queue = getQueue(message.guild.id);
    if (!queue || !queue.songs.length) {
      await message.reply("Queue is empty.");
      return;
    }

    const lines = queue.songs.slice(0, 10).map((song, idx) => {
      const marker = idx === 0 ? "Now" : `${idx}.`;
      return `${marker} ${song.title}`;
    });

    await message.reply(lines.join("\n"));
    return;
  }

  if (cmd === "help") {
    await message.reply(
      [
        "Commands:",
        `${prefix}play <youtube_url>`,
        `${prefix}pause`,
        `${prefix}resume`,
        `${prefix}skip`,
        `${prefix}stop`,
        `${prefix}queue`,
        `${prefix}health`,
        `${prefix}help`,
      ].join("\n")
    );
    return;
  }

  if (cmd === "health") {
    const status = await getHealthStatus(message);
    await message.reply(`Health:\n${status}`);
  }
});

client.login(token);
