const path = require('path');

/** Extension host bundle (Node.js) */
const extensionConfig = {
  target: 'node',
  mode: 'none',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
  },
  externals: { vscode: 'commonjs vscode' },
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
  devtool: 'nosources-source-map',
};

/** Notebook renderer bundle (browser webview) */
const rendererConfig = {
  target: 'web',
  mode: 'none',
  entry: './renderer/renderer.ts',
  output: {
    path: path.resolve(__dirname, 'out/renderer'),
    filename: 'renderer.js',
    libraryTarget: 'module',
  },
  experiments: { outputModule: true },
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: [{ loader: 'ts-loader', options: { configFile: 'tsconfig.renderer.json' } }],
        exclude: /node_modules/,
      },
    ],
  },
  devtool: 'nosources-source-map',
};

module.exports = [extensionConfig, rendererConfig];
