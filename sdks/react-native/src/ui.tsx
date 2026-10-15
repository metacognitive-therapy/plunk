import {CHAT_ATTACHMENT_MAX_BYTES, isInlineImage} from '@plunk/shared/attachments';
import {officeHoursStatus} from '@plunk/shared/office-hours';
import {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {MessengerApiError, type MessengerClient} from './client';
import type {MessengerController, MessengerState} from './controller';
import type {Strings} from './strings';
import type {Attachment, BootResponse, Conversation, ConversationSummary, Message} from './types';

const TYPING_SEND_INTERVAL_MS = 2500;
const TYPING_VISIBLE_MS = 4000;
const FALLBACK_POLL_MS = 15_000;

interface Theme {
  accent: string;
  onAccent: string;
}

export function useMessengerState(controller: MessengerController): MessengerState {
  return useSyncExternalStore(
    useCallback(listener => controller.subscribe(listener), [controller]),
    () => controller.getState(),
  );
}

export function Messenger({controller, strings}: {controller: MessengerController; strings: Strings}) {
  const state = useMessengerState(controller);
  const theme = useMemo(() => themeFor(state.boot?.appearance.accentColor), [state.boot?.appearance.accentColor]);
  const client = controller.getClient();
  const hide = () => controller.hide();
  const home = () => controller.navigate({screen: 'home'});
  /*
   * A page sheet starts below the top of the window, which KeyboardAvoidingView does not account for.
   * The sheet reaches the bottom of the window, so its top is whatever of the window it doesn't fill.
   */
  const [sheetTop, setSheetTop] = useState(0);

  return (
    <Modal
      visible={state.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={hide}
      testID="plunk-messenger"
    >
      <View
        style={styles.fill}
        onLayout={event => setSheetTop(Math.max(0, Dimensions.get('window').height - event.nativeEvent.layout.height))}
      >
        <KeyboardAvoidingView
          style={styles.root}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={sheetTop}
        >
          <Header
            title={state.boot?.project.name ?? ''}
            logoUrl={state.boot?.project.logoUrl ?? null}
            theme={theme}
            strings={strings}
            onBack={state.route.screen === 'thread' ? home : undefined}
            onClose={hide}
          />
          {state.status === 'ready' && state.boot && client ? (
            state.route.screen === 'home' ? (
              <Home
                boot={state.boot}
                clockSkew={state.clockSkew}
                conversations={state.conversations}
                strings={strings}
                theme={theme}
                onOpen={conversationId => controller.navigate({screen: 'thread', conversationId})}
              />
            ) : (
              <Thread
                key={state.route.conversationId ?? 'new'}
                controller={controller}
                client={client}
                conversationId={state.route.conversationId}
                initialDraft={state.route.draft}
                canStart={!(state.boot.turnstileSiteKey && state.session === 'anonymous')}
                connected={state.connected}
                strings={strings}
                theme={theme}
              />
            )
          ) : state.status === 'failed' ? (
            <View style={styles.center}>
              <Text style={styles.muted}>{strings.unavailable}</Text>
              <Pressable
                accessibilityRole="button"
                style={[styles.primary, {backgroundColor: theme.accent}]}
                onPress={() => controller.retry().catch(() => undefined)}
              >
                <Text style={[styles.primaryText, {color: theme.onAccent}]}>{strings.retry}</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.center}>
              <ActivityIndicator />
            </View>
          )}
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function Header({
  title,
  logoUrl,
  theme,
  strings,
  onBack,
  onClose,
}: {
  title: string;
  logoUrl: string | null;
  theme: Theme;
  strings: Strings;
  onBack?: () => void;
  onClose: () => void;
}) {
  return (
    <View style={[styles.header, {backgroundColor: theme.accent}]}>
      {onBack ? (
        <Pressable accessibilityRole="button" accessibilityLabel={strings.back} onPress={onBack} hitSlop={12}>
          <Text style={[styles.headerIcon, {color: theme.onAccent}]}>‹</Text>
        </Pressable>
      ) : null}
      {logoUrl ? <Image source={{uri: logoUrl}} style={styles.logo} /> : null}
      <Text style={[styles.headerTitle, {color: theme.onAccent}]} numberOfLines={1}>
        {title}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel={strings.close} onPress={onClose} hitSlop={12}>
        <Text style={[styles.headerIcon, {color: theme.onAccent}]}>×</Text>
      </Pressable>
    </View>
  );
}

function Home({
  boot,
  clockSkew,
  conversations,
  strings,
  theme,
  onOpen,
}: {
  boot: BootResponse;
  clockSkew: number;
  conversations: ConversationSummary[];
  strings: Strings;
  theme: Theme;
  onOpen: (conversationId: string | null) => void;
}) {
  const availability = availabilityText(boot, clockSkew, strings);
  return (
    <ScrollView contentContainerStyle={styles.home}>
      {boot.appearance.team.length > 0 ? (
        <View style={styles.team}>
          {boot.appearance.team.map(member => (
            <View key={member.id} style={[styles.avatar, {backgroundColor: theme.accent}]}>
              <Text style={[styles.avatarText, {color: theme.onAccent}]}>{initials(member.name)}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <Text style={styles.greeting}>{boot.appearance.greeting ?? strings.greeting}</Text>
      <Text style={styles.muted}>{strings.intro}</Text>
      {availability ? <Text style={styles.availability}>{availability}</Text> : null}
      <Text style={styles.muted}>{replyTimeText(boot, strings)}</Text>
      <Pressable
        accessibilityRole="button"
        style={[styles.primary, {backgroundColor: theme.accent}]}
        onPress={() => onOpen(null)}
      >
        <Text style={[styles.primaryText, {color: theme.onAccent}]}>{strings.newConversation}</Text>
      </Pressable>
      {conversations.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{strings.yourConversations}</Text>
          {conversations.map(conversation => (
            <Pressable
              key={conversation.id}
              accessibilityRole="button"
              style={styles.listItem}
              onPress={() => onOpen(conversation.id)}
            >
              <Text style={styles.listPreview} numberOfLines={1}>
                {conversation.lastMessage
                  ? `${conversation.lastMessage.authorType === 'CONTACT' ? `${strings.you}: ` : ''}${conversation.lastMessage.body}`
                  : ''}
              </Text>
              <Text style={styles.time}>{formatTime(conversation.lastMessageAt)}</Text>
              {conversation.unread ? (
                <View style={[styles.dot, {backgroundColor: theme.accent}]} accessibilityLabel="unread" />
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

function Thread({
  controller,
  client,
  conversationId,
  initialDraft,
  canStart,
  connected,
  strings,
  theme,
}: {
  controller: MessengerController;
  client: MessengerClient;
  conversationId: string | null;
  initialDraft?: string;
  canStart: boolean;
  connected: boolean;
  strings: Strings;
  theme: Theme;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState(initialDraft ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState<{name: string | null} | null>(null);
  const lastMarkedRead = useRef<string | null>(null);
  const lastTypingSent = useRef(0);
  const list = useRef<FlatList<Message>>(null);
  const pick = controller.config.pickAttachment;

  const refresh = useCallback(() => {
    if (!conversationId) {
      return;
    }
    client
      .getConversation(conversationId)
      .then(setConversation)
      .catch(() => undefined);
  }, [client, conversationId]);

  const append = useCallback((message: Message) => {
    setConversation(current =>
      current && !current.messages.some(existing => existing.id === message.id)
        ? {...current, messages: [...current.messages, message]}
        : current,
    );
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    if (!conversationId) {
      return;
    }
    let typingTimer: ReturnType<typeof setTimeout> | undefined;
    const off = controller.onStreamEvent(event => {
      if (event.type === 'ready') {
        refresh();
        return;
      }
      if (event.conversationId !== conversationId) {
        return;
      }
      if (event.type === 'message') {
        append(event.message);
        if (event.message.authorType !== 'CONTACT') {
          setTyping(null);
        }
      } else if (event.type === 'conversation') {
        setConversation(current => (current ? {...current, status: event.status} : current));
      } else if (event.type === 'typing') {
        setTyping({name: event.agentName});
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => setTyping(null), TYPING_VISIBLE_MS);
      }
    });
    return () => {
      off();
      clearTimeout(typingTimer);
    };
  }, [controller, conversationId, refresh, append]);

  useEffect(() => {
    if (!conversationId || connected) {
      return;
    }
    const timer = setInterval(refresh, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [conversationId, connected, refresh]);

  useEffect(() => {
    const last = conversation?.messages[conversation.messages.length - 1];
    if (!conversationId || !last || last.authorType === 'CONTACT' || lastMarkedRead.current === last.id) {
      return;
    }
    lastMarkedRead.current = last.id;
    void controller.markRead(conversationId);
  }, [controller, conversation, conversationId]);

  const onDraft = (value: string) => {
    setDraft(value);
    const now = Date.now();
    if (conversationId && value.trim() && now - lastTypingSent.current > TYPING_SEND_INTERVAL_MS) {
      lastTypingSent.current = now;
      void client.typing(conversationId).catch(() => undefined);
    }
  };

  const submit = async () => {
    const body = draft.trim();
    if (!body || sending) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      if (conversationId) {
        append(await client.sendMessage(conversationId, body));
        setConversation(current => (current ? {...current, status: 'OPEN'} : current));
      } else {
        const started = await client.startConversation(body);
        const last = started.messages[started.messages.length - 1];
        controller.upsertConversation({
          id: started.id,
          status: started.status,
          lastMessageAt: last?.createdAt ?? new Date().toISOString(),
          lastMessage: last ? {body: last.body, authorType: last.authorType} : null,
          unread: false,
        });
        controller.navigate({screen: 'thread', conversationId: started.id});
      }
      setDraft('');
    } catch (caught) {
      setError(caught instanceof MessengerApiError && caught.status === 429 ? strings.tooFast : strings.failed);
    } finally {
      setSending(false);
    }
  };

  const attach = async () => {
    if (!pick || !conversationId || sending) {
      return;
    }
    const file = await pick().catch(() => null);
    if (!file) {
      return;
    }
    if (file.size !== undefined && file.size > CHAT_ATTACHMENT_MAX_BYTES) {
      setError(strings.attachmentTooLarge);
      return;
    }
    setSending(true);
    setError(null);
    try {
      append(await client.sendAttachment(conversationId, file, draft.trim()));
      setConversation(current => (current ? {...current, status: 'OPEN'} : current));
      setDraft('');
    } catch (caught) {
      setError(caught instanceof MessengerApiError && caught.status < 500 ? caught.message : strings.failed);
    } finally {
      setSending(false);
    }
  };

  const messages = conversation?.messages ?? [];
  return (
    <View style={styles.thread}>
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={message => message.id}
        contentContainerStyle={styles.messages}
        onContentSizeChange={() => list.current?.scrollToEnd({animated: false})}
        renderItem={({item}) => (
          <MessageView
            message={item}
            client={client}
            conversationId={conversationId!}
            strings={strings}
            theme={theme}
          />
        )}
        ListFooterComponent={
          <View>
            {typing ? (
              <View style={styles.theirs}>
                <Text style={styles.author}>{typing.name ?? strings.team}</Text>
                <View style={[styles.bubble, styles.theirBubble]}>
                  <Text style={styles.muted}>{strings.typing}</Text>
                </View>
              </View>
            ) : null}
            {conversation?.status === 'CLOSED' ? <Text style={styles.notice}>{strings.closed}</Text> : null}
          </View>
        }
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!conversationId && !canStart ? (
        <Text style={styles.notice}>{strings.signInToChat}</Text>
      ) : (
        <View style={styles.composer}>
          {pick && conversationId ? (
            <Pressable accessibilityRole="button" accessibilityLabel={strings.attach} onPress={attach} hitSlop={8}>
              <Text style={styles.attach}>＋</Text>
            </Pressable>
          ) : null}
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={onDraft}
            placeholder={strings.placeholder}
            multiline
            maxLength={5000}
            testID="plunk-composer"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={strings.send}
            disabled={sending || !draft.trim()}
            onPress={submit}
            style={[styles.send, {backgroundColor: theme.accent, opacity: sending || !draft.trim() ? 0.5 : 1}]}
          >
            <Text style={{color: theme.onAccent, fontWeight: '600'}}>{strings.send}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function MessageView({
  message,
  client,
  conversationId,
  strings,
  theme,
}: {
  message: Message;
  client: MessengerClient;
  conversationId: string;
  strings: Strings;
  theme: Theme;
}) {
  const mine = message.authorType === 'CONTACT';
  return (
    <View style={mine ? styles.mine : styles.theirs}>
      {!mine ? <Text style={styles.author}>{message.agent?.name ?? strings.team}</Text> : null}
      {message.body ? (
        <View style={[styles.bubble, mine ? {backgroundColor: theme.accent} : styles.theirBubble]}>
          <Text style={{color: mine ? theme.onAccent : '#111827'}}>{message.body}</Text>
        </View>
      ) : null}
      {message.attachments.map(attachment => (
        <AttachmentView
          key={attachment.id}
          attachment={attachment}
          client={client}
          conversationId={conversationId}
          strings={strings}
        />
      ))}
      <Text style={styles.time}>{formatTime(message.createdAt)}</Text>
    </View>
  );
}

/* Links expire after a few minutes, so an image asks for one when it mounts and a file when tapped. */
function AttachmentView({
  attachment,
  client,
  conversationId,
  strings,
}: {
  attachment: Attachment;
  client: MessengerClient;
  conversationId: string;
  strings: Strings;
}) {
  const inline = isInlineImage(attachment.contentType);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!inline) {
      return;
    }
    client
      .attachmentLink(conversationId, attachment.id)
      .then(link => setUrl(link.url))
      .catch(() => setFailed(true));
  }, [inline, client, conversationId, attachment.id]);

  const open = async () => {
    try {
      const link = await client.attachmentLink(conversationId, attachment.id);
      await Linking.openURL(link.url);
    } catch {
      setFailed(true);
    }
  };

  if (failed) {
    return <Text style={styles.error}>{strings.attachmentFailed}</Text>;
  }
  if (inline) {
    return url ? (
      <Pressable onPress={open} accessibilityRole="imagebutton" accessibilityLabel={attachment.filename}>
        <Image source={{uri: url}} style={styles.image} resizeMode="cover" />
      </Pressable>
    ) : (
      <View style={[styles.image, styles.center]}>
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <Pressable onPress={open} accessibilityRole="link" style={styles.file}>
      <Text numberOfLines={1}>📎 {attachment.filename}</Text>
    </Pressable>
  );
}

function themeFor(accent: string | undefined): Theme {
  const color = accent && /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#111827';
  const channel = (offset: number) => {
    const value = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return {accent: color, onAccent: luminance > 0.4 ? '#111827' : '#ffffff'};
}

function replyTimeText(boot: BootResponse, strings: Strings): string {
  switch (boot.availability.replyTime) {
    case 'FEW_MINUTES':
      return strings.replyFewMinutes;
    case 'ONE_DAY':
      return strings.replyOneDay;
    default:
      return strings.replyFewHours;
  }
}

function availabilityText(boot: BootResponse, clockSkew: number, strings: Strings): string | null {
  const hours = boot.availability.officeHours;
  if (!hours) {
    return null;
  }
  const now = new Date(Date.now() + clockSkew);
  const {online, nextOpenAt} = officeHoursStatus(hours.days, hours.timezone, now);
  if (online) {
    return strings.online;
  }
  if (!nextOpenAt) {
    return strings.away;
  }
  const minutes = Math.ceil((nextOpenAt.getTime() - now.getTime()) / 60_000);
  if (minutes < 60) {
    return strings.backInMinutes.replace('{minutes}', String(Math.max(1, minutes)));
  }
  const language = boot.project.language;
  const time = nextOpenAt.toLocaleTimeString(language, {hour: '2-digit', minute: '2-digit'});
  const days = Math.round((startOfDay(nextOpenAt) - startOfDay(now)) / 86_400_000);
  if (days === 0) {
    return strings.backToday.replace('{time}', time);
  }
  if (days === 1) {
    return strings.backTomorrow.replace('{time}', time);
  }
  const day = nextOpenAt.toLocaleDateString(language, {weekday: 'long'});
  return strings.backOn.replace('{day}', day).replace('{time}', time);
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
    : date.toLocaleDateString([], {month: 'short', day: 'numeric'});
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#f6f6f7'},
  fill: {flex: 1},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24},
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14},
  headerTitle: {flex: 1, fontSize: 17, fontWeight: '600'},
  headerIcon: {fontSize: 28, lineHeight: 30, fontWeight: '300'},
  logo: {width: 28, height: 28, borderRadius: 6},
  home: {padding: 20, gap: 8},
  team: {flexDirection: 'row', gap: 6, marginBottom: 8},
  avatar: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  avatarText: {fontWeight: '600'},
  greeting: {fontSize: 26, fontWeight: '700', color: '#111827'},
  muted: {color: '#6b7280'},
  availability: {color: '#111827', marginTop: 8},
  primary: {marginTop: 16, borderRadius: 12, paddingVertical: 14, alignItems: 'center', alignSelf: 'stretch'},
  primaryText: {fontWeight: '600', fontSize: 16},
  card: {marginTop: 20, backgroundColor: '#fff', borderRadius: 12, paddingVertical: 8},
  cardTitle: {fontWeight: '600', paddingHorizontal: 16, paddingVertical: 8, color: '#111827'},
  listItem: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 12},
  listPreview: {flex: 1, color: '#111827'},
  dot: {width: 8, height: 8, borderRadius: 4},
  thread: {flex: 1},
  messages: {padding: 16, gap: 10},
  mine: {alignItems: 'flex-end', gap: 4},
  theirs: {alignItems: 'flex-start', gap: 4},
  author: {fontSize: 12, color: '#6b7280'},
  bubble: {maxWidth: '80%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9},
  theirBubble: {backgroundColor: '#fff'},
  time: {fontSize: 11, color: '#9ca3af'},
  notice: {textAlign: 'center', color: '#6b7280', padding: 16},
  error: {color: '#b91c1c', paddingHorizontal: 16, paddingVertical: 4},
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 12,
    paddingBottom: Platform.OS === 'ios' ? 28 : 12,
    backgroundColor: '#fff',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e5e7eb',
  },
  attach: {fontSize: 24, color: '#6b7280', paddingBottom: 6},
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#d1d5db',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 16,
  },
  send: {borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10},
  image: {width: 200, height: 150, borderRadius: 12, backgroundColor: '#e5e7eb'},
  file: {backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, maxWidth: '80%'},
});
