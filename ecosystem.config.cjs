module.exports = {
  apps: [
    {
      name: "sewers-bot",
      script: "src/index.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
