// In-app camera capture with a preview + confirm step (Use Photo / Retake / Cancel).
// Uses expo-camera's CameraView so the whole flow stays INSIDE the app — unlike
// ImagePicker.launchCameraAsync, which spawns an external camera activity that
// Android can kill on low memory (reloading the app right after capture).
// Mirrors the alphalize_tools_management CameraCapture, updated to the SDK 54 API.
import React, { useRef, useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Image, ActivityIndicator, StatusBar } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../theme';
import { createLogger } from '../api/logger';

const log = createLogger('Camera');

export default function CameraCaptureModal({ visible, onCapture, onClose }) {
  const cameraRef = useRef(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState('back');
  const [preview, setPreview] = useState(null); // captured photo uri (preview/confirm step)
  const [busy, setBusy] = useState(false);

  // Reset the preview whenever the modal is dismissed.
  useEffect(() => { if (!visible) { setPreview(null); setBusy(false); } }, [visible]);

  if (!visible) return null;

  const takePicture = async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.5, exif: false });
      log.info('captured, resizing…', { uri: !!photo?.uri });
      let uri = photo?.uri || null;
      // Downscale to ~720px immediately: previewing/handling a full-res sensor
      // image (12+ MP) spikes memory and crashes/reloads the app on some captures.
      if (uri) {
        try {
          const small = await ImageManipulator.manipulateAsync(
            uri, [{ resize: { width: 720 } }], { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG },
          );
          if (small?.uri) uri = small.uri;
          log.info('resized', { ok: !!small?.uri });
        } catch (e) { log.warn('resize failed, using original', e?.message); }
      }
      setPreview(uri);
    } catch (e) {
      log.warn('take picture failed', e?.message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => { if (preview) { const u = preview; setPreview(null); log.info('use photo'); onCapture(u); } };
  const retake = () => { log.info('retake'); setPreview(null); };
  const close = () => { log.info('camera closed'); setPreview(null); onClose(); };

  // Permission still resolving.
  if (!permission) {
    return (
      <Modal visible transparent statusBarTranslucent>
        <View style={s.center}><ActivityIndicator color="#fff" /></View>
      </Modal>
    );
  }

  // Permission not granted → in-app grant screen (this is the "rationale" too).
  if (!permission.granted) {
    return (
      <Modal visible animationType="fade" statusBarTranslucent onRequestClose={close}>
        <View style={s.permWrap}>
          <Ionicons name="camera-outline" size={54} color="#fff" />
          <Text style={s.permTxt}>Camera access is needed to take your profile photo.</Text>
          <TouchableOpacity style={s.permBtn} onPress={requestPermission} activeOpacity={0.9}>
            <Text style={s.permBtnTxt}>Grant Permission</Text>
          </TouchableOpacity>
          <TouchableOpacity style={{ padding: 12 }} onPress={close}>
            <Text style={s.permCancel}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible animationType="slide" statusBarTranslucent onRequestClose={close}>
      <View style={s.root}>
        <StatusBar hidden />
        {preview ? (
          // Preview / confirm — stable, in-app; nothing is saved until "Use Photo".
          <View style={s.previewWrap}>
            <Image source={{ uri: preview }} style={s.previewImg} />
            <View style={s.previewRow}>
              <TouchableOpacity style={[s.pBtn, { backgroundColor: '#EF4444' }]} onPress={retake} activeOpacity={0.9}>
                <Ionicons name="refresh" size={18} color="#fff" />
                <Text style={s.pBtnTxt}>Retake</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.pBtn, { backgroundColor: '#16A34A' }]} onPress={confirm} activeOpacity={0.9}>
                <Ionicons name="checkmark" size={18} color="#fff" />
                <Text style={s.pBtnTxt}>Use Photo</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <>
            <CameraView ref={cameraRef} style={{ flex: 1 }} facing={facing} />
            <View style={s.controls}>
              <TouchableOpacity style={s.ctrlBtn} onPress={close} activeOpacity={0.8}>
                <Text style={s.ctrlTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.capBtn} onPress={takePicture} disabled={busy} activeOpacity={0.8}>
                <View style={[s.capInner, busy && { backgroundColor: '#999' }]} />
              </TouchableOpacity>
              <TouchableOpacity style={s.ctrlBtn} onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))} activeOpacity={0.8}>
                <Ionicons name="camera-reverse-outline" size={26} color="#fff" />
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  controls: {
    flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center',
    paddingVertical: 20, paddingBottom: 40, backgroundColor: '#000',
  },
  ctrlBtn: { paddingHorizontal: 16, paddingVertical: 10, minWidth: 70, alignItems: 'center' },
  ctrlTxt: { color: '#fff', fontSize: 16, fontWeight: '600' },
  capBtn: { width: 74, height: 74, borderRadius: 37, borderWidth: 4, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  capInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#fff' },
  previewWrap: { flex: 1, backgroundColor: '#000' },
  previewImg: { flex: 1, resizeMode: 'contain' },
  previewRow: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 20, paddingBottom: 40, backgroundColor: '#000' },
  pBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 30, paddingVertical: 14, borderRadius: 10 },
  pBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '700' },
  permWrap: { flex: 1, backgroundColor: '#0B1220', alignItems: 'center', justifyContent: 'center', padding: 28, gap: 16 },
  permTxt: { color: '#fff', fontSize: 15.5, textAlign: 'center', lineHeight: 22 },
  permBtn: { backgroundColor: COLORS.primary, paddingHorizontal: 26, paddingVertical: 13, borderRadius: 10 },
  permBtnTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },
  permCancel: { color: '#9CA3AF', fontSize: 15, fontWeight: '600' },
});
