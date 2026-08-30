import { defineConfig } from 'vitepress';

import { readApiReferenceSidebar } from '../../tools/api-sidebar.mjs';

const repositoryName =
  process.env.GITHUB_REPOSITORY?.split('/').at(-1) ?? 'hume-react-sdk';
const base = process.env.DOCS_BASE ?? `/${repositoryName}/`;

export default defineConfig({
  base,
  cleanUrls: true,
  description:
    'Guides and API reference for the Hume Voice SDK packages for JavaScript and React.',
  head: [
    ['meta', { content: '#5f34e9', name: 'theme-color' }],
    ['meta', { content: 'Hume Voice SDK documentation', property: 'og:title' }],
  ],
  lastUpdated: true,
  markdown: {
    config(markdown) {
      const renderCodeInline = markdown.renderer.rules.code_inline;
      if (renderCodeInline === undefined) {
        throw new Error('Markdown-It did not provide an inline-code renderer.');
      }

      markdown.renderer.rules.code_inline = (...arguments_) => {
        const [tokens, index] = arguments_;
        tokens[index].attrSet('v-pre', '');

        return renderCodeInline(...arguments_);
      };
    },
    lineNumbers: true,
  },
  outDir: '.vitepress/dist',
  themeConfig: {
    externalLinkIcon: true,
    footer: {
      copyright: 'Copyright © Hume AI',
      message: 'Documentation for the latest main-branch SDK source.',
    },
    nav: [
      { link: '/guide/getting-started', text: 'Guides' },
      { link: '/examples/', text: 'Examples' },
      { link: '/reference/', text: 'API Reference' },
    ],
    outline: {
      label: 'On this page',
      level: [2, 3],
    },
    search: {
      provider: 'local',
    },
    sidebar: {
      '/guide/': [
        {
          items: [
            { link: '/guide/getting-started', text: 'Choose a package' },
            { link: '/guide/authentication', text: 'Authentication' },
          ],
          text: 'Getting started',
        },
        {
          items: [
            { link: '/guide/voice-react', text: '@humeai/voice-react' },
            { link: '/guide/tool-calls', text: 'Tool calls' },
            { link: '/guide/error-handling', text: 'Errors and reconnection' },
            {
              link: '/guide/session-settings',
              text: 'Session settings and resuming',
            },
            { link: '/guide/interruptions', text: 'Interruptions' },
            {
              link: '/guide/expression-measurement',
              text: 'Expression measurement',
            },
            { link: '/guide/audio-devices', text: 'Audio devices' },
            { link: '/guide/visualizations', text: 'Audio visualizations' },
            { link: '/guide/diagnostics', text: 'Diagnostics and logging' },
            { link: '/guide/nextjs', text: 'Next.js and server rendering' },
          ],
          text: 'Build a custom UI',
        },
        {
          items: [
            { link: '/guide/embedded-widget', text: 'Embedding the widget' },
            {
              link: '/guide/voice-embed-react',
              text: '@humeai/voice-embed-react',
            },
            { link: '/guide/voice-embed', text: '@humeai/voice-embed' },
          ],
          text: 'Use the hosted widget',
        },
        {
          collapsed: true,
          items: [
            { link: '/guide/migration', text: 'Migrating versions' },
            { link: '/guide/documentation-model', text: 'How these docs work' },
          ],
          text: 'Reference material',
        },
      ],
      '/examples/': [
        {
          items: [
            { link: '/examples/', text: 'Overview' },
            { link: '/examples/next-app', text: 'Next.js reference app' },
            { link: '/examples/vite-embed', text: 'Embedded widget' },
            { link: '/examples/raw-client', text: 'Raw EVI client' },
          ],
          text: 'Examples',
        },
      ],
      '/reference/': [
        {
          items: [
            { link: '/reference/', text: 'Overview' },
            { link: '/reference/api/', text: 'All packages' },
            {
              link: '/reference/api/voice-react',
              text: '@humeai/voice-react',
            },
            {
              link: '/reference/api/voice-embed-react',
              text: '@humeai/voice-embed-react',
            },
            {
              link: '/reference/api/voice-embed',
              text: '@humeai/voice-embed',
            },
          ],
          text: 'API Reference',
        },
      ],
      // Keyed more specifically than '/reference/', so the generated pages get
      // the generated sidebar while the overview keeps the short one above.
      '/reference/api/': readApiReferenceSidebar(),
    },
    siteTitle: 'Hume Voice SDK',
    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/HumeAI/hume-react-sdk',
      },
    ],
  },
  title: 'Hume Voice SDK',
  titleTemplate: ':title · Hume Voice SDK',
});
