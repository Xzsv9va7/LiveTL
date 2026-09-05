import { fixLeaks } from '../ts/ytc-fix-memleaks';

if ((window as any).__hcInterceptorInstalled) {
  // Already installed by the document_start injector.
} else {
  (window as any).__hcInterceptorInstalled = true;
  installHyperchatInterceptor();
}

function installHyperchatInterceptor(): void {
const fetchFallback = window.fetch.bind(window);
(window as any).fetchFallback = fetchFallback;
let lastInnertubeContext: any = null;
let lastLiveChatBody: Record<string, any> | null = null;
let lastLiveChatClientHeaders: Record<string, string> = {};
let lastPlayerOffsetMs: string | null = null;
let viewChangeSeq = 0;
let viewChangeUntil = 0;
let appliedRefreshSeq = 0;
let pendingSeekToken: string | null = null;
let pendingSeekTokenSeq = 0;
let sawAlignedRequestSeq = 0;

const HC_LIVE_CHAT_BODY_EVENT = 'hcCapturedLiveChatBody';
const VIEW_CHANGE_ALIGN_MS = 2500;

const rememberPlayerOffsetMs = (value: unknown, allowRewind = false): void => {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  if (!Number.isFinite(n) || n < 0) return;
  if (!allowRewind && lastPlayerOffsetMs != null) {
    const prev = parseFloat(lastPlayerOffsetMs);
    // Poll bodies after a view switch often carry offset 0; that rewind
    // made HyperChat treat playback as a scrub and wipe the chat.
    if (Number.isFinite(prev) && n + 1000 < prev) return;
  }
  lastPlayerOffsetMs = String(Math.round(n));
};

const currentPlayerOffsetMs = (): string | null => {
  if (lastPlayerOffsetMs != null && lastPlayerOffsetMs !== '') return lastPlayerOffsetMs;
  return null;
};

const captureJsonBody = (bodyText: string, headers?: Record<string, string>): void => {
  if (headers != null) lastLiveChatClientHeaders = headers;
  try {
    if (bodyText === '') return;
    const parsed = JSON.parse(bodyText);
    if (parsed != null && typeof parsed === 'object') {
      lastLiveChatBody = parsed;
      (window as any).__hcLastLiveChatBodyJson = bodyText;
      if (parsed.context != null && typeof parsed.context === 'object') {
        lastInnertubeContext = parsed.context;
      }
    }
  } catch {}
};

window.addEventListener('message', (event) => {
  const progress = (event as MessageEvent).data?.['yt-player-video-progress'];
  if (progress != null) rememberPlayerOffsetMs(Number(progress) * 1000, true);
});

const hydrateCapturedLiveChatBody = (): void => {
  if (lastLiveChatBody != null) return;
  const raw = (window as any).__hcLastLiveChatBodyJson;
  if (typeof raw !== 'string' || raw === '') return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed != null && typeof parsed === 'object') {
      lastLiveChatBody = parsed;
      if (parsed.context != null && typeof parsed.context === 'object') {
        lastInnertubeContext = parsed.context;
      }
    }
  } catch {}
};

const installVisibilityBlock = (): void => {
  if ((window as any).__hcVisibilityBlocked) return;
  (window as any).__hcVisibilityBlocked = true;
  // visibilitychange must reach document: ytc-fix-memleaks rebinds the scheduler there.
  window.addEventListener(
    'blur',
    (event) => {
      event.stopImmediatePropagation();
    },
    true,
  );
};

let lastContextMenuJson: any = null;
let lastContextMenuMessageId: string | null = null;
let pendingContextMenuMessageId: string | null = null;

const storeContextMenuCapture = (detail: string, messageId: string): void => {
  try {
    lastContextMenuJson = JSON.parse(detail.replace(/^\)\]\}'\s*/, ''));
    lastContextMenuMessageId = messageId;
    (window as any).__hcLastContextMenuJson = detail;
    (window as any).__hcLastContextMenuMessageId = messageId;
  } catch {}
};

const contextMenuFor = (messageId: string): any | null => {
  if (messageId === '' || lastContextMenuMessageId !== messageId) return null;
  return lastContextMenuJson;
};

window.addEventListener(HC_LIVE_CHAT_BODY_EVENT, (event) => {
  const detail = (event as CustomEvent).detail;
  if (typeof detail === 'string') {
    captureJsonBody(detail);
    installVisibilityBlock();
  }
});
window.addEventListener('hcContextMenuResponse', (event) => {
  const detail = (event as CustomEvent).detail;
  if (typeof detail !== 'string' || detail === '') return;
  if (pendingContextMenuMessageId == null) return;
  storeContextMenuCapture(detail, pendingContextMenuMessageId);
});
hydrateCapturedLiveChatBody();
if (lastLiveChatBody != null) installVisibilityBlock();

const getCookie = (name: string): string => {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return (parts.pop() ?? '').split(';').shift() ?? '';
  return '';
};

const sha1Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const buildAuthorization = async (origin: string): Promise<string | null> => {
  const time = Math.floor(Date.now() / 1000);
  const sapisid = getCookie('__Secure-3PAPISID') || getCookie('SAPISID') || getCookie('__Secure-1PAPISID');
  if (!sapisid) return null;
  const hashOf = async (sid: string): Promise<string> => `${time}_${await sha1Hex(`${time} ${sid} ${origin}`)}_u`;
  const sapisid1 = getCookie('__Secure-1PAPISID') || sapisid;
  const sapisid3 = getCookie('__Secure-3PAPISID') || sapisid;
  return [
    `SAPISIDHASH ${await hashOf(sapisid)}`,
    `SAPISID1PHASH ${await hashOf(sapisid1)}`,
    `SAPISID3PHASH ${await hashOf(sapisid3)}`,
  ].join(' ');
};

const ytcfgGet = (key: string): any => {
  const ytcfg = (window as any).ytcfg;
  if (typeof ytcfg?.get === 'function') {
    try {
      return ytcfg.get(key);
    } catch {
      return undefined;
    }
  }
  return ytcfg?.data_?.[key];
};

const buildLiveInnertubeHeaders = async (incoming: Record<string, string>): Promise<Record<string, string>> => {
  const origin = location.origin;
  const headers: Record<string, string> = { ...incoming };
  const liveContext = lastInnertubeContext ?? ytcfgGet('INNERTUBE_CONTEXT');
  const sessionIndex = ytcfgGet('SESSION_INDEX') ?? lastLiveChatClientHeaders['x-goog-authuser'] ?? '0';
  const visitorId =
    ytcfgGet('VISITOR_DATA') ?? liveContext?.client?.visitorData ?? lastLiveChatClientHeaders['x-goog-visitor-id'];
  const clientName =
    lastLiveChatClientHeaders['x-youtube-client-name'] ??
    ytcfgGet('INNERTUBE_CONTEXT_CLIENT_NAME') ??
    liveContext?.client?.clientName ??
    1;
  const clientVersion =
    lastLiveChatClientHeaders['x-youtube-client-version'] ??
    ytcfgGet('INNERTUBE_CLIENT_VERSION') ??
    liveContext?.client?.clientVersion;
  const identityToken = ytcfgGet('ID_TOKEN') ?? lastLiveChatClientHeaders['x-youtube-identity-token'];
  const pageId = ytcfgGet('DELEGATED_SESSION_ID') ?? lastLiveChatClientHeaders['x-goog-pageid'];
  headers['Content-Type'] = 'application/json';
  headers.Accept = '*/*';
  headers['X-Goog-AuthUser'] = String(sessionIndex);
  headers['X-Youtube-Client-Name'] = String(clientName);
  headers['X-Youtube-Bootstrap-Logged-In'] = 'true';
  headers['X-Origin'] = origin;
  if (visitorId != null && visitorId !== '') headers['X-Goog-Visitor-Id'] = String(visitorId);
  if (clientVersion != null && clientVersion !== '') headers['X-Youtube-Client-Version'] = String(clientVersion);
  if (identityToken != null && identityToken !== '') headers['X-Youtube-Identity-Token'] = String(identityToken);
  if (pageId != null && pageId !== '') headers['X-Goog-PageId'] = String(pageId);
  const auth = lastLiveChatClientHeaders.authorization ?? (await buildAuthorization(origin));
  if (auth != null) headers.Authorization = auth;
  return headers;
};

const mergeInnertubeBody = (body: unknown, url: string): unknown => {
  hydrateCapturedLiveChatBody();
  let incoming: any = {};
  if (typeof body === 'string' && body !== '') {
    try {
      incoming = JSON.parse(body);
    } catch {
      return body;
    }
  }
  const isContextMenu = url.includes('/live_chat/get_item_context_menu');
  const isModerate = url.includes('/live_chat/moderate');
  if ((isContextMenu || isModerate) && lastLiveChatBody != null) {
    const { continuation: _continuation, params: _params, ...rest } = lastLiveChatBody;
    const merged: Record<string, any> = { ...rest };
    if (incoming.params != null) merged.params = incoming.params;
    const clickTracking = incoming.context?.clickTracking;
    if (merged.context != null && typeof merged.context === 'object') {
      merged.context = {
        ...merged.context,
        ...(clickTracking != null ? { clickTracking } : {}),
      };
    }
    return JSON.stringify(merged);
  }
  if (incoming?.context == null || typeof incoming.context !== 'object') return body;
  const liveContext = lastInnertubeContext ?? ytcfgGet('INNERTUBE_CONTEXT');
  if (liveContext == null || typeof liveContext !== 'object') return body;
  incoming.context = {
    ...liveContext,
    clickTracking: incoming.context.clickTracking ?? liveContext.clickTracking,
  };
  return JSON.stringify(incoming);
};

const sleep = async (ms: number): Promise<void> => await new Promise((resolve) => window.setTimeout(resolve, ms));

const nativeClick = (el: HTMLElement): void => {
  const inner = (el.matches('button, a, [role="button"]') ? el : el.querySelector('button, a, [role="button"]')) as
    | HTMLElement
    | null;
  (inner ?? el).click();
};

const collectElements = (root: Node | null, acc: Element[] = []): Element[] => {
  if (root == null) return acc;
  if (root instanceof Element) {
    acc.push(root);
    if (root.shadowRoot != null) collectElements(root.shadowRoot, acc);
  }
  const children = (root as Element).children ?? (root as Document | ShadowRoot).children;
  if (children != null) {
    for (const child of Array.from(children)) collectElements(child, acc);
  }
  return acc;
};

const elementIcon = (el: Element): string => {
  const data = (el as any).data ?? (el as any).__data;
  const fromData =
    data?.icon?.iconType ??
    data?.menuServiceItemRenderer?.icon?.iconType ??
    data?.menuNavigationItemRenderer?.icon?.iconType;
  if (typeof fromData === 'string') return fromData;
  const icon = el.querySelector('yt-icon');
  const type = (icon as any)?.icon_ ?? el.getAttribute('icon');
  return typeof type === 'string' ? type : '';
};

const elementLabel = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);

const isChatViewFilterLabel = (label: string): boolean =>
  /上位のチャット|チャットのリプレイ|top chat|live chat/i.test(label);

const findActionItem = (action: string): HTMLElement | null => {
  const pattern =
    action === 'BLOCK' ? /block|hide user|ブロック/i : /delete|retract|remove|削除/i;
  const icons = action === 'BLOCK' ? ['NOT_INTERESTED', 'BLOCK_USER'] : ['DELETE'];
  for (const el of collectElements(document.body)) {
    if (!(el instanceof HTMLElement)) continue;
    const label = elementLabel(el);
    if (isChatViewFilterLabel(label)) continue;
    if (icons.includes(elementIcon(el)) || pattern.test(label)) return el;
  }
  return null;
};

const menuItemLabel = (menu: any, view: any): string =>
  (
    Array.isArray(menu?.text?.runs)
      ? menu.text.runs
          .map((run: any) => run?.text)
          .filter(Boolean)
          .join('')
      : menu?.text?.simpleText ?? view?.title
  ) as string;

const findBlockCommand = (root: any): any | null => {
  const queue = [root];
  const visited = new Set<any>();
  const candidates: any[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    const view = current.menuItemViewModel;
    const menu = current.menuNavigationItemRenderer ?? current.menuServiceItemRenderer;
    const iconType =
      menu?.icon?.iconType ?? view?.leadingIcon?.iconType ?? view?.icon?.iconType ?? current.icon?.iconType;
    const label = menuItemLabel(menu, view);
    const endpoint =
      menu?.serviceEndpoint ??
      view?.onTap?.innertubeCommand ??
      view?.onTap ??
      current.serviceEndpoint ??
      current.innertubeCommand;
    const isBlock =
      iconType === 'NOT_INTERESTED' ||
      iconType === 'BLOCK_USER' ||
      /block|ブロック/i.test(String(label ?? ''));
    if (isBlock && endpoint != null) candidates.push(endpoint);
    for (const value of Object.values(current)) {
      if (value != null && typeof value === 'object') queue.push(value);
    }
  }
  return candidates[0] ?? null;
};

const applyCapturedMenuToPopup = (menuJson: any): void => {
  const menu =
    menuJson?.liveChatItemContextMenuSupportedRenderers?.menuRenderer ??
    menuJson?.response?.liveChatItemContextMenuSupportedRenderers?.menuRenderer;
  if (menu == null) return;
  for (const el of collectElements(document.body)) {
    if (!/menu-popup-renderer/i.test(el.tagName)) continue;
    try {
      (el as any).data = menu;
    } catch {}
    const dropdown = el.closest('tp-yt-iron-dropdown, iron-dropdown') as any;
    if (dropdown != null) {
      try {
        dropdown.opened = true;
      } catch {}
    }
  }
};

const commandHosts = (): any[] =>
  [
    document.querySelector('yt-live-chat-app'),
    document.querySelector('yt-live-chat-renderer'),
    document.querySelector('ytd-app'),
  ].filter((el) => el != null);

const dispatchYoutubeCommand = (command: any): string => {
  const tried: string[] = [];
  for (const host of commandHosts()) {
    const tag = String(host.tagName ?? 'el').toLowerCase();
    for (const name of ['handleCommand', 'handleCommand_']) {
      if (typeof host[name] !== 'function') continue;
      tried.push(`${tag}.${name}`);
      try {
        host[name](command);
        return `${tag}.${name}`;
      } catch (error) {
        tried.push(`${tag}.${name}!${String(error).slice(0, 40)}`);
      }
    }
    for (const handler of [host.commandHandler, host.ytcCommandHandler, host.commandHandler_]) {
      if (handler == null || typeof handler.handleCommand !== 'function') continue;
      tried.push(`${tag}.ch`);
      try {
        handler.handleCommand(command);
        return `${tag}.ch`;
      } catch (error) {
        tried.push(`${tag}.ch!${String(error).slice(0, 40)}`);
      }
    }
    try {
      host.dispatchEvent(
        new CustomEvent('yt-action', {
          bubbles: true,
          composed: true,
          detail: {
            actionName: 'yt-command-execution',
            args: [{ command }],
          },
        }),
      );
      tried.push(`${tag}.yt-action`);
    } catch {}
  }
  return tried.length > 0 ? `tried:${tried.join('|')}` : 'no-host';
};

const maskOfficialPopups = (): (() => void) => {
  const style = document.createElement('style');
  style.textContent =
    'yt-live-chat-app tp-yt-iron-dropdown,yt-live-chat-app iron-dropdown,' +
    'yt-confirm-dialog-renderer,tp-yt-paper-dialog{opacity:0!important}';
  document.documentElement.appendChild(style);
  return () => {
    style.remove();
  };
};

const clickConfirmIfPresent = async (): Promise<boolean> => {
  await sleep(300);
  const confirmBtn = document.querySelector('#confirm-button') as HTMLElement | null;
  if (confirmBtn == null) return false;
  nativeClick(confirmBtn);
  await sleep(200);
  return true;
};

const moderateParamsFromCommand = (command: any): string | null => {
  const queue = [command];
  const visited = new Set<any>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    if (typeof current.moderateLiveChatEndpoint?.params === 'string') {
      return current.moderateLiveChatEndpoint.params;
    }
    for (const value of Object.values(current)) {
      if (value != null && typeof value === 'object') queue.push(value);
    }
  }
  return null;
};

const postCapturedModerate = async (command: any): Promise<boolean> => {
  const params = moderateParamsFromCommand(command);
  if (typeof params !== 'string') return false;
  hydrateCapturedLiveChatBody();
  if (lastLiveChatBody?.serviceIntegrityDimensions?.poToken == null) return false;
  const url = `${location.origin}/youtubei/v1/live_chat/moderate?prettyPrint=false`;
  const headers = await buildLiveInnertubeHeaders({});
  const body = mergeInnertubeBody(JSON.stringify({ params, context: {} }), url);
  if (typeof body !== 'string') return false;
  const request = await fetchFallback(url, {
    method: 'POST',
    headers,
    body,
    credentials: 'include',
    mode: 'same-origin',
  });
  const text = await request.text();
  try {
    const json = JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
    return json?.error == null && json?.success !== false;
  } catch {
    return request.ok;
  }
};

const runCapturedBlockCommand = async (menuJson: any): Promise<string | null> => {
  const command = findBlockCommand(menuJson);
  if (command != null) {
    const ran = dispatchYoutubeCommand(command);
    if (ran.includes('handleCommand') || ran.includes('.ch')) {
      await clickConfirmIfPresent();
      return ran;
    }
    if (await postCapturedModerate(command)) return `moderate:${ran}`;
  }
  applyCapturedMenuToPopup(menuJson);
  await sleep(80);
  const item = findActionItem('BLOCK');
  if (item != null) {
    nativeClick(item);
    await clickConfirmIfPresent();
    return 'popup';
  }
  if (command != null && (await clickConfirmIfPresent())) return 'confirm';
  return command == null ? null : `fail:${dispatchYoutubeCommand(command)}`;
};

const openOfficialMessageMenu = (renderer: HTMLElement, menuButton: HTMLElement): void => {
  const fakeEvent = { stopPropagation(): void {}, preventDefault(): void {}, target: menuButton };
  const tap = (renderer as any).onMenuButtonTap_ ?? (renderer as any).onOverflowButtonTap_;
  if (typeof tap === 'function') {
    try {
      tap.call(renderer, fakeEvent);
    } catch {}
  }
  renderer.dispatchEvent(
    new CustomEvent('yt-live-chat-item-context-menu', {
      bubbles: true,
      composed: true,
      detail: {
        event: fakeEvent,
        data: (renderer as any).data ?? (renderer as any).__data,
        target: renderer,
        positionTarget: menuButton,
      },
    }),
  );
  menuButton.dispatchEvent(new CustomEvent('tap', { bubbles: true, composed: true }));
  nativeClick(menuButton);
};

const runOfficialChatAction = async (payload: { action: string; messageId: string }): Promise<void> => {
  pendingContextMenuMessageId = payload.messageId;
  lastContextMenuJson = null;
  lastContextMenuMessageId = null;
  (window as any).__hcLastContextMenuJson = '';
  (window as any).__hcLastContextMenuMessageId = '';
  const unmask = maskOfficialPopups();
  try {
    const renderer = document.getElementById(payload.messageId);
    if (renderer == null) throw new Error('Official chat message not found');
    renderer.scrollIntoView({ block: 'nearest' });
    renderer.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }));
    renderer.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window }));
    await sleep(50);
    const menu =
      (renderer.shadowRoot?.querySelector('#menu') as HTMLElement | null) ??
      (renderer.querySelector('#menu') as HTMLElement | null);
    if (menu != null) menu.style.display = 'inline-flex';
    const menuButton =
      ((renderer as any).$?.menuButton as HTMLElement | undefined) ??
      (renderer.shadowRoot?.querySelector('#menu-button') as HTMLElement | null) ??
      (renderer.querySelector('#menu-button') as HTMLElement | null);
    if (menuButton == null) throw new Error('Official chat menu button not found');
    openOfficialMessageMenu(renderer, menuButton);
    for (let i = 0; i < 40; i++) {
      const captured = contextMenuFor(payload.messageId);
      if (captured != null) {
        const how = await runCapturedBlockCommand(captured);
        if (how != null && !how.startsWith('fail:')) return;
        throw new Error('Official chat action item not found');
      }
      const blockItem = findActionItem(payload.action);
      if (blockItem != null) {
        nativeClick(blockItem);
        await clickConfirmIfPresent();
        return;
      }
      await sleep(100);
    }
    throw new Error('Official chat action item not found');
  } finally {
    pendingContextMenuMessageId = null;
    unmask();
  }
};

window.addEventListener('hcOfficialChatAction', (event) => {
  const payload = JSON.parse((event as CustomEvent).detail as string) as {
    id: string;
    action: string;
    messageId: string;
  };
  void runOfficialChatAction(payload)
    .then(() => {
      window.dispatchEvent(
        new CustomEvent('hcOfficialChatActionResult', {
          detail: JSON.stringify({ id: payload.id, ok: true }),
        }),
      );
    })
    .catch((error) => {
      window.dispatchEvent(
        new CustomEvent('hcOfficialChatActionResult', {
          detail: JSON.stringify({ id: payload.id, error: String(error) }),
        }),
      );
    });
});

// eslint-disable-next-line @typescript-eslint/no-misused-promises
window.addEventListener('proxyFetchRequest', async (event) => {
  const payload = JSON.parse((event as any).detail as string) as {
    id: string;
    args: [string, any];
  };
  try {
    const [url, options = {}] = payload.args;
    const headers = await buildLiveInnertubeHeaders({ ...(options.headers ?? {}) });
    const requestUrl =
      typeof url === 'string' ? url.replace(/^https?:\/\/[^/]+/i, location.origin) : url;
    const body = mergeInnertubeBody(options.body, String(requestUrl));
    const request = await fetchFallback(requestUrl, {
      ...options,
      headers,
      body,
      credentials: 'include',
      mode: 'same-origin',
    });
    const text = await request.text();
    let response: any;
    try {
      response = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${request.status} ${request.statusText}: ${text.slice(0, 180)}`);
    }
    if (!request.ok && response?.error == null) {
      response = { ...response, error: { code: request.status, message: request.statusText } };
    }
    window.dispatchEvent(
      new CustomEvent('proxyFetchResponse', {
        detail: JSON.stringify({
          id: payload.id,
          response,
        }),
      }),
    );
  } catch (error) {
    window.dispatchEvent(
      new CustomEvent('proxyFetchResponse', {
        detail: JSON.stringify({
          id: payload.id,
          error: String(error),
        }),
      }),
    );
  }
});

const isLiveChatReceiveUrl = (url: string): boolean =>
    url.includes('/youtubei/') && url.includes('/live_chat/get_live_chat');
  const isLiveChatSendUrl = (url: string): boolean =>
    url.includes('/youtubei/') && url.includes('/live_chat/send');
  const readFetchUrl = (args: Parameters<typeof fetch>): string => {
    const input = args[0] as any;
    if (typeof input === 'string') return input;
    if (input != null && typeof input.url === 'string') return input.url;
    return String(input);
  };
  const readFetchHeaders = (args: Parameters<typeof fetch>): Record<string, string> => {
    const headers: Record<string, string> = {};
    const assign = (name: string, value: string): void => {
      headers[name.toLowerCase()] = value;
    };
    if (args[0] instanceof Request) {
      args[0].headers.forEach((value, key) => assign(key, value));
    }
    const initHeaders = args[1]?.headers;
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => assign(key, value));
    } else if (Array.isArray(initHeaders)) {
      for (const [key, value] of initHeaders) assign(key, value);
    } else if (initHeaders != null && typeof initHeaders === 'object') {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (typeof value === 'string') assign(key, value);
      }
    }
    return headers;
  };
  const readSyncFetchBody = (args: Parameters<typeof fetch>): string => {
    const initBody = (args[1] as any)?.body;
    if (typeof initBody === 'string') return initBody;
    if (initBody instanceof Uint8Array) return new TextDecoder().decode(initBody);
    if (initBody instanceof ArrayBuffer) return new TextDecoder().decode(initBody);
    return '';
  };
  window.fetch = function (...args: Parameters<typeof fetch>): Promise<Response> {
    const url = readFetchUrl(args);
    const isReceiving = isLiveChatReceiveUrl(url);
    const isSending = isLiveChatSendUrl(url);
    const syncBody = isReceiving ? readSyncFetchBody(args) : '';
    if (isReceiving) {
      const headers = readFetchHeaders(args);
      if (syncBody.startsWith('{')) {
        captureJsonBody(syncBody, headers);
      } else {
        const input = args[0] as any;
        if (input != null && typeof input.clone === 'function') {
          try {
            void input.clone().text().then((text: string) => {
              if (typeof text === 'string' && text.startsWith('{')) captureJsonBody(text, headers);
            });
          } catch {}
        }
      }
    }
    const requestOffsetMs = isReceiving ? playerOffsetFromBodyText(syncBody) : null;
    const result = fetchFallback(...args);
    if (isReceiving || isSending) {
      void Promise.resolve(result).then(async (response) => {
        try {
          const detail = JSON.stringify(await response.clone().json());
          if (isReceiving) {
            considerForwardLiveChat(requestOffsetMs, detail);
            return;
          }
          window.dispatchEvent(new CustomEvent('messageSent', { detail }));
        } catch {}
      });
    }
    return result;
  };
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: [string, string | URL, ...any[]]) {
    (this as any).__hcUrl = String(args[1]);
    return xhrOpen.apply(this, args as unknown as Parameters<typeof xhrOpen>);
  };
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = String((this as any).__hcUrl ?? '');
    if (isLiveChatReceiveUrl(url) && typeof body === 'string') {
      captureJsonBody(body, (this as any).__hcHeaders);
    }
    const requestOffsetMs = isLiveChatReceiveUrl(url) && typeof body === 'string' ? playerOffsetFromBodyText(body) : null;
    if (isLiveChatReceiveUrl(url) || isLiveChatSendUrl(url)) {
      this.addEventListener('load', () => {
        try {
          const text = String(this.responseText ?? '').replace(/^\)\]\}'\s*/, '');
          if (!text.startsWith('{')) return;
          if (isLiveChatReceiveUrl(url)) {
            considerForwardLiveChat(requestOffsetMs, text);
            return;
          }
          window.dispatchEvent(new CustomEvent('messageSent', { detail: text }));
        } catch {}
      });
    }
    return xhrSend.call(this, body);
  };

const reloadContinuationToken = (value: unknown): string | null => {
  if (value == null || typeof value !== 'object' || value instanceof Node) return null;
  const record = value as Record<string, any>;
  if (typeof record.reloadContinuationData?.continuation === 'string') {
    return record.reloadContinuationData.continuation;
  }
  if (typeof record.continuation?.reloadContinuationData?.continuation === 'string') {
    return record.continuation.reloadContinuationData.continuation;
  }
  if (typeof record.continuations?.[0]?.reloadContinuationData?.continuation === 'string') {
    return record.continuations[0].reloadContinuationData.continuation;
  }
  const cmd = record.continuationCommand ?? record.continuation?.continuationCommand;
  if (typeof cmd?.token === 'string' && cmd.token !== '') {
    const request = String(cmd.request ?? '');
    if (request === '' || /LIVE_CHAT/i.test(request)) return cmd.token;
  }
  return null;
};

const subMenuItemsFromRenderer = (): any[] | null => {
  const renderer = document.querySelector('yt-live-chat-renderer') as any;
  const items =
    renderer?.data?.header?.liveChatHeaderRenderer?.viewSelector?.sortFilterSubMenuRenderer?.subMenuItems;
  return Array.isArray(items) ? items : null;
};

const itemsFromAncestors = (item: HTMLElement): any[] | null => {
  let current: any = item;
  for (let depth = 0; depth < 12 && current != null; depth++) {
    const items = current.items ?? current.data?.items;
    if (Array.isArray(items) && items.length > 0 && !(items[0] instanceof Node)) return items;
    const root = current.getRootNode?.();
    current = current.parentElement ?? (root != null && root !== document && root.host != null ? root.host : null);
  }
  return null;
};

const continuationFromViewIndex = (index: number): string | null => {
  const fromRenderer = subMenuItemsFromRenderer();
  if (fromRenderer != null && fromRenderer[index] != null) {
    const token = reloadContinuationToken(fromRenderer[index]);
    if (token != null) return token;
  }
  const listbox = document.querySelector('tp-yt-paper-listbox#menu');
  const item = listbox?.querySelectorAll('tp-yt-paper-item')[index] as HTMLElement | undefined;
  if (item == null) return null;
  const fromItem = reloadContinuationToken((item as any).data) ?? reloadContinuationToken((item as any).__data);
  if (fromItem != null) return fromItem;
  const ancestors = itemsFromAncestors(item);
  if (ancestors != null && ancestors[index] != null) {
    return reloadContinuationToken(ancestors[index]);
  }
  return null;
};

function playerOffsetFromBodyText(bodyText: string): string | null {
  if (!bodyText.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(bodyText);
    const raw = parsed?.currentPlayerState?.playerOffsetMs ?? parsed?.playerOffsetMs;
    if (raw == null || String(raw) === '') return null;
    return String(raw);
  } catch {
    return null;
  }
}

function isReplayChat(): boolean {
  return /live_chat_replay/i.test(location.pathname + location.href);
}

function isAlignedOffset(requestOffsetMs: string | null): boolean {
  if (requestOffsetMs == null) return false;
  const current = currentPlayerOffsetMs();
  if (current == null) return true;
  return Math.abs(Number(requestOffsetMs) - Number(current)) <= VIEW_CHANGE_ALIGN_MS;
}

function playerSeekToken(live: any): string | null {
  const continuations = live?.continuations;
  if (!Array.isArray(continuations)) return null;
  for (const continuation of continuations) {
    const token = continuation?.playerSeekContinuationData?.continuation;
    if (typeof token === 'string' && token !== '') return token;
  }
  return null;
}

function considerForwardLiveChat(requestOffsetMs: string | null, detail: string): void {
  const seq = viewChangeSeq;
  const waiting = seq > 0 && Date.now() < viewChangeUntil;
  if (requestOffsetMs != null && isAlignedOffset(requestOffsetMs)) {
    sawAlignedRequestSeq = seq;
  }
  if (!waiting) {
    window.dispatchEvent(new CustomEvent('messageReceive', { detail }));
    return;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(detail.replace(/^\)\]\}'\s*/, ''));
  } catch {
    return;
  }
  const live = parsed?.continuationContents?.liveChatContinuation ?? parsed?.contents?.liveChatRenderer;
  const seek = playerSeekToken(live);
  if (seek != null && pendingSeekTokenSeq !== seq) {
    pendingSeekToken = seek;
    pendingSeekTokenSeq = seq;
  }
  const aligned = !isReplayChat() || isAlignedOffset(requestOffsetMs);
  if (appliedRefreshSeq === seq) {
    if (live?.clientMessages != null) return;
    window.dispatchEvent(new CustomEvent('messageReceive', { detail }));
    return;
  }
  if (!aligned) return;
  if (live == null || !Array.isArray(live.actions) || live.actions.length < 1) return;
  if (live.clientMessages == null) live.clientMessages = {};
  appliedRefreshSeq = seq;
  viewChangeUntil = Date.now() + 500;
  window.dispatchEvent(new CustomEvent('messageReceive', { detail: JSON.stringify(parsed) }));
}

const postLiveChatContinuation = async (continuation: string, playerOffsetMs?: string): Promise<any | null> => {
  hydrateCapturedLiveChatBody();
  const context = lastLiveChatBody?.context ?? lastInnertubeContext ?? ytcfgGet('INNERTUBE_CONTEXT');
  if (context == null || typeof context !== 'object') return null;
  const replay = /live_chat_replay/i.test(location.pathname + location.href);
  const url = `${location.origin}/youtubei/v1/live_chat/${replay ? 'get_live_chat_replay' : 'get_live_chat'}?prettyPrint=false`;
  const headers = await buildLiveInnertubeHeaders({});
  const payload: Record<string, any> = { context, continuation };
  if (playerOffsetMs != null) {
    payload.currentPlayerState = { playerOffsetMs };
  }
  const body = mergeInnertubeBody(JSON.stringify(payload), url);
  if (typeof body !== 'string') return null;
  const request = await fetchFallback(url, {
    method: 'POST',
    headers,
    body,
    credentials: 'include',
    mode: 'same-origin',
  });
  const text = (await request.text()).replace(/^\)\]\}'\s*/, '');
  if (!text.startsWith('{')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const dispatchChatActions = (parsed: any, refresh = false): boolean => {
  const live = parsed?.continuationContents?.liveChatContinuation ?? parsed?.contents?.liveChatRenderer;
  if (live == null || !Array.isArray(live.actions) || live.actions.length < 1) return false;
  if (refresh && live.clientMessages == null) live.clientMessages = {};
  window.dispatchEvent(new CustomEvent('messageReceive', { detail: JSON.stringify(parsed) }));
  return true;
};

const pokePlayerProgress = (offsetMs: string): void => {
  const seconds = parseInt(offsetMs, 10) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return;
  window.postMessage({ 'yt-player-video-progress': seconds }, '*');
};

const waitForPlayerOffsetMs = async (): Promise<string | null> => {
  const existing = currentPlayerOffsetMs();
  if (existing != null) return existing;
  return await new Promise((resolve) => {
    const finish = (value: string | null): void => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(value);
    };
    const onMessage = (event: MessageEvent): void => {
      const progress = event.data?.['yt-player-video-progress'];
      if (progress == null) return;
      rememberPlayerOffsetMs(Number(progress) * 1000, true);
      finish(currentPlayerOffsetMs());
    };
    const timer = window.setTimeout(() => finish(currentPlayerOffsetMs()), 800);
    window.addEventListener('message', onMessage);
  });
};

const fetchChatViewContinuation = async (_index: number): Promise<void> => {
  viewChangeSeq += 1;
  const seq = viewChangeSeq;
  viewChangeUntil = Date.now() + 5000;
  pendingSeekToken = null;
  pendingSeekTokenSeq = 0;
  sawAlignedRequestSeq = 0;
  const offsetMs = await waitForPlayerOffsetMs();
  if (seq !== viewChangeSeq) return;
  if (offsetMs != null) pokePlayerProgress(offsetMs);
  window.setTimeout(() => {
    if (seq !== viewChangeSeq || appliedRefreshSeq === seq) return;
    if (sawAlignedRequestSeq === seq) {
      viewChangeUntil = Date.now() + 1500;
      return;
    }
    const token = pendingSeekTokenSeq === seq ? pendingSeekToken : null;
    const seekOffset = currentPlayerOffsetMs();
    if (token == null || seekOffset == null) {
      viewChangeUntil = 0;
      return;
    }
    void postLiveChatContinuation(token, seekOffset).then((seekParsed) => {
      if (seq !== viewChangeSeq || appliedRefreshSeq === seq) return;
      if (seekParsed != null && dispatchChatActions(seekParsed, true)) {
        appliedRefreshSeq = seq;
        viewChangeUntil = Date.now() + 500;
        return;
      }
      viewChangeUntil = 0;
    });
  }, 1000);
};

window.addEventListener('hcChatViewChange', (event) => {
  const index = parseInt(String((event as CustomEvent).detail), 10);
  if (Number.isNaN(index) || index < 0) return;
  void fetchChatViewContinuation(index);
});

fixLeaks();
}
