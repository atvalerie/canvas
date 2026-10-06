module.exports = {
  apps: [
    {
      name: "canvas",
      script: "server.js",
      env: { PORT: 18787, TRUST_PROXY: "1" },
    },
  ],
};
