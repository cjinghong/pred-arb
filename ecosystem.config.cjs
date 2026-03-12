/**
 * PM2 ecosystem config for PRED-ARB
 * Usage: pm2 start ecosystem.config.cjs
 */
module.exports = {
  apps: [
    {
      name: 'pred-arb',
      script: 'build/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
