module.exports = {
  apps: [
    {
      name: 'bells-api',
      script: './dist/server.js',
      cwd: '/var/www/bells-payment/api',
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '800M',
      node_args: '--max-old-space-size=768',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      error_file: '/var/log/bells-payment/api-error.log',
      out_file: '/var/log/bells-payment/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      combine_logs: true,
      merge_logs: true,
      time: true,
      max_restarts: 20,
      min_uptime: '10s',
      listen_timeout: 15000,
      kill_timeout: 5000,
      wait_ready: true,
      autorestart: true,
      restart_delay: 2500,
    },
  ],

  deploy: {
    production: {
      user: 'deploy',
      host: ['bells-prod-vps'],
      ref: 'origin/main',
      repo: 'git@github.com:gospat/university-wallet-payment-system-.git',
      path: '/var/www/bells-payment',
      'post-deploy':
        'chmod +x ./deploy.sh && bash ./deploy.sh',
    },
  },
};
