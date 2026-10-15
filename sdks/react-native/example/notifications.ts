import {Plunk} from '@plunk/react-native';
import * as Notifications from 'expo-notifications';
import {useEffect} from 'react';

/* Your EAS project id. Simulators can't get a real token, so a fabricated one can be given instead. */
const EAS_PROJECT_ID = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
const TEST_PUSH_TOKEN = process.env.EXPO_PUBLIC_TEST_PUSH_TOKEN;

Notifications.setNotificationHandler({
  handleNotification: async () => ({shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false}),
});

/** Your app owns the permission prompt; the SDK only needs the resulting token. */
export async function registerForPush(): Promise<void> {
  if (TEST_PUSH_TOKEN) {
    Plunk.registerPushToken(TEST_PUSH_TOKEN);
    return;
  }
  try {
    const {granted} = await Notifications.requestPermissionsAsync();
    if (!granted) {
      return;
    }
    const {data} = await Notifications.getExpoPushTokenAsync(EAS_PROJECT_ID ? {projectId: EAS_PROJECT_ID} : undefined);
    Plunk.registerPushToken(data);
  } catch (error) {
    console.warn('No push token on this device:', error);
  }
}

/** Opens the conversation of a tapped notification, including the one that launched the app. */
export function usePushTaps(): void {
  useEffect(() => {
    const last = Notifications.getLastNotificationResponse();
    if (last && Plunk.handlePushNotification(last.notification.request.content.data)) {
      Notifications.clearLastNotificationResponse();
    }
    const subscription = Notifications.addNotificationResponseReceivedListener(response => {
      Plunk.handlePushNotification(response.notification.request.content.data);
    });
    return () => subscription.remove();
  }, []);
}
