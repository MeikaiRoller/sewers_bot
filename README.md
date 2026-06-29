# Sewers Bot (Discord YouTube Music Bot)

A Discord bot that joins a voice channel and plays audio from YouTube links.

## Features

- Play YouTube video links in voice chat
- Queue multiple songs
- Skip current song
- Stop playback and disconnect
- Auto-update `yt-dlp` on a configurable interval
- Automatic stream retry and voice reconnect attempts
- `!health` command for runtime diagnostics
- Single-instance lock to prevent duplicate bot processes

## Requirements

- Node.js 20+ (includes npm)
- A Discord bot token
- FFmpeg is bundled through `ffmpeg-static`

## Setup

1. Install Node.js from https://nodejs.org/
2. In this project folder, install dependencies:

   ```bash
   npm install
   ```

3. Create a `.env` file (copy from `.env.example`) and set your token:

   ```env
   DISCORD_TOKEN=your_bot_token_here
   PREFIX=!
   YTDLP_AUTO_UPDATE_HOURS=24
   STREAM_RETRY_COUNT=2
   HEALTHCHECK_VIDEO_ID=dQw4w9WgXcQ
   ```

4. Enable bot intents in the Discord Developer Portal:
   - Message Content Intent
   - Server Members Intent is not required for this bot

5. Invite your bot with these minimum permissions:
   - Send Messages
   - Read Message History
   - Connect
   - Speak

## Run

```bash
npm start
```

For development (auto-reload):

```bash
npm run dev
```

## Commands

- `!play <youtube_url>`
- `!pause`
- `!resume`
- `!skip`
- `!stop`
- `!queue`
- `!health`
- `!help`

## Automation

- `YTDLP_AUTO_UPDATE_HOURS`: `0` disables scheduled yt-dlp updates; default is `24`
- `STREAM_RETRY_COUNT`: retry attempts after the first failure; default is `2`
- `HEALTHCHECK_VIDEO_ID`: video id used by `!health` probe

## PM2 (optional)

PM2 is included in this project, so you do not need a global install.

1. Install dependencies if you have not already:

   ```bash
   npm install
   ```

2. Start bot as a managed single instance:

   ```bash
   npm run pm2:start
   ```

3. Useful PM2 commands:

   ```bash
   npm run pm2:logs
   npm run pm2:restart
   npm run pm2:stop
   ```

## Deploy On Render

This project includes a `render.yaml` for a Node background worker.

1. Push this repo to GitHub.
2. In Render, click **New +** -> **Blueprint** and select your repository.
3. Confirm it creates the `sewers-bot` worker from `render.yaml`.
4. Set `DISCORD_TOKEN` in Render environment variables.
5. Deploy.

Notes:

- Use a **Worker** service (not Web Service) because the bot does not serve HTTP.
- Render restarts workers automatically if the process exits.

## Notes

- YouTube streaming can break when YouTube changes internals. If playback fails, update dependencies first:

  ```bash
   npm update yt-dlp-wrap
  ```
