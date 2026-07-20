// Global test setup — mock the native-only bits so component tests can render
// real screens in Node without a device. These are visual/native modules whose
// behaviour is irrelevant to the LOGIC we're asserting (labels, states, flows).

// Safe-area: return zero insets and pass children straight through.
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }) => children,
  SafeAreaView: ({ children }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
}));

// Vector icons render as their name in a <Text> so queries can still find text.
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  const Icon = ({ name }) => React.createElement(Text, null, name || 'icon');
  return {
    Ionicons: Icon, MaterialCommunityIcons: Icon, MaterialIcons: Icon,
    FontAwesome: Icon, Feather: Icon, AntDesign: Icon, Entypo: Icon,
  };
});

// SVG primitives → inert views, so components that draw art don't need native SVG.
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Passthrough = ({ children }) => React.createElement(View, null, children);
  const Empty = () => null;
  return {
    __esModule: true, default: Passthrough, Svg: Passthrough, G: Passthrough,
    Path: Empty, Defs: Empty, LinearGradient: Empty, Stop: Empty, Rect: Empty,
    Circle: Empty, ClipPath: Empty, Use: Empty, Text: Empty, Polygon: Empty,
  };
});
