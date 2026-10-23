import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'MonkeyTest Core',
  description:
    'The open-source AI agent that explores your website like a real user and reports bugs. Playwright + LLM. Works with OpenAI, Gemini, Anthropic, Mistral, Groq, or any OpenAI-compatible endpoint.',
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
          'monkeytest, AI testing, exploratory testing, Playwright, LLM, browser automation, QA, bug detection, OpenAI, Gemini, Anthropic, Mistral, Groq, open source',
      },
    ],
    ['meta', { property: 'og:title', content: 'MonkeyTest Core — AI exploratory testing for any web app' }],
    ['meta', { property: 'og:description', content: 'An open-source AI agent that uses your site like a real user and reports bugs. Playwright + your favourite LLM.' }],
    ['meta', { property: 'og:image', content: 'https://docs.monkeytest.ai/hero.jpg' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: 'https://docs.monkeytest.ai/hero.jpg' }],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/quick-start', activeMatch: '/guide/(?!why-monkeytest)' },
      { text: 'Why monkeytest', link: '/guide/why-monkeytest', activeMatch: '/guide/why-monkeytest' },
      { text: 'LLMs', link: '/guide/llm-providers', activeMatch: '/guide/llm-' },
      { text: 'Reference', link: '/reference/overview', activeMatch: '/reference/' },
      { text: 'GitHub', link: 'https://github.com/monkeytestai/monkeytest-core' },
      { text: 'MonkeyTest Cloud', link: 'https://monkeytest.ai' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Start here',
          items: [
            { text: 'Quick start', link: '/guide/quick-start' },
            { text: 'Why monkeytest', link: '/guide/why-monkeytest' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Introduction', link: '/guide/introduction' },
            { text: 'The bug-finding loop', link: '/guide/the-bug-finding-loop' },
            { text: 'Replay and verify', link: '/guide/replay-and-verify' },
            { text: 'How it works', link: '/guide/architecture' },
          ],
        },
        {
          text: 'Configure the engine',
          items: [
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'LLM providers', link: '/guide/llm-providers' },
            { text: 'Prompt caching', link: '/guide/prompt-caching' },
            { text: 'Triager polish', link: '/guide/triager' },
            { text: 'Cost & depth', link: '/guide/cost-and-depth' },
            { text: 'Live events', link: '/guide/live-events' },
          ],
        },
        {
          text: 'Recipes',
          items: [
            { text: 'Common recipes', link: '/guide/recipes' },
            { text: 'Use in CI', link: '/guide/ci' },
            { text: 'Troubleshooting', link: '/guide/troubleshooting' },
          ],
        },
        {
          text: 'Project',
          items: [
            { text: 'License', link: '/guide/license' },
            { text: 'Publishing docs', link: '/guide/publishing-docs' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Overview', link: '/reference/overview' },
            { text: 'Monkey class', link: '/reference/monkey' },
            { text: 'EventBus & live events', link: '/reference/events' },
            { text: 'CLI', link: '/reference/cli' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/monkeytestai/monkeytest-core' },
    ],

    footer: {
      message: 'AGPL-3.0 · Made for the testing community',
      copyright: 'Copyright © MonkeyTest contributors',
    },

    search: {
      provider: 'local',
    },

    editLink: {
      pattern:
        'https://github.com/monkeytestai/monkeytest-core/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
});
