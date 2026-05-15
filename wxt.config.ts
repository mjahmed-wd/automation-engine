import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Automation Engine',
    description:
      'JSON-driven web automation runner — drives the active tab via Chrome DevTools Protocol',
    permissions: ['sidePanel', 'tabs', 'debugger', 'storage'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Open Automation Engine sidebar',
    },
  },
});
