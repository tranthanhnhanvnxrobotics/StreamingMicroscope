module.exports = {
  apps: [
    {
      name: 'backend',
      cwd: './backend',
      script: 'src/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'frontend',
      cwd: './frontend',
      // Avoid `next: Permission denied` when .bin/next lost +x (e.g. copy from Windows / bad archive).
      script: 'node_modules/next/dist/bin/next',
      args: 'start',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '768M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
