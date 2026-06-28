module.exports = {
  apps: [
    {
      name: 'sc-backend',
      script: 'server.js',
      // Cap the V8 heap below total RAM so Node garbage-collects instead of
      // letting the OS OOM-kill the process. Chromium runs in its own
      // processes (off-heap), so keep this conservative on the 4GB droplet.
      node_args: '--max-old-space-size=1024',
      // Safety net: restart only if the Node process itself leaks well past
      // its heap cap. Normal operation stays far below this.
      max_memory_restart: '1500M',
      env: {
        // Max concurrent Puppeteer pages on the shared browser (4GB/2vCPU).
        BROWSER_MAX_CONCURRENCY: '3',
      },
    },
  ],
};
