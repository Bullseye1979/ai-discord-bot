module.exports = {
  apps: [
    {
      name: "discord-bot",
      script: "bot.js", // Dein Bot-Skript
      exec_mode: "fork", // Nutzt den Fork-Modus für Stabilität
      instances: 1,
      watch: true, // Überwacht Änderungen & startet neu
      interpreter: "/usr/bin/node",
      interpreter_args: "--trace-warnings",
      node_args: "--enable-source-maps",
      autorestart: true,
      env: {
        PUPPETEER_EXECUTABLE_PATH: "/usr/bin/chromium",
        FFMPEG_PATH: "/usr/bin/ffmpeg",
        NODE_ENV: "production"
      }
    }
  ]
};
