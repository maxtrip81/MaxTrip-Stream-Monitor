// Personalizzazioni dei progetti nativi generati da Capacitor (idempotente: si può
// rieseguire dopo "npx cap add android|ios").
//  - Android: traffico HTTP verso il motore in rete locale, permesso notifiche (Android 13+)
//  - iOS: rete locale/HTTP, notifiche remote in background, inoltro del token APNs a Capacitor,
//         entitlement "aps-environment" per le notifiche push
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

function patch(file, fn) {
  if (!fs.existsSync(file)) return console.log('salto (non presente):', path.relative(root, file));
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  if (after !== before) { fs.writeFileSync(file, after); console.log('aggiornato:', path.relative(root, file)); }
}

// ---------- Android ----------
patch(path.join(root, 'android/app/src/main/AndroidManifest.xml'), s => {
  if (!s.includes('android:usesCleartextTraffic')) {
    s = s.replace('<application', '<application\n        android:usesCleartextTraffic="true"');
  }
  if (!s.includes('android.permission.POST_NOTIFICATIONS')) {
    s = s.replace('<uses-permission android:name="android.permission.INTERNET" />',
      '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />');
  }
  return s;
});

// ---------- iOS ----------
const plistKeys = `
\t<key>NSAppTransportSecurity</key>
\t<dict>
\t\t<key>NSAllowsArbitraryLoads</key>
\t\t<true/>
\t\t<key>NSAllowsLocalNetworking</key>
\t\t<true/>
\t</dict>
\t<key>NSLocalNetworkUsageDescription</key>
\t<string>Connessione al motore di monitoraggio dei flussi in rete locale / Connection to the stream monitoring engine on the local network</string>
\t<key>UIBackgroundModes</key>
\t<array>
\t\t<string>remote-notification</string>
\t</array>
`;
patch(path.join(root, 'ios/App/App/Info.plist'), s =>
  s.includes('NSAppTransportSecurity') ? s : s.replace(/\n<\/dict>\n<\/plist>\s*$/, `${plistKeys}</dict>\n</plist>\n`));

const delegateMethods = `
    // Notifiche push: inoltra a Capacitor il token APNs (o l'errore) ricevuto dal sistema
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
`;
patch(path.join(root, 'ios/App/App/AppDelegate.swift'), s =>
  s.includes('didRegisterForRemoteNotificationsWithDeviceToken') ? s : s.replace(/\n}\s*$/, `\n${delegateMethods}}\n`));

const entitlements = path.join(root, 'ios/App/App/App.entitlements');
if (fs.existsSync(path.dirname(entitlements)) && !fs.existsSync(entitlements)) {
  fs.writeFileSync(entitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>aps-environment</key>
\t<string>development</string>
</dict>
</plist>
`);
  console.log('creato: ios/App/App/App.entitlements');
}
patch(path.join(root, 'ios/App/App.xcodeproj/project.pbxproj'), s =>
  s.includes('CODE_SIGN_ENTITLEMENTS') ? s
    : s.replace(/(\t+)INFOPLIST_FILE = App\/Info\.plist;/g, '$1CODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n$1INFOPLIST_FILE = App/Info.plist;'));
