import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'MonkeyTest Core',
  description:
    'Open-source AI exploratory testing engine — Playwright, LLM planning, live events. AGPL-3.0.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ['link', { rel: 'icon', href: '/logo.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#7c3aed' }],
    [
      'meta',
      {
        name: 'keywords',
        content:
          'MonkeyTest, Playwright, LLM, QA, exploratory testing, AGPL, browser automation, open source',
      },
    ],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/introduction', activeMatch: '/guide/' },
      { text: 'Reference', link: '/reference/overview', activeMatch: '/reference/' },
      { text: 'License & SaaS', link: '/guide/license-and-saas' },
      {
        text: 'MonkeyTest Cloud',
        link: 'https://monkeytest.ai',
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Start here',
          items: [
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Quick start', link: '/guide/quick-start' },
          ],
        },
        {
          text: 'Using the engine',
          items: [
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'Live events', link: '/guide/live-events' },
            { text: 'License, AGPL & SaaS', link: '/guide/license-and-saas' },
            { text: 'Publishing docs (docs.monkeytest.ai)', link: '/guide/publishing-docs' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'API',
          items: [
            { text: 'Overview', link: '/reference/overview' },
            { text: 'Monkey class', link: '/reference/monkey' },
            { text: 'EventBus & live events', link: '/reference/events' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/monkeytest-ai/monkeytest-core' },
    ],

    footer: {
      message: 'Released under the GNU Affero General Public License v3.0',
      copyright: 'Copyright © MonkeyTest contributors',
    },

    search: {
      provider: 'local',
    },

    editLink: {
      pattern:
        'https://github.com/monkeytest-ai/monkeytest-core/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
});
