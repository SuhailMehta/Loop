module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // Tier aliases. These mirror tsconfig `paths` and exist to make the
    // architecture legible in every import line: you can see at a glance
    // whether a file is reaching into the framework or into a use-case kit.
    [
      'module-resolver',
      {
        root: ['./src'],
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
        alias: {
          '@design': './src/design',
          '@geo': './src/geo',
          '@kits': './src/kits',
        },
      },
    ],
  ],
};
