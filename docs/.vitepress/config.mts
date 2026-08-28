import { defineConfig } from 'vitepress';

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

      markdown.renderer.rules.code_inline = (...arguments_) => {
        const [tokens, index] = arguments_;
        tokens[index].attrSet('v-pre', '');

        return renderCodeInline?.(...arguments_) ?? '';
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
      { link: '/packages/voice-react', text: 'Packages' },
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
            { link: '/guide/getting-started', text: 'Getting started' },
            { link: '/guide/documentation-model', text: 'Documentation model' },
          ],
          text: 'Guides',
        },
      ],
      '/packages/': [
        {
          items: [
            { link: '/packages/voice-react', text: 'voice-react' },
            { link: '/packages/voice-embed-react', text: 'voice-embed-react' },
            { link: '/packages/voice-embed', text: 'voice-embed' },
          ],
          text: 'Packages',
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
