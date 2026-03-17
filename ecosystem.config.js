module.exports = {
  apps: [
    {
      name:        'printfarm',
      script:      'server.js',
      cwd:         __dirname,
      env_file:    '.env',
      watch:       false,
      restart_delay: 3000,
      max_restarts:  10,
    },
  ],
};
