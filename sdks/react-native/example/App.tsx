import {Plunk, PlunkProvider, type PickedFile} from '@plunk/react-native';
import * as ImagePicker from 'expo-image-picker';
import {StatusBar} from 'expo-status-bar';
import {useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

/* Point these at your own API and project. The token server stands in for your app's backend. */
const API_URL = process.env.EXPO_PUBLIC_PLUNK_API_URL ?? 'http://localhost:8082';
const PUBLIC_KEY = process.env.EXPO_PUBLIC_PLUNK_PUBLIC_KEY ?? 'pk_your_public_key';
const TOKEN_SERVER = process.env.EXPO_PUBLIC_TOKEN_SERVER ?? 'http://localhost:5602';

const USERS = {
  alice: {sub: 'example-alice', email: 'alice@example.com', name: 'Alice Example'},
  bob: {sub: 'example-bob', email: 'bob@example.com', name: 'Bob Example'},
};

async function fetchUserToken(user: keyof typeof USERS): Promise<string> {
  const response = await fetch(`${TOKEN_SERVER}/token`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(USERS[user]),
  });
  const {token} = (await response.json()) as {token: string};
  return token;
}

async function pickImage(): Promise<PickedFile | null> {
  const result = await ImagePicker.launchImageLibraryAsync({mediaTypes: ['images'], quality: 0.8});
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) {
    return null;
  }
  return {
    uri: asset.uri,
    name: asset.fileName ?? 'photo.jpg',
    type: asset.mimeType ?? 'image/jpeg',
    size: asset.fileSize,
  };
}

function Screen() {
  const [user, setUser] = useState<keyof typeof USERS | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => Plunk.addUnreadCountListener(setUnread), []);

  const login = async (next: keyof typeof USERS) => {
    setError(null);
    try {
      await Plunk.loginUser({getUserToken: () => fetchUserToken(next)});
      setUser(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const logout = async () => {
    await Plunk.logout();
    setUser(null);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Messenger example</Text>
      <Text testID="signed-in-as">{user ? `Signed in as ${USERS[user].name}` : 'Signed out'}</Text>
      <Text testID="unread-count">Unread conversations: {unread}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button label="Sign in as Alice" onPress={() => login('alice')} />
      <Button label="Sign in as Bob" onPress={() => login('bob')} />
      <Button label="Open messenger" onPress={() => Plunk.present()} />
      <Button label="Report a bug" onPress={() => Plunk.presentMessageComposer('I found a bug: ')} />
      <Button label="Log out" onPress={logout} />
      <StatusBar style="auto" />
    </View>
  );
}

function Button({label, onPress}: {label: string; onPress: () => void}) {
  return (
    <Pressable accessibilityRole="button" style={styles.button} onPress={onPress}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  return (
    <PlunkProvider apiUrl={API_URL} publicKey={PUBLIC_KEY} pickAttachment={pickImage}>
      <Screen />
    </PlunkProvider>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#fff', alignItems: 'stretch', justifyContent: 'center', padding: 24, gap: 12},
  title: {fontSize: 24, fontWeight: '700'},
  error: {color: '#b91c1c'},
  button: {backgroundColor: '#111827', borderRadius: 10, paddingVertical: 12, alignItems: 'center'},
  buttonText: {color: '#fff', fontWeight: '600'},
});
