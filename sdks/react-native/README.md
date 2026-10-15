# @plunk/react-native

The messenger for React Native apps: the same conversations, office hours and agent replies as the
website widget, in a native sheet. It is plain JavaScript, so it installs into an Expo dev client or
Expo Go with no config plugin and no native rebuild.

## Install

The package is not published yet. Build a tarball and install it into your app:

```sh
cd sdks/react-native
npm install
npm run build && npm pack            # writes plunk-react-native-0.1.0.tgz
cd /path/to/your-app
npm install /path/to/plunk-react-native-0.1.0.tgz
```

Peer dependencies: `react` 18 or later and `react-native` 0.72 or later.

## Set up

Wrap the app once, near the root:

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import {PlunkProvider} from '@plunk/react-native';

export default function App() {
  return (
    <PlunkProvider apiUrl="https://api.example.com" publicKey="pk_..." storage={AsyncStorage} pickAttachment={pickFile}>
      <Root />
    </PlunkProvider>
  );
}
```

| Prop             | Required | What it does                                                                                                              |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `apiUrl`         | yes      | The messaging API.                                                                                                        |
| `publicKey`      | yes      | The project's public key, from Settings > Messenger.                                                                      |
| `storage`        | no       | Anything with `getItem`, `setItem` and `removeItem` (AsyncStorage, expo-secure-store). Keeps an anonymous visitor's id between launches. |
| `pickAttachment` | no       | Opens your picker and resolves with `{uri, name, type, size?}`, or `null` when cancelled. Without it, the attach button is hidden.      |
| `strings`        | no       | Overrides any of the English labels in `defaultStrings`.                                                                  |

A picker with `expo-image-picker`:

```ts
import * as ImagePicker from 'expo-image-picker';

async function pickFile() {
  const result = await ImagePicker.launchImageLibraryAsync({mediaTypes: ['images']});
  const asset = result.canceled ? null : result.assets[0];
  return asset
    ? {uri: asset.uri, name: asset.fileName ?? 'photo.jpg', type: asset.mimeType ?? 'image/jpeg', size: asset.fileSize}
    : null;
}
```

## Use

```ts
import {Plunk} from '@plunk/react-native';

await Plunk.loginUser({getUserToken: () => api.messengerToken()}); // after your own sign-in
Plunk.present(); // the messenger home: availability and the user's conversations
Plunk.presentMessageComposer('I found a bug: '); // a new conversation, prefilled
Plunk.presentConversation(conversationId); // e.g. from a notification tap
const unsubscribe = Plunk.addUnreadCountListener(count => setBadge(count));
await Plunk.logout(); // on your own sign-out
```

`Plunk.loginUnidentifiedUser()` starts an anonymous session. Opening the messenger before any login
does the same.

## Signed-in users

A signed-in user sees the same conversations on every device and on the website. The SDK proves who
the user is with a token that **your backend** signs with the identity secret from Settings >
Messenger. Never ship the secret in the app.

The token is an HS256 JWT with these claims:

| Claim   | Required | Notes                                                             |
| ------- | -------- | ----------------------------------------------------------------- |
| `sub`   | yes      | Your stable user id. It becomes the contact's external id.        |
| `exp`   | yes      | At most one hour from now.                                        |
| `email` | no       | Links the user to an existing contact with that email.            |
| `name`  | no       | Shown to agents.                                                  |

A Node backend:

```ts
import jwt from 'jsonwebtoken';

app.post('/messenger-token', requireUser, (req, res) => {
  const token = jwt.sign({sub: req.user.id, email: req.user.email, name: req.user.name}, process.env.MESSENGER_IDENTITY_SECRET, {
    algorithm: 'HS256',
    expiresIn: '1h',
  });
  res.json({token});
});
```

`getUserToken` is called on every sign-in and whenever the session expires, so it should fetch a
fresh token each time rather than return a cached one.

`logout` closes the connection, forgets the session and starts a new visitor id, so the next person
on the device sees none of the previous user's conversations.

## User attributes and events

What the app knows about the signed-in user goes onto their contact, where segments and workflows
can use it:

```ts
await Plunk.updateUser({is_premium: true, completed_modules_count: 4}); // null removes one
await Plunk.logEvent('finished_journey_module', {moduleId: 'm-4'});
await Plunk.logEvent('purchase_completed', {plan: 'yearly'}, {occurredAt: purchase.date});
```

- `updateUser` only sets the attributes declared in Settings > Messenger > App user attributes. An
  update with any other name is refused whole.
- Values are strings, numbers or booleans. Event data holds up to 25 of them and stays on the
  event: it is never copied onto the contact.
- Both need a signed-in user. For an anonymous user they record nothing, and nothing is kept for
  later, so one person's activity never lands on the next person who signs in on the device. A
  call made while `loginUser` is still in progress waits for it.
- Neither throws. Each resolves `true` once recorded, or `false` with a `[Plunk]` warning saying why.

The wiki's "Moving from Intercom" guide maps noworries' Intercom attributes and events.

## Push notifications

Agent replies are pushed to signed-in users through Expo's push service. Your app asks for
permission and gets the token; the SDK sends it for whoever is signed in and removes it on logout.
Anonymous users get no pushes.

```ts
import * as Notifications from 'expo-notifications';

const {granted} = await Notifications.requestPermissionsAsync();
if (granted) {
  const {data} = await Notifications.getExpoPushTokenAsync({projectId: EAS_PROJECT_ID});
  Plunk.registerPushToken(data); // before or after loginUser, either works
}

// A tap opens the conversation. Pass the notification's data; it returns false for other notifications.
Notifications.addNotificationResponseReceivedListener(response => {
  Plunk.handlePushNotification(response.notification.request.content.data);
});
// The tap that launched the app.
const launch = Notifications.getLastNotificationResponse();
if (launch) Plunk.handlePushNotification(launch.notification.request.content.data);
```

`handlePushNotification` can be called before `<PlunkProvider>` mounts or before `loginUser`
finishes: the conversation opens as soon as the user is signed in. If it isn't theirs, the
messenger opens on its home screen instead.

The notification's data is `{plunk: {conversationId}}`, its title is the project's name and its
body is the agent's name and the start of the reply. Internal notes are never pushed, and neither
are replies in a conversation that an anonymous visitor started. A device that uninstalls the app
is forgotten once Expo reports it. Each user keeps their 10 most recently registered devices.

The token must be an Expo push token (`ExponentPushToken[...]`), so the app needs an EAS project
with its APNs key and FCM credentials uploaded. Raw APNs or FCM device tokens are refused.

## Coming from Intercom

| Intercom                                                     | This SDK                                      |
| ------------------------------------------------------------ | --------------------------------------------- |
| `Intercom.initialize(appId, apiKey)` / config plugin         | `<PlunkProvider apiUrl publicKey>`            |
| `loginUserWithUserAttributes({userId, email})` + `setUserJwt` | `Plunk.loginUser({getUserToken})`            |
| `loginUnidentifiedUser()`                                    | `Plunk.loginUnidentifiedUser()`               |
| `logout()`                                                   | `Plunk.logout()`                              |
| `present()`                                                  | `Plunk.present()`                             |
| `presentMessageComposer(initialMessage)`                     | `Plunk.presentMessageComposer(initialMessage)` |
| `presentConversation(id)`                                    | `Plunk.presentConversation(id)`               |
| `getUnreadConversationCount()` / unread event listener       | `Plunk.getUnreadConversationCount()` / `Plunk.addUnreadCountListener` |
| `hideIntercom()`                                             | `Plunk.hide()`                                |
| `updateUser({customAttributes})`                             | `Plunk.updateUser(attributes)`: declared attributes only |
| `logEvent(name, metaData)`                                   | `Plunk.logEvent(name, data, {occurredAt})`    |
| `sendTokenToIntercom(deviceToken)`                           | `Plunk.registerPushToken(expoPushToken)`: an Expo token from `getExpoPushTokenAsync`, not the device token |
| Intercom's notification tap handling                         | `Plunk.handlePushNotification(data)`          |

## How it works

- Agent replies arrive over a server-sent event stream, read through `XMLHttpRequest` because React
  Native's `fetch` does not stream. The stream closes while the app is in the background and the
  conversation list refreshes when it returns.
- Uploads also go through `XMLHttpRequest`: Expo replaces the global `fetch` with one that refuses
  React Native's `{uri, name, type}` file parts.
- An open conversation polls every 15 seconds while the stream is down.

## Limits

- **The project needs at least one website origin.** The messenger refuses every boot while its
  allowed origins list is empty, and that includes apps, which send no origin.
- **Anonymous users can't start a conversation when the bot check is on.** The website widget runs
  Turnstile; the SDK can't, so it asks the user to sign in instead. Signed-in users are unaffected.
- **No email capture.** The SDK never asks an anonymous user for their email; sign users in instead.
- **English labels by default.** Pass `strings` to translate them.
- **Push needs a signed-in user.** Anonymous users only see replies the next time they open the
  messenger.

## Example app

`example/` is an Expo app with two test users and a token server standing in for your backend.

```sh
npm install && npm run pack:example          # builds the SDK into example/
cd example && npm install
PLUNK_IDENTITY_SECRET=... node token-server.mjs &
EXPO_PUBLIC_PLUNK_PUBLIC_KEY=pk_... npx expo start --ios
```

`EXPO_PUBLIC_PLUNK_API_URL` (default `http://localhost:8082`) and `EXPO_PUBLIC_TOKEN_SERVER`
(default `http://localhost:5602`) point it elsewhere. `notifications.ts` shows push wiring: set
`EXPO_PUBLIC_EAS_PROJECT_ID` on a real device, or `EXPO_PUBLIC_TEST_PUSH_TOKEN` to register a made-up
token on a simulator, which can't get a real one. "Finish a module" logs an event and sets
`completed_modules_count`, so declare that attribute first.

## Development

```sh
npm run typecheck
npx vitest run --project react-native-sdk    # from the repository root
```

`test/wire-types.ts` fails the type check when the API's types drift from the copies in
`src/types.ts`.
