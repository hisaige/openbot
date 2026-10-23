// pm2 app definition for the OpenBot brain.
//
// Registered with `pm2 start scripts/ecosystem.config.cjs` (see scripts/restart-openbot.sh).
// The app runs scripts/openbot-launch.sh, which re-reads the model env written by tt-switch
// on every start - so a plain `pm2 restart openbot` picks up a model change.
module.exports = {
  apps: [
    {
      name: "openbot",
      script: "/root/ai/openbot/scripts/openbot-launch.sh",
      args: "--public-origin https://openbot.devcloud.woa.com",
      interpreter: "bash",
      cwd: "/root/ai/openbot/apps/server",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "4G",
      kill_timeout: 10000,
      merge_logs: true,
      out_file: "/root/.pm2/logs/openbot-out.log",
      error_file: "/root/.pm2/logs/openbot-error.log",
      env: {
        PM2_HOME: "/root/.pm2",
      },
    },
  ],
}
