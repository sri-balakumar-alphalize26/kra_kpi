// Standard Expo Babel config (this is the SDK default — added explicitly so
// jest-expo's babel-jest transform can compile JSX/TS for tests). It reproduces
// Expo's built-in preset, so the app build behaves exactly as before.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
