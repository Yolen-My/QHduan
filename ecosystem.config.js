module.exports = {
  apps: [
    {
      name: "qhduan-frontend",
      script: "npm",
      args: "start",
      env: { NODE_ENV: "production" }
    },
    {
      name: "realtime-gateway",
      script: "gateway/server.ts",
      interpreter: "node",
      env: {
        GATEWAY_PORT: "8100",
        POCKETBASE_SERVER_URL: "http://127.0.0.1:8090",
        REDIS_URL: "redis://127.0.0.1:6379"
      }
    }
  ]
};
