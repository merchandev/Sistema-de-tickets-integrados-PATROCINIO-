module.exports = {
  apps: [
    {
      name: 'sistema-central',
      cwd: './sistema-central',
      script: 'src/server.js',
      node_args: '--no-warnings',
      env: {
        NODE_ENV: 'production',
        PORT: 4000
      }
    },
    {
      name: 'pagina-web-1',
      cwd: './pagina-web-1',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        CENTRAL_API_URL: 'http://localhost:4000'
      }
    },
    {
      name: 'pagina-web-2',
      cwd: './pagina-web-2',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3002,
        CENTRAL_API_URL: 'http://localhost:4000'
      }
    }
  ]
};
