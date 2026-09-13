const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname),
  webpack: (config) => {
    config.module.rules.push({
      test: /three\.module\.min\.js$/,
      type: "javascript/auto",
    });
    return config;
  },
};

module.exports = nextConfig;
