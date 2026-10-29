/*
 * OrthoMate GonioBLE – eine API für alle Plattformen
 *
 *   iPhone / iPad  → native App-Hülle (Capacitor + @capacitor-community/bluetooth-le)
 *   Desktop / Android Chrome, Edge, Bluefy → Web Bluetooth
 *
 * Nutzung (WerkstattApp oder Gonio-Seite):
 *   GonioBLE.onAngles = ({X, Y, Z}) => { ... };
 *   GonioBLE.onStatus = (state, text) => { ... };   // 'idle' | 'search' | 'on' | 'err'
 *   await GonioBLE.connect();
 *   await GonioBLE.disconnect();
 *   GonioBLE.platform()  → 'native' | 'web' | 'none'
 */
(function (global) {
  'use strict';

  const SVC    = '0000ffe5-0000-1000-8000-00805f9a34fb';
  const NOTIFY = '0000ffe4-0000-1000-8000-00805f9a34fb';
  const NAME_PREFIX = 'WT';

  // ── Paket-Parser ───────────────────────────────────────────────────────────
  // BLE-5.0-Sensoren (WT9011DCL, WT901BLE…) senden standardmäßig 0x55 0x61:
  //   [55][61][AccX][AccY][AccZ][GyrX][GyrY][GyrZ][Roll][Pitch][Yaw]  = 20 Byte, int16 LE
  // Ältere/umkonfigurierte Geräte senden 0x55 0x53 (11 Byte, mit Checksumme).
  const buffer = [];
  let lastAcc = null;     // Rohbeschleunigung (Schwerkraftrichtung) aus 0x51-Paketen

  function feed(bytes) {
    for (let i = 0; i < bytes.length; i++) buffer.push(bytes[i]);
    let result = null;
    while (buffer.length >= 2) {
      if (buffer[0] !== 0x55) { buffer.shift(); continue; }
      const type = buffer[1];
      if (type === 0x61) {
        if (buffer.length < 20) break;
        const p = buffer.splice(0, 20);
        result = { X: i16(p, 14), Y: i16(p, 16), Z: i16(p, 18), acc: [raw(p, 2), raw(p, 4), raw(p, 6)] };
      } else if (type === 0x53) {
        if (buffer.length < 11) break;
        const p = buffer.slice(0, 11);
        let sum = 0; for (let k = 0; k < 10; k++) sum += p[k];
        if ((sum & 0xff) !== p[10]) { buffer.shift(); continue; }
        buffer.splice(0, 11);
        result = { X: i16(p, 2), Y: i16(p, 4), Z: i16(p, 6), acc: lastAcc };
      } else if (type >= 0x50 && type <= 0x5f) {
        if (buffer.length < 11) break;
        const p = buffer.splice(0, 11);
        if (type === 0x51) lastAcc = [raw(p, 2), raw(p, 4), raw(p, 6)];
      } else if (type === 0x71) {
        if (buffer.length < 20) break;
        buffer.splice(0, 20);           // Register-Antwort überspringen
      } else {
        buffer.shift();
      }
    }
    if (buffer.length > 200) buffer.length = 0;
    return result;
  }

  function raw(p, o) {
    let v = p[o] | (p[o + 1] << 8);
    return (v & 0x8000) ? v - 0x10000 : v;
  }
  function i16(p, o) {
    let v = p[o] | (p[o + 1] << 8);
    if (v & 0x8000) v -= 0x10000;
    return Math.round((v / 32768) * 180 * 10) / 10;
  }

  function toBytes(value) {
    if (value == null) return [];
    if (typeof value === 'string') {           // nativ: Hex-String "55 61 00 …" oder "556100…"
      const hex = value.replace(/[^0-9a-f]/gi, '');
      const out = [];
      for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
      return out;
    }
    if (value instanceof DataView) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    if (value.buffer) return Array.from(new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength));
    return Array.from(value);
  }

  // ── Plattform-Erkennung ────────────────────────────────────────────────────
  function nativePlugin() {
    const C = global.Capacitor;
    if (C && C.isNativePlatform && C.isNativePlatform() && C.Plugins && C.Plugins.BluetoothLe) return C.Plugins.BluetoothLe;
    return null;
  }
  function platform() {
    if (nativePlugin()) return 'native';
    if (global.navigator && global.navigator.bluetooth) return 'web';
    return 'none';
  }

  // ── Zustand ────────────────────────────────────────────────────────────────
  const api = {
    onAngles: null,
    onStatus: null,
    onLog: null,
    deviceName: null,
    connected: false,
    platform,
    parse: feed,          // für Tests
    connect,
    disconnect,
  };
  let nativeDeviceId = null;
  let nativeListeners = [];
  let webDevice = null;

  function status(state, text) { if (api.onStatus) api.onStatus(state, text); }
  function log(msg) { try { console.log('[GonioBLE]', msg); } catch (_) {} if (api.onLog) api.onLog(msg); }
  function emit(bytes) {
    const a = feed(toBytes(bytes));
    if (a && api.onAngles) api.onAngles(a);
  }
  function onLost() {
    api.connected = false;
    buffer.length = 0;
    status('err', 'Getrennt');
  }

  async function connect() {
    const p = platform();
    status('search', 'Suche…');
    try {
      if (p === 'native') await connectNative();
      else if (p === 'web') await connectWeb();
      else throw new Error(noBleHint());
      api.connected = true;
      status('on', api.deviceName || 'Verbunden');
    } catch (e) {
      api.connected = false;
      status('err', e && e.message ? e.message : String(e));
      throw e;
    }
  }

  // Native (iOS-App / Android-App)
  async function connectNative() {
    const BLE = nativePlugin();
    await BLE.initialize();
    const dev = await BLE.requestDevice({ namePrefix: NAME_PREFIX, optionalServices: [SVC] });
    nativeDeviceId = dev.deviceId;
    api.deviceName = dev.name || 'WitMotion';

    nativeListeners.push(await BLE.addListener('disconnected|' + nativeDeviceId, onLost));
    await BLE.connect({ deviceId: nativeDeviceId });

    const key = 'notification|' + nativeDeviceId + '|' + SVC + '|' + NOTIFY;
    nativeListeners.push(await BLE.addListener(key, (r) => emit(r && r.value)));
    await BLE.startNotifications({ deviceId: nativeDeviceId, service: SVC, characteristic: NOTIFY });
  }

  // Web Bluetooth
  const EXTRA_SVCS = [
    '0000ffe0-0000-1000-8000-00805f9a34fb',
    '0000fff0-0000-1000-8000-00805f9a34fb',
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  ];
  function withTimeout(promise, ms, what) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(what + ': Zeitüberschreitung (' + ms / 1000 + ' s)')), ms)),
    ]);
  }

  async function connectWeb() {
    log('Gerätewahl öffnen…');
    webDevice = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: NAME_PREFIX }],
      optionalServices: [SVC, ...EXTRA_SVCS],
    });
    log('Gewählt: ' + (webDevice.name || '?') + ' (' + webDevice.id + ')');
    webDevice.addEventListener('gattserverdisconnected', () => { log('Verbindung getrennt (gattserverdisconnected)'); onLost(); });

    let server = null;
    for (let attempt = 1; attempt <= 3 && !server; attempt++) {
      try {
        status('search', 'Verbinde… Versuch ' + attempt + '/3');
        log('GATT connect, Versuch ' + attempt);
        server = await withTimeout(webDevice.gatt.connect(), 10000, 'GATT connect');
        log('GATT verbunden');
      } catch (e) {
        log('Fehler: ' + e.message);
        try { webDevice.gatt.disconnect(); } catch (_) {}
        if (attempt === 3) throw e;
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    let ch = null;
    try {
      log('Service ' + SVC.slice(4, 8) + ' suchen…');
      const svc = await withTimeout(server.getPrimaryService(SVC), 8000, 'Service');
      ch = await withTimeout(svc.getCharacteristic(NOTIFY), 8000, 'Characteristic');
      log('Notify-Kanal ffe4 gefunden');
    } catch (e) {
      log('Standard-Service nicht gefunden (' + e.message + ') – suche alle Services…');
      const svcs = await withTimeout(server.getPrimaryServices(), 8000, 'Services');
      for (const s of svcs) {
        log('Service: ' + s.uuid);
        const chars = await s.getCharacteristics();
        for (const c of chars) {
          const p = c.properties;
          log('  Char: ' + c.uuid + (p.notify ? ' [notify]' : '') + (p.write || p.writeWithoutResponse ? ' [write]' : ''));
          if (!ch && p.notify) ch = c;
        }
      }
      if (!ch) throw new Error('Kein Notify-Kanal gefunden');
      log('Nutze ' + ch.uuid);
    }

    let first = true;
    ch.addEventListener('characteristicvaluechanged', (e) => {
      if (first) { first = false; log('Erste Daten: ' + toBytes(e.target.value).slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join(' ')); }
      emit(e.target.value);
    });
    log('Notifications starten…');
    await withTimeout(ch.startNotifications(), 8000, 'Notifications');
    log('Bereit – warte auf Daten');
    setTimeout(() => { if (first) log('Nach 3 s keine Daten vom Sensor. Sensor eingeschaltet? Nicht mit WitMotion-App verbunden?'); }, 3000);
    api.deviceName = webDevice.name || 'WitMotion';
  }

  async function disconnect() {
    try {
      const BLE = nativePlugin();
      if (BLE && nativeDeviceId) {
        for (const l of nativeListeners) { try { await l.remove(); } catch (_) {} }
        nativeListeners = [];
        await BLE.disconnect({ deviceId: nativeDeviceId });
        nativeDeviceId = null;
      }
      if (webDevice && webDevice.gatt.connected) webDevice.gatt.disconnect();
    } finally {
      api.connected = false;
      buffer.length = 0;
      status('idle', 'Nicht verbunden');
    }
  }

  function noBleHint() {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return ios
      ? 'Safari kann kein Bluetooth. Bitte die OrthoMate-App öffnen (oder vorübergehend Bluefy).'
      : 'Dieser Browser kann kein Bluetooth. Bitte Chrome oder Edge verwenden.';
  }
  api.noBleHint = noBleHint;

  global.GonioBLE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
