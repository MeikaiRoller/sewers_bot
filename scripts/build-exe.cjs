const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const distBinDir = path.join(distDir, "bin");
const exePath = path.join(distDir, "sewers-bot.exe");
const pkgTarget = "node18-win-x64";

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeCopy(srcPath, destPath) {
  if (!fs.existsSync(srcPath)) {
    return false;
  }

  ensureDir(path.dirname(destPath));
  fs.copyFileSync(srcPath, destPath);
  return true;
}

function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

function run() {
  fs.rmSync(distDir, { recursive: true, force: true });
  ensureDir(distBinDir);

  console.log("[build] Bundling Node app with pkg...");
  const pkgCommand = [
    "npx pkg",
    `\"${path.join(rootDir, "package.json")}\"`,
    `--targets ${pkgTarget}`,
    `--output \"${exePath}\"`,
  ].join(" ");

  execSync(pkgCommand, {
    cwd: rootDir,
    stdio: "inherit",
  });

  console.log("[build] Copying runtime binaries...");
  const ffmpegPath = require("ffmpeg-static");
  const ffmpegDestName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  safeCopy(ffmpegPath, path.join(distBinDir, ffmpegDestName));

  const ytDlpSource = path.join(rootDir, "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  safeCopy(ytDlpSource, path.join(distBinDir, path.basename(ytDlpSource)));

  safeCopy(path.join(rootDir, ".env.example"), path.join(distDir, ".env.example"));
  safeCopy(path.join(rootDir, "README.md"), path.join(distDir, "README.md"));

  const headlessBat = [
    "@echo off",
    "cd /d %~dp0",
    "sewers-bot.exe",
  ].join("\r\n");

  const uiBat = [
    "@echo off",
    "cd /d %~dp0",
    "sewers-bot.exe --ui",
  ].join("\r\n");

  const watchdogBat = [
    "@echo off",
    "setlocal EnableExtensions EnableDelayedExpansion",
    "cd /d %~dp0",
    "set \"EXE=sewers-bot.exe\"",
    "set \"ARGS=\"",
    "set \"MAX_RESTARTS=20\"",
    "set \"RESTART_DELAY=5\"",
    "set \"ATTEMPT=0\"",
    ":loop",
    "if not exist \"%EXE%\" (",
    "  echo Missing %EXE%.",
    "  exit /b 1",
    ")",
    "echo Starting %EXE% (attempt !ATTEMPT! of %MAX_RESTARTS%)",
    "\"%EXE%\" %ARGS%",
    "set \"EXIT_CODE=%ERRORLEVEL%\"",
    "if \"%EXIT_CODE%\" == \"0\" (",
    "  echo Bot exited cleanly.",
    "  exit /b 0",
    ")",
    "set /a ATTEMPT+=1",
    "if !ATTEMPT! GTR %MAX_RESTARTS% (",
    "  echo Max restarts reached (%MAX_RESTARTS%). Exiting.",
    "  exit /b %EXIT_CODE%",
    ")",
    "echo Restarting in %RESTART_DELAY%s...",
    "timeout /t %RESTART_DELAY% /nobreak >nul",
    "goto loop",
  ].join("\r\n");

  const uiWatchdogBat = [
    "@echo off",
    "setlocal EnableExtensions EnableDelayedExpansion",
    "cd /d %~dp0",
    "set \"EXE=sewers-bot.exe\"",
    "set \"ARGS=--ui\"",
    "set \"MAX_RESTARTS=20\"",
    "set \"RESTART_DELAY=5\"",
    "set \"ATTEMPT=0\"",
    ":loop",
    "if not exist \"%EXE%\" (",
    "  echo Missing %EXE%.",
    "  exit /b 1",
    ")",
    "echo Starting %EXE% (attempt !ATTEMPT! of %MAX_RESTARTS%)",
    "\"%EXE%\" %ARGS%",
    "set \"EXIT_CODE=%ERRORLEVEL%\"",
    "if \"%EXIT_CODE%\" == \"0\" (",
    "  echo Bot exited cleanly.",
    "  exit /b 0",
    ")",
    "set /a ATTEMPT+=1",
    "if !ATTEMPT! GTR %MAX_RESTARTS% (",
    "  echo Max restarts reached (%MAX_RESTARTS%). Exiting.",
    "  exit /b %EXIT_CODE%",
    ")",
    "echo Restarting in %RESTART_DELAY%s...",
    "timeout /t %RESTART_DELAY% /nobreak >nul",
    "goto loop",
  ].join("\r\n");

  writeFile(path.join(distDir, "run-bot.bat"), `${headlessBat}\r\n`);
  writeFile(path.join(distDir, "run-bot-ui.bat"), `${uiBat}\r\n`);
  writeFile(path.join(distDir, "run-bot-watchdog.bat"), `${watchdogBat}\r\n`);
  writeFile(path.join(distDir, "run-bot-watchdog-ui.bat"), `${uiWatchdogBat}\r\n`);

  console.log("[build] Done.");
  console.log(`[build] Output: ${distDir}`);
}

run();
