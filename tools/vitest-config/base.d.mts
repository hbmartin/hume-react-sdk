declare const sharedVitestConfig: {
  test: {
    globals: true;
    environment: 'jsdom';
    watch: false;
    clearMocks: true;
    restoreMocks: true;
  };
};

export default sharedVitestConfig;
