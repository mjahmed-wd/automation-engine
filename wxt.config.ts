import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Debug & Automation',
    description:
      'A sidebar extension that automates pages using the Chrome Debugger API (CDP)',
    permissions: ['sidePanel', 'tabs', 'debugger'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Open Debug & Automation sidebar',
    },
  },
});
