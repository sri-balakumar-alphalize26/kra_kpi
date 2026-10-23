// The picture played once after Start Workday — only while the admin's "Show
// attendance in the app" switch is on (App.js decides that; this only plays it).
// It sits in a centred popup card over a dimmed screen. The artwork is a page of
// CSS-animated PNG layers (assets/art/workdayStartArt.js), played in a WebView
// for the same reason as the login art: see components/AnimatedArt.js.
//
// It is decoration and must never stand in the way of work: a tap anywhere or
// Back skips it, it closes itself when the page's own exit has played, and on a
// build without the WebView it closes at once and draws nothing.
import React, { useEffect, useMemo } from 'react';
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { getWebView } from './AnimatedArt';
import { WORKDAY_START_HTML, WORKDAY_START_DURATION_MS } from '../assets/art/workdayStartArt';

// The page's own background at its edges, so nothing flashes white while the
// WebView loads the pictures.
const BG = '#EEF3FB';
// The artwork's own proportions (1312 × 1199), so the card frames it exactly.
const ART_RATIO = 1199 / 1312;

export default function WorkdayStartAnimation({ visible, onDone }) {
  const Web = getWebView();
  const source = useMemo(() => ({ html: WORKDAY_START_HTML }), []);
  const { width: winW, height: winH } = useWindowDimensions();
  // Most of a phone's width, capped on a tablet, and never taller than the screen allows.
  const cardW = Math.min(winW * 0.86, 440, (winH * 0.7) / ART_RATIO);
  const cardH = cardW * ART_RATIO;

  useEffect(() => {
    if (!visible) return undefined;
    if (!Web) { onDone && onDone(); return undefined; }
    const t = setTimeout(() => onDone && onDone(), WORKDAY_START_DURATION_MS);
    return () => clearTimeout(t);
  }, [visible, Web]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!visible || !Web) return null;
  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={() => onDone && onDone()}>
      <Pressable testID="workday-start-animation" style={s.backdrop} onPress={() => onDone && onDone()}>
        {/* pointerEvents none: the tap belongs to the Pressable, which skips. */}
        <View pointerEvents="none" style={[s.card, { width: cardW, height: cardH }]}>
          <Web
            source={source}
            originWhitelist={['*']}
            style={s.web}
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
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(15,23,42,0.55)' },
  card: {
    borderRadius: 24, overflow: 'hidden', backgroundColor: BG,
    elevation: 12, shadowColor: '#0B3D91', shadowOpacity: 0.3, shadowRadius: 18, shadowOffset: { width: 0, height: 8 },
  },
  web: { flex: 1, backgroundColor: BG },
});
