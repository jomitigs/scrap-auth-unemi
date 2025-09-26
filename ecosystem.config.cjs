module.exports = {
  apps: [
    {
      name: 'scrap-auth-unemi',
      script: './dist/index.js',
      watch: false,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
