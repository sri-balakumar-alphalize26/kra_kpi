// An animated Storyset illustration, played in a WebView.
//
// WHY A WEBVIEW. The pictures on the app-login screen are SVGs animated purely
// with CSS keyframes — a key swinging on its ring, a phone floating, password
// stars typed one by one. react-native-svg draws the artwork but cannot run CSS
// animation, so through it the picture simply stands still. A WebView is a real
// browser engine and plays the file exactly as it was exported, with nothing to
// re-animate by hand in JS and drift out of step with the art.
//
// Loaded DEFENSIVELY, like the other native modules (services/alarm.js,
// modules/expo-task-widget-bridge): react-native-webview only exists in a build
// made after it was added, and a bare import would throw at module evaluation on
// an older APK or in Expo Go and take the whole login screen down with it. When
// it is missing this renders nothing and the form is exactly as before.
//
// JavaScript is OFF in the page: keyframes need none, and the markup is our own
// bundled string, so there is nothing for a script to do but widen the surface.
import React, { useMemo } from 'react';
import { View } from 'react-native';

let WebView = null;
let resolved = false;

function getWebView() {
  if (resolved) return WebView;
  resolved = true;
  try {
    // eslint-disable-next-line global-require
    WebView = require('react-native-webview').WebView || null;
  } catch (_) {
    WebView = null;
  }
  return WebView;
}

/** True when this build can play the pictures — i.e. the WebView is present. */
export function animatedArtAvailable() {
  return !!getWebView();
}

// The page is sized by the WebView, and the <svg> fills it: its own viewBox
// keeps the aspect ratio, so a square WebView shows the square picture edge to
// edge with no scrolling and no zoom controls.
function pageFor(svg, background) {
  return (
    '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">'
    + `<style>html,body{margin:0;padding:0;overflow:hidden;background:${background}}`
    + 'svg{width:100%;height:100%;display:block}</style></head>'
    + `<body>${svg}</body></html>`
  );
}

/**
 * @param {string} svg         the SVG markup (see assets/art/*.js)
 * @param {number} size        width and height in dp — the pictures are square
 * @param {string} background  behind the picture; matches the sheet it sits on,
 *                             so no transparent-WebView tricks are needed
 */
export default function AnimatedArt({ svg, size = 150, background = '#FFFFFF', style }) {
  const Web = getWebView();
  const source = useMemo(() => ({ html: pageFor(svg, background) }), [svg, background]);
  if (!Web || !svg) return null;
  return (
    // pointerEvents none: the picture is decoration. A WebView that could take
    // the touch would steal taps and scrolls from the form around it.
    <View
      testID="animated-art"
      pointerEvents="none"
      style={[{ width: size, height: size, alignSelf: 'center', marginBottom: 6, backgroundColor: background }, style]}
    >
      <Web
        source={source}
        originWhitelist={['*']}
        style={{ width: size, height: size, backgroundColor: background }}
        scrollEnabled={false}
        javaScriptEnabled={false}
        overScrollMode="never"
        androidLayerType="hardware"
        setBuiltInZoomControls={false}
        setDisplayZoomControls={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        focusable={false}
      />
    </View>
  );
}
