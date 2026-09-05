import { isLiveTL } from '../ts/chat-constants';

const noUpdateKeys = new Set(['hc.bytes.used', 'hc.bytes.update']);
const oneDay = 1000 * 60 * 60 * 24;

const storageget = (key: string): any => chrome.storage.local.get(key).then((r) => r[key]);
const defaultTo0 = (value: any): number => (Number.isNaN(value) ? 0 : value);

// MV2 has no `chrome.action`; `chrome.browserAction` is its equivalent.
const browserAction = __MV__ === 2 ? chrome.browserAction : chrome.action;

browserAction.onClicked.addListener(() => {
  if (isLiveTL) {
    chrome.tabs.create({ url: 'https://livetl.app' }, () => {});
  } else {
    chrome.tabs.create({ url: 'https://livetl.app/hyperchat' }, () => {});
  }
});

const lastLiveChatBodies = new Map<string, string>();

const liveChatFrameKey = (tabId: number, frameId: number): string => `${tabId}:${frameId}`;

const jsonBodyFromText = (text: string): string | null => {
  const trimmed = text.replace(/^\uFEFF/, '').replace(/^\)\]\}'\s*/, '');
  return trimmed.startsWith('{') ? trimmed : null;
};

const copyBytes = (bytes: unknown): Uint8Array | null => {
  if (bytes == null) return null;
  try {
    if (bytes instanceof Uint8Array) return bytes.slice();
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0));
    if (ArrayBuffer.isView(bytes)) {
      const view = bytes as ArrayBufferView;
      return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    }
  } catch {}
  try {
    const decoded = new TextDecoder().decode(bytes as BufferSource);
    if (decoded !== '') return new TextEncoder().encode(decoded);
  } catch {}
  try {
    return new Uint8Array(bytes as ArrayBuffer);
  } catch {
    return null;
  }
};

const decodeWebRequestBody = (
  requestBody: chrome.webRequest.WebRequestBody | null | undefined,
): string | null => {
  if (requestBody == null) return null;
  if (requestBody.formData != null) {
    for (const values of Object.values(requestBody.formData)) {
      for (const value of values) {
        if (typeof value === 'string') {
          const json = jsonBodyFromText(value);
          if (json != null) return json;
        }
      }
    }
  }
  if (requestBody.raw == null) return null;
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const part of requestBody.raw) {
    const bytes = copyBytes(part.bytes);
    if (bytes == null || bytes.byteLength === 0) continue;
    parts.push(bytes);
    total += bytes.byteLength;
  }
  if (total === 0) return null;
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return jsonBodyFromText(new TextDecoder().decode(combined));
  } catch {
    return null;
  }
};

const stripYoutubeXssi = (text: string): string => text.replace(/^\)\]\}'\s*/, '');

const decodeResponseText = async (bytes: Uint8Array): Promise<string | null> => {
  const direct = stripYoutubeXssi(new TextDecoder().decode(bytes));
  if (direct.startsWith('{')) return direct;
  const tryFormat = async (format: string): Promise<string | null> => {
    try {
      const Decompress = (globalThis as any).DecompressionStream;
      if (typeof Decompress !== 'function') return null;
      const blob = new Blob([bytes]);
      const stream = (blob as any).stream().pipeThrough(new Decompress(format));
      const out = new Uint8Array(await new Response(stream).arrayBuffer());
      const text = stripYoutubeXssi(new TextDecoder().decode(out));
      return text.startsWith('{') ? text : null;
    } catch {
      return null;
    }
  };
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return await tryFormat('gzip');
  }
  return (await tryFormat('gzip')) ?? (await tryFormat('deflate')) ?? (await tryFormat('deflate-raw'));
};

const rememberLiveChatBody = (tabId: number, frameId: number, body: string): void => {
  lastLiveChatBodies.set(liveChatFrameKey(tabId, frameId), body);
  lastLiveChatBodies.set(`${tabId}:*`, body);
  if (lastLiveChatBodies.size > 40) {
    const first = lastLiveChatBodies.keys().next().value;
    if (first != null) lastLiveChatBodies.delete(first);
  }
  try {
    void (chrome.storage as { session?: { set: (items: Record<string, string>) => Promise<void> } }).session?.set({
      [`hc.liveChatBody.${tabId}.${frameId}`]: body,
      [`hc.liveChatBody.${tabId}.*`]: body,
    });
  } catch {}
};

const attachResponseCapture = (
  details: chrome.webRequest.WebRequestBodyDetails,
  messageType: string,
): void => {
  const filterResponse = (chrome.webRequest as { filterResponseData?: (id: string) => any }).filterResponseData;
  if (filterResponse == null) return;
  try {
    const filter = filterResponse(details.requestId);
    const chunks: ArrayBuffer[] = [];
    filter.ondata = (event: { data: ArrayBuffer }) => {
      chunks.push(event.data);
      filter.write(event.data);
    };
    filter.onerror = () => {
      try {
        filter.disconnect();
      } catch {}
    };
    filter.onstop = () => {
      filter.close();
      const total = chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
      const combined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
      }
      void decodeResponseText(combined).then((text) => {
        if (text == null) return;
        chrome.tabs.sendMessage(
          details.tabId,
          { type: messageType, detail: text },
          { frameId: details.frameId },
          () => {
            void chrome.runtime.lastError;
          },
        );
      });
    };
  } catch {}
};

// Poll bodies are for Block/moderate only. Do not filter get_live_chat responses;
// that sits on YouTube's own replay poll stream and stops further chunks.
const onLiveChatPollRequest = (details: chrome.webRequest.WebRequestBodyDetails): void => {
  if (details.method !== 'POST' || details.tabId < 0) return;
  const body = decodeWebRequestBody(details.requestBody);
  if (body != null) {
    rememberLiveChatBody(details.tabId, details.frameId, body);
    chrome.tabs.sendMessage(
      details.tabId,
      { type: 'hcLiveChatBody', body },
      { frameId: details.frameId },
      () => {
        void chrome.runtime.lastError;
      },
    );
  }
};

const onContextMenuRequest = (details: chrome.webRequest.WebRequestBodyDetails): void => {
  if (details.method !== 'POST' || details.tabId < 0) return;
  if (!details.url.includes('/live_chat/get_item_context_menu')) return;
  attachResponseCapture(details, 'hcContextMenuResponse');
};

const liveChatPollFilter = {
  urls: [
    'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat*',
    'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay*',
    'https://studio.youtube.com/youtubei/v1/live_chat/get_live_chat*',
    'https://studio.youtube.com/youtubei/v1/live_chat/get_live_chat_replay*',
    'https://youtubei.googleapis.com/youtubei/v1/live_chat/get_live_chat*',
    'https://youtubei.googleapis.com/youtubei/v1/live_chat/get_live_chat_replay*',
  ],
};

const contextMenuFilter = {
  urls: [
    'https://www.youtube.com/youtubei/v1/live_chat/get_item_context_menu*',
    'https://studio.youtube.com/youtubei/v1/live_chat/get_item_context_menu*',
    'https://youtubei.googleapis.com/youtubei/v1/live_chat/get_item_context_menu*',
  ],
};

try {
  chrome.webRequest.onBeforeRequest.addListener(onLiveChatPollRequest, liveChatPollFilter, [
    'requestBody',
    'blocking',
  ]);
} catch {
  chrome.webRequest.onBeforeRequest.addListener(onLiveChatPollRequest, liveChatPollFilter, ['requestBody']);
}

try {
  chrome.webRequest.onBeforeRequest.addListener(onContextMenuRequest, contextMenuFilter, [
    'requestBody',
    'blocking',
  ]);
} catch {
  chrome.webRequest.onBeforeRequest.addListener(onContextMenuRequest, contextMenuFilter, ['requestBody']);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'getFrameInfo') {
    sendResponse({ tabId: sender.tab?.id, frameId: sender.frameId });
  } else if (request.type === 'hcGetLastLiveChatBody') {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId;
    const memory =
      tabId != null && frameId != null
        ? (lastLiveChatBodies.get(liveChatFrameKey(tabId, frameId)) ?? lastLiveChatBodies.get(`${tabId}:*`))
        : undefined;
    if (memory != null) {
      sendResponse({ body: memory });
      return;
    }
    if (tabId == null || frameId == null) {
      sendResponse({ body: null });
      return;
    }
    const session = (chrome.storage as { session?: { get: (keys: string[]) => Promise<Record<string, string>> } })
      .session;
    if (session == null) {
      sendResponse({ body: null });
      return;
    }
    const keys = [`hc.liveChatBody.${tabId}.${frameId}`, `hc.liveChatBody.${tabId}.*`];
    void session.get(keys).then((stored) => {
      sendResponse({ body: stored[keys[0]] ?? stored[keys[1]] ?? null });
    });
    return true;
  } else if (request.type === 'createPopup') {
    chrome.windows.create(
      {
        url: request.url,
        type: 'popup',
      },
      () => {},
    );
  }
});

chrome.runtime.onConnect.addListener((hc) => {
  const { frameId, tabId } = JSON.parse(hc.name) as { frameId: number; tabId: number };
  const interceptorPort = chrome.tabs.connect(tabId, { frameId });

  const onInterceptorMessage = (msg: any): void => {
    hc.postMessage(msg);
  };
  interceptorPort.onMessage.addListener(onInterceptorMessage);
  interceptorPort.onDisconnect.addListener(() => {
    interceptorPort.onMessage.removeListener(onInterceptorMessage);
    hc.disconnect();
  });

  const onHcMessage = (msg: any): void => {
    interceptorPort.postMessage(msg);
  };
  hc.onMessage.addListener(onHcMessage);
  hc.onDisconnect.addListener(() => {
    hc.onMessage.removeListener(onHcMessage);
    interceptorPort.disconnect();
  });
});

// see https://i.imgur.com/cGciqrX.png
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  let delta = 0;
  for (const key of Object.keys(changes)) {
    if (noUpdateKeys.has(key)) continue;
    const { oldValue, newValue } = changes[key];
    delta +=
      oldValue === undefined
        ? (key + JSON.stringify(newValue)).length
        : JSON.stringify(newValue).length - JSON.stringify(oldValue).length;
  }
  if (delta === 0) return;

  // avoid top-level async
  // see https://stackoverflow.com/a/53024910
  (async () => {
    const toWrite: Record<string, any> = {};
    const data = await Promise.all([storageget('hc.bytes.used'), storageget('hc.bytes.lastupdate')]);
    let bytesused = defaultTo0(data[0]);
    const lastupdate = defaultTo0(data[1]);
    const now = Date.now();

    // see https://i.imgur.com/S0i9oS4.png
    //     https://i.imgur.com/PpBepQ0.png
    if (now - lastupdate >= oneDay) {
      // see https://bugzilla.mozilla.org/show_bug.cgi?id=1385832#c20
      bytesused = new TextEncoder().encode(
        Object.entries(await chrome.storage.local.get())
          .map(([key, value]) => key + JSON.stringify(value))
          .join(''),
      ).length;
      toWrite['hc.bytes.lastupdate'] = now;
    }

    // storage transaction with 2 awaits -> potential data race???
    toWrite['hc.bytes.used'] = bytesused + delta;
    await chrome.storage.local.set(toWrite);
  })();
  return true;
});
