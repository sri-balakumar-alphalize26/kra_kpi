// Drag-to-reorder list for the Home side drawer.
//
// Long-press an item → it lifts (scales up + shadow) → drag it → the other rows
// slide out of the way → release to drop. The new order is reported via
// onOrder(destKeys) and persisted by the caller.
//
// Built on RN's own PanResponder + Animated ON PURPOSE: this project has no
// react-native-gesture-handler / reanimated / draggable-flatlist, and pulling in
// that stack (plus a babel plugin + rebuild) for one drawer list isn't worth it.
//
// How the gesture avoids fighting the ScrollView: `onMoveShouldSetPanResponder`
// only claims the responder AFTER the long-press timer has fired. Until then the
// touch belongs to the ScrollView, so normal scrolling still works, and a quick
// tap is handled as a plain press.
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { View, Text, Animated, PanResponder, StyleSheet } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../theme';

// Hold time before an item lifts. NOTE: 3s is what was asked for; the platform
// norm is ~500ms, so if it feels sluggish this single constant is the knob.
export const LONG_PRESS_MS = 3000;
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

export default function ReorderableMenu({ items, onPress, onOrder, editing }) {
  const [order, setOrder] = useState(items);
  useEffect(() => { setOrder(items); }, [items]);

  const [dragIdx, setDragIdx] = useState(null);   // index being dragged (for render)
  const [hoverIdx, setHoverIdx] = useState(null); // where it would drop

  // Refs mirror the state so the PanResponder callbacks (created once) always
  // read the latest values instead of a stale closure.
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
    Animated.spring(lift, { toValue: 1, useNativeDriver: true, friction: 6 }).start();
  }, [dragY, lift]);

  const endDrag = useCallback(() => {
    const from = dragRef.current;
    const to = hoverRef.current;
    Animated.timing(lift, { toValue: 0, duration: 140, useNativeDriver: true }).start();
    if (from != null && to != null && from !== to) {
      const next = [...orderRef.current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      setOrder(next);
      onOrder && onOrder(next.map((t) => t.dest));
    }
    dragRef.current = null; hoverRef.current = null;
    setDragIdx(null); setHoverIdx(null);
    dragY.setValue(0);
  }, [dragY, lift, onOrder]);

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

  const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };

  const pan = useRef(
    PanResponder.create({
      // Never claim on touch-start — that would kill ScrollView scrolling.
      onStartShouldSetPanResponder: () => false,
      // Claim ONLY once this row is the one being dragged (timer already fired).
      onMoveShouldSetPanResponder: () => dragRef.current === index,
      onPanResponderMove: (_e, g) => {
        if (dragRef.current !== index) return;
        dragY.setValue(g.dy);
        // Which slot are we over? Fixed pitch keeps this a simple division.
        let target = index + Math.round(g.dy / PITCH);
        if (target < 0) target = 0;
        if (target > count - 1) target = count - 1;
        if (target !== hoverRef.current) {
          hoverRef.current = target;
          setHoverIdx(target);
        }
      },
      onPanResponderRelease: () => { if (dragRef.current === index) onEndDrag(); },
      onPanResponderTerminate: () => { if (dragRef.current === index) onEndDrag(); },
      // Don't let the ScrollView steal the gesture mid-drag.
      onPanResponderTerminationRequest: () => dragRef.current !== index,
    })
  ).current;

  const onTouchStart = (e) => {
    movedRef.current = false;
    startRef.current = e.nativeEvent.pageY;
    clearTimer();
    timerRef.current = setTimeout(() => {
      if (!movedRef.current) onStartDrag(index);
    }, LONG_PRESS_MS);
  };
  const onTouchMove = (e) => {
    if (dragRef.current === index) return;           // already dragging
    if (Math.abs(e.nativeEvent.pageY - startRef.current) > CANCEL_SLOP) {
      movedRef.current = true;                       // it's a scroll → not a long press
      clearTimer();
    }
  };
  const onTouchEnd = () => {
    clearTimer();
    if (dragRef.current === index) return;           // the drag handles its own release
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
      onTouchCancel={clearTimer}
      {...pan.panHandlers}
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
