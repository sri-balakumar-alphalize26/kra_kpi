// Drag-to-reorder list for the Home side drawer.
//
// Long-press an item → it lifts (scales up + shadow) → drag it → the other rows
// slide out of the way → release to drop. The new order is reported via
// onOrder(destKeys) and persisted by the caller.
//
// Built on RN's raw touch events + Animated ON PURPOSE: this project has no
// react-native-gesture-handler / reanimated / draggable-flatlist, and pulling in
// that stack (plus a babel plugin + rebuild) for one drawer list isn't worth it.
//
// Why touch events and not PanResponder: these rows sit inside the drawer's
// ScrollView, which claims the responder the moment the finger moves. RN then
// stops asking anyone else, so onMoveShouldSetPanResponder was never consulted
// and the lifted row never received the gesture — it just froze. Touch events
// are delivered to the view under the finger regardless of the responder, so
// they work. The caller also freezes the ScrollView during a drag
// (onDragStateChange → scrollEnabled) so the list doesn't slide underneath.
//
// Both Animated values here are JS-driven and must stay that way: `lift` (scale)
// and `dragY` (translateY) share one transform, and RN forbids mixing drivers on
// a single view — the native side takes over and JS setValue() calls are dropped.
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../theme';
import { createLogger } from '../api/logger';

const log = createLogger('ReorderMenu');

// Hold time before an item lifts, in EDIT mode only.
//
// Was 3000ms and effectively unusable: holding within CANCEL_SLOP for three full
// seconds is beyond a normal finger, so drift cancelled the timer and the drag
// "didn't work". 400ms is the platform norm (~500ms on iOS/Android) — long
// enough to tell a deliberate hold from a scroll, short enough that drift can't
// eat it. Entering edit mode is already the explicit intent; a long hold on top
// of it was just friction.
export const LONG_PRESS_MS = 400;
// Row height + marginBottom (see `item`/`wrap` styles) — the drag maths assumes a
// fixed pitch, which is what keeps this simple and predictable.
const ROW_H = 64;
const GAP = 10;
const PITCH = ROW_H + GAP;
// Movement over this many px before the timer fires = a scroll, not a long press.
const CANCEL_SLOP = 8;

function Icon({ lib, name, size, color }) {
  return lib === 'mc'
    ? <MaterialCommunityIcons name={name} size={size} color={color} />
    : <Ionicons name={name} size={size} color={color} />;
}

export default function ReorderableMenu({
  items, onPress, onOrder, editing,
  // Fired true/false around a drag. The caller MUST stop its ScrollView while
  // true: the ScrollView is our ancestor and will otherwise claim the touch
  // once the finger moves, so the lifted row never receives the gesture.
  onDragStateChange,
}) {
  const [order, setOrder] = useState(items);
  useEffect(() => { setOrder(items); }, [items]);

  const [dragIdx, setDragIdx] = useState(null);   // index being dragged (for render)
  const [hoverIdx, setHoverIdx] = useState(null); // where it would drop

  // Refs mirror the state so the touch handlers always read the latest values
  // instead of a stale closure.
  const dragRef = useRef(null);
  const hoverRef = useRef(null);
  const orderRef = useRef(items);
  useEffect(() => { orderRef.current = order; }, [order]);

  const dragY = useRef(new Animated.Value(0)).current;
  const lift = useRef(new Animated.Value(0)).current;

  const startDrag = useCallback((i) => {
    dragRef.current = i; hoverRef.current = i;
    setDragIdx(i); setHoverIdx(i);
    dragY.setValue(0);
    log.info('drag start', { index: i });
    onDragStateChange && onDragStateChange(true);   // parent stops the ScrollView
    // useNativeDriver MUST stay false: `lift` (scale) and `dragY` (translateY)
    // share one transform, and RN won't let a view mix drivers — the native side
    // takes ownership and every dragY.setValue() from JS is then silently
    // dropped. That's what made a lifted row freeze: the scale animated, the
    // movement didn't.
    Animated.spring(lift, { toValue: 1, useNativeDriver: false, friction: 6 }).start();
  }, [dragY, lift, onDragStateChange]);

  const endDrag = useCallback(() => {
    const from = dragRef.current;
    const to = hoverRef.current;
    // Same driver rule as startDrag — see the comment there.
    Animated.timing(lift, { toValue: 0, duration: 140, useNativeDriver: false }).start();
    if (from != null && to != null && from !== to) {
      const next = [...orderRef.current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      setOrder(next);
      log.info('drag drop → reordered', { from, to, order: next.map((t) => t.dest) });
      onOrder && onOrder(next.map((t) => t.dest));   // caller persists it
    } else {
      log.info('drag drop → unchanged', { from, to });
    }
    dragRef.current = null; hoverRef.current = null;
    setDragIdx(null); setHoverIdx(null);
    dragY.setValue(0);
    onDragStateChange && onDragStateChange(false);   // parent re-enables scrolling
  }, [dragY, lift, onOrder, onDragStateChange]);

  // How far a NON-dragged row slides to open a slot for the dragged one.
  const shiftFor = (i) => {
    if (dragIdx == null || hoverIdx == null || i === dragIdx) return 0;
    if (dragIdx < hoverIdx && i > dragIdx && i <= hoverIdx) return -PITCH;
    if (dragIdx > hoverIdx && i < dragIdx && i >= hoverIdx) return PITCH;
    return 0;
  };

  return (
    <View>
      {order.map((q, i) => (
        <Row
          key={q.dest || q.label}
          q={q}
          index={i}
          count={order.length}
          dragging={dragIdx === i}
          shift={shiftFor(i)}
          dragY={dragY}
          lift={lift}
          dragRef={dragRef}
          hoverRef={hoverRef}
          setHoverIdx={setHoverIdx}
          onStartDrag={startDrag}
          onEndDrag={endDrag}
          onPress={onPress}
          editing={editing}
        />
      ))}
    </View>
  );
}

function Row({
  q, index, count, dragging, shift, dragY, lift,
  dragRef, hoverRef, setHoverIdx, onStartDrag, onEndDrag, onPress, editing,
}) {
  const timerRef = useRef(null);
  const movedRef = useRef(false);
  const startRef = useRef(0);
  // Set the instant a drag ends, read by the onTouchEnd that fires immediately
  // after — see the comment there. Without it, dropping a row opened it.
  const justDraggedRef = useRef(false);

  const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };

  const endDragSafely = () => {
    if (dragRef.current !== index) return;
    justDraggedRef.current = true;   // must be set BEFORE onEndDrag clears dragRef
    onEndDrag();
  };

  // The drag runs on TOUCH events, not a PanResponder, and that's deliberate.
  //
  // PanResponder never worked here: these rows live inside the drawer's
  // ScrollView, which claims the responder as soon as the finger moves. Once a
  // view owns the responder RN stops asking anyone else, so
  // `onMoveShouldSetPanResponder` was never consulted and onPanResponderMove
  // never fired — the row lifted and then sat frozen. (Logs showed
  // "drag start" with no "drag over slot" following it, ever.)
  //
  // onTouchStart/Move/End are dispatched to the view under the finger regardless
  // of who holds the responder — which is why the long-press detection here
  // always worked. So the drag uses the same channel. dy is computed from pageY
  // instead of PanResponder's gestureState.
  const onTouchStart = (e) => {
    movedRef.current = false;
    startRef.current = e.nativeEvent.pageY;
    clearTimer();
    // Only arm the hold in EDIT mode. Outside it there is nothing to drag, and
    // arming it there meant a slow tap anywhere could lift a row.
    if (!editing) return;
    timerRef.current = setTimeout(() => {
      if (movedRef.current) { log.info('hold cancelled — finger moved', { index }); return; }
      log.info('hold fired → lifting', { index, ms: LONG_PRESS_MS });
      onStartDrag(index);
    }, LONG_PRESS_MS);
  };

  const onTouchMove = (e) => {
    const dy = e.nativeEvent.pageY - startRef.current;
    // Dragging → move with the finger and work out which slot we're over.
    if (dragRef.current === index) {
      dragY.setValue(dy);
      let target = index + Math.round(dy / PITCH);   // fixed pitch → simple division
      if (target < 0) target = 0;
      if (target > count - 1) target = count - 1;
      if (target !== hoverRef.current) {
        log.info('drag over slot', { from: index, over: target, dy: Math.round(dy) });
        hoverRef.current = target;
        setHoverIdx(target);
      }
      return;
    }
    // Not dragging yet: enough movement means this is a scroll, not a hold.
    if (Math.abs(dy) > CANCEL_SLOP) {
      movedRef.current = true;
      clearTimer();
    }
  };

  const onTouchEnd = () => {
    clearTimer();
    // Finish the drag we own.
    if (dragRef.current === index) { endDragSafely(); return; }
    // Never navigate in edit mode: the whole point is rearranging, and a tap that
    // jumped to a screen made reordering feel broken.
    if (editing) return;
    // Belt-and-braces: swallow the tap that can arrive right after a drop.
    if (justDraggedRef.current) { justDraggedRef.current = false; return; }
    if (!movedRef.current) onPress && onPress(q);    // a plain tap → navigate
  };

  const scale = lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] });
  const style = dragging
    ? { transform: [{ translateY: dragY }, { scale }], zIndex: 99, elevation: 12 }
    : { transform: [{ translateY: shift }] };

  return (
    <Animated.View
      style={[s.wrap, style]}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <View style={[s.item, dragging && s.itemDragging]}>
        <View style={[s.icon, { backgroundColor: q.bg }]}>
          <Icon lib={q.lib} name={q.name} size={20} color={q.fg} />
        </View>
        <Text style={s.txt} numberOfLines={1}>{q.label}</Text>
        {editing || dragging
          ? <MaterialCommunityIcons name="drag-horizontal-variant" size={20} color={COLORS.faint} />
          : <Ionicons name="chevron-forward" size={18} color={COLORS.muted} />}
      </View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrap: { marginBottom: GAP },
  item: {
    height: ROW_H, flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 12, borderRadius: 14,
    backgroundColor: '#F5F8FD', borderWidth: 1, borderColor: '#EAF1FE',
  },
  itemDragging: {
    backgroundColor: '#fff', borderColor: COLORS.primary,
    shadowColor: '#0B2A6B', shadowOpacity: 0.22, shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
  },
  icon: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  txt: { flex: 1, fontSize: 14.5, fontWeight: '800', color: COLORS.navy },
});
