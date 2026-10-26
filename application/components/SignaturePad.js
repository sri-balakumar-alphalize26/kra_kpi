// Signature box for the client's final sign-off — the app's version of the
// sign-off page's canvas (views/wa_approval_templates.xml, wa_signoff_page):
//   'auto' — the chosen Full Name written as a signature
//   'draw' — signed with a finger
// Drawn with react-native-svg (already in the app, works in Expo Go), and turned
// into a PNG with its native toDataURL — no new native dependency.
//
// The parent reads the picture through the ref: `await ref.current.toPng()` →
// base64 PNG (no data: prefix), or '' when there is nothing to save.
import React, { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Text, PanResponder, StyleSheet, Platform } from 'react-native';
import Svg, { Path, Text as SvgText } from 'react-native-svg';
import { COLORS } from '../theme';
import { strokesToPath, autoFontSize } from '../utils/clientSignoff';

const HEIGHT = 120;
const INK = '#1F2937';
// A handwriting face that ships with the OS: Android maps 'cursive' to its
// built-in script font; iOS has Snell Roundhand.
const SCRIPT = Platform.select({ ios: 'Snell Roundhand', default: 'cursive' });

const SignaturePad = forwardRef(function SignaturePad({ mode, name, onInk, onDrawing }, ref) {
  const svgRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [strokes, setStrokes] = useState([]);
  const live = useRef(null);            // the stroke under the finger right now
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const pan = useMemo(() => PanResponder.create({
    // Only claim the touch while drawing, and never let the sheet's ScrollView take
    // it back mid-stroke — a signature that scrolls the page is unusable.
    onStartShouldSetPanResponder: () => modeRef.current === 'draw',
    onMoveShouldSetPanResponder: () => modeRef.current === 'draw',
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      const { locationX: x, locationY: y } = e.nativeEvent;
      live.current = [{ x, y }];
      setStrokes((cur) => [...cur, live.current]);
      onDrawing?.(true);
      onInk?.(true);
    },
    onPanResponderMove: (e) => {
      if (!live.current) return;
      const { locationX: x, locationY: y } = e.nativeEvent;
      live.current.push({ x, y });
      // New array so React re-renders; the stroke objects themselves are shared.
      setStrokes((cur) => [...cur]);
    },
    onPanResponderRelease: () => { live.current = null; onDrawing?.(false); },
    onPanResponderTerminate: () => { live.current = null; onDrawing?.(false); },
  }), [onInk, onDrawing]);

  useImperativeHandle(ref, () => ({
    clear: () => { setStrokes([]); onInk?.(false); },
    toPng: () => new Promise((resolve, reject) => {
      const svg = svgRef.current;
      const empty = mode === 'draw' ? !strokes.length : !(name || '').trim();
      if (empty) { resolve(''); return; }
      if (!svg || typeof svg.toDataURL !== 'function') {
        reject(new Error('Signature capture is not available on this device.'));
        return;
      }
      // toDataURL never reports a failure — it just never calls back. Don't let
      // Sign & Approve spin forever on that.
      const t = setTimeout(() => reject(new Error('Could not read the signature.')), 5000);
      svg.toDataURL((b64) => { clearTimeout(t); resolve(b64 || ''); });
    }),
  }), [mode, name, strokes, onInk]);

  const fontSize = autoFontSize(name, width, HEIGHT);
  return (
    <View
      style={s.box}
      onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}
      {...pan.panHandlers}
    >
      {width > 0 ? (
        // pointerEvents none: the touch always lands on the box, so locationX/Y are
        // box coordinates rather than relative to whichever path was under the finger.
        <Svg ref={svgRef} width={width} height={HEIGHT} pointerEvents="none">
          {mode === 'draw' ? (
            <Path
              d={strokesToPath(strokes) || 'M0 0'} stroke={INK} strokeWidth={3}
              strokeLinecap="round" strokeLinejoin="round" fill="none"
            />
          ) : (name || '').trim() ? (
            <SvgText
              x={width / 2} y={HEIGHT / 2 + fontSize * 0.3} textAnchor="middle"
              fontFamily={SCRIPT} fontSize={fontSize} fill={INK}
            >
              {name.trim()}
            </SvgText>
          ) : null}
        </Svg>
      ) : null}
      {mode === 'draw' && !strokes.length ? (
        <Text pointerEvents="none" style={s.hint}>Sign here with your finger</Text>
      ) : null}
      {mode === 'auto' && !(name || '').trim() ? (
        <Text pointerEvents="none" style={s.hint}>Choose your name first</Text>
      ) : null}
    </View>
  );
});

export default SignaturePad;

const s = StyleSheet.create({
  box: {
    height: HEIGHT, borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 12,
    backgroundColor: '#fff', overflow: 'hidden', justifyContent: 'center',
  },
  hint: {
    position: 'absolute', left: 0, right: 0, textAlign: 'center',
    fontSize: 12.5, color: COLORS.faint, fontWeight: '600',
  },
});
