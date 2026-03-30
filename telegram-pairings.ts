import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const pairingStorePath = join(process.cwd(), "data", "telegram-pairings.json");

type TelegramPairingStore = {
  heartbeatTargets: string[];
};

type TelegramMessageLike = {
  chat: { id: number };
  message_thread_id?: number;
};

export type TelegramTarget = {
  baseChatId: number;
  chatId: number;
  messageThreadId?: number;
};

export function formatTelegramTargetFromMessage(message: TelegramMessageLike) {
  if (typeof message.message_thread_id === "number") {
    return `${message.chat.id}:topic:${message.message_thread_id}`;
  }

  return String(message.chat.id);
}

export function parseTelegramTarget(raw: string): TelegramTarget {
  const [chatIdPart, threadMarker, threadIdPart] = raw.split(":");
  const baseChatId = Number.parseInt(chatIdPart, 10);

  if (!Number.isFinite(baseChatId)) {
    throw new Error(`Invalid Telegram chat id: ${raw}`);
  }

  const messageThreadId =
    threadMarker === "topic" && threadIdPart ? Number.parseInt(threadIdPart, 10) : undefined;

  if (threadMarker === "topic" && !Number.isFinite(messageThreadId)) {
    throw new Error(`Invalid Telegram topic target: ${raw}`);
  }

  return {
    baseChatId,
    chatId: baseChatId,
    messageThreadId,
  };
}

export async function addHeartbeatPairing(target: string) {
  const store = await loadPairingStore();
  if (!store.heartbeatTargets.includes(target)) {
    store.heartbeatTargets.push(target);
    await savePairingStore(store);
  }

  return store;
}

export async function removeHeartbeatPairing(target: string) {
  const store = await loadPairingStore();
  store.heartbeatTargets = store.heartbeatTargets.filter((entry) => entry !== target);
  await savePairingStore(store);
  return store;
}

export async function listHeartbeatPairings() {
  const store = await loadPairingStore();
  return store.heartbeatTargets;
}

export async function resolveHeartbeatTargets(initialChatIds: number[]) {
  const pairedTargets = await listHeartbeatPairings();
  const initialTargets = initialChatIds.map((chatId) => ({
    baseChatId: chatId,
    chatId,
    messageThreadId: undefined,
  }));
  const pairedTargetsParsed = pairedTargets.flatMap((target) => {
    try {
      return [parseTelegramTarget(target)];
    } catch {
      return [];
    }
  });
  const allTargets = [...initialTargets, ...pairedTargetsParsed];
  const seen = new Set<string>();

  return allTargets.filter((target) => {
    const key = `${target.chatId}:${target.messageThreadId ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function loadPairingStore(): Promise<TelegramPairingStore> {
  try {
    const raw = await readFile(pairingStorePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<TelegramPairingStore>;
    return {
      heartbeatTargets: Array.isArray(parsed.heartbeatTargets)
        ? parsed.heartbeatTargets.map((value) => String(value).trim()).filter(Boolean)
        : [],
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return { heartbeatTargets: [] };
    }
    throw error;
  }
}

async function savePairingStore(store: TelegramPairingStore) {
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(
    pairingStorePath,
    `${JSON.stringify({ heartbeatTargets: [...new Set(store.heartbeatTargets)].sort() }, null, 2)}\n`,
    "utf8",
  );
}
